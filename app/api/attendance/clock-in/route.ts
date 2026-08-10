import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { isWithinGeofence } from '@/lib/geo';
import { hasWorkModeColumns, hasSessionColumns } from '@/lib/employeeDetails';
import {
  getWorkDateIST,
  isLate,
  getClientIp,
  toMySQLDatetime,
} from '@/lib/attendance';
import { formatInTimeZone } from 'date-fns-tz';
import { TIMEZONE } from '@/lib/constants';
import { shiftForClockIn, type DayShift } from '@/lib/shifts';
import { assessLocation } from '@/lib/locationTrust';
import { checkDevice } from '@/lib/deviceBinding';
import type {
  ApiResponse,
  AttendanceRecord,
  GeofenceStatus,
  AttendanceStatus,
} from '@/lib/types';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ClockInSchema = z.object({
  latitude: z.number({ error: 'latitude must be a number' }),
  longitude: z.number({ error: 'longitude must be a number' }),
  // True when the phone's geofence auto-attendance performed this action
  // (re-entering the work site) rather than the employee tapping the button.
  auto: z.boolean().optional(),
  // Android tells us when a fix came from a mock-location app — see
  // lib/locationTrust.ts. Absent on older builds, which are simply not checked.
  is_mocked: z.boolean().optional(),
  accuracy_m: z.number().nullable().optional(),
});

// Clock-in is allowed within at least this distance of the work location, even
// if the location's configured radius is smaller — GPS accuracy near buildings
// makes tighter fences reject people standing at the gate.
const MIN_LOGIN_RADIUS_M = 200;

// ---------------------------------------------------------------------------
// Shape returned from the schedule JOIN query
// ---------------------------------------------------------------------------

interface ActiveSchedule {
  schedule_id: number;
  shift_id: number;
  location_id: number | null;
  geofencing_enabled: boolean;
  start_time: string | null;
  end_time: string | null;
  required_hours: number | string | null;
  grace_minutes: number;
  shift_type: string;
  shift_name: string;
  loc_lat: number | null;
  loc_lng: number | null;
  loc_radius: number | null;
  loc_name: string | null;
}

/**
 * Which of today's shifts this arrival belongs to.
 *
 * Only matters for an employee rostered on two shifts: shiftForClockIn() takes
 * the shift whose window contains the arrival, else the nearest start, so the
 * lateness check and the geofence both come from the right shift. With one
 * shift this returns that shift, exactly as the old LIMIT 1 did.
 */
function pickScheduleForArrival(
  schedules: ActiveSchedule[],
  arrivalHHMM: string,
): ActiveSchedule | null {
  if (schedules.length <= 1) return schedules[0] ?? null;
  const chosen = shiftForClockIn(
    schedules.map(s => ({
      shift_id: s.shift_id,
      start_time: s.start_time,
      end_time: s.end_time,
      required_hours: s.required_hours,
    })) as unknown as DayShift[],
    arrivalHHMM,
  );
  return schedules.find(s => s.shift_id === chosen?.shift_id) ?? schedules[0];
}

// ---------------------------------------------------------------------------
// POST /api/attendance/clock-in
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  if (auth.role === 'employee') {
    const ua = request.headers.get('user-agent')?.toLowerCase() ?? '';
    const mobileHint = request.headers.get('sec-ch-ua-mobile');
    const isMobile = mobileHint === '?1' || /android|iphone|ipad|ipod|mobile|windows phone/.test(ua);
    if (!isMobile) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'Attendance marking is mobile-only for employees' },
        { status: 403 },
      );
    }
  }

  // 1. Parse + validate body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const parsed = ClockInSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Validation error' },
      { status: 400 },
    );
  }

  const { latitude: lat, longitude: lng } = parsed.data;
  const workDate = getWorkDateIST();
  const ip = getClientIp(request);

  // Is this the phone registered to the employee? The mobile-only check above
  // reads a header the client chooses, so on its own it stops nothing.
  const device = await checkDevice(auth.id, request, { action: 'clock_in', ip });
  if (!device.ok) {
    return NextResponse.json<ApiResponse>({ success: false, error: device.error }, { status: 403 });
  }

  // Are these coordinates believable? A fence over self-reported coordinates is
  // only as good as this check. Refusals are written to the audit log either
  // way, so a repeated attempt is visible even though each one is blocked.
  const trust = await assessLocation(
    auth.id,
    { latitude: lat, longitude: lng, is_mocked: parsed.data.is_mocked, accuracy_m: parsed.data.accuracy_m },
    { action: 'clock_in', ip, auto: parsed.data.auto === true },
  );
  if (!trust.ok) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: trust.message ?? 'Location could not be verified' },
      { status: 403 },
    );
  }

  // 2. Prevent duplicate clock-in — based on whether the employee currently has
  //    an OPEN session (clocked in, not yet clocked out), NOT on today's date.
  //    This is robust to server clock/timezone skew: if the clock drifts, the
  //    work_date written earlier may differ from "today", but the open session
  //    is still detected here and matched by clock-out.
  const openSession = await queryOne<{ id: number }>(
    `SELECT id FROM attendance
     WHERE employee_id = ? AND clock_in_utc IS NOT NULL AND clock_out_utc IS NULL
     LIMIT 1`,
    [auth.id],
  );
  if (openSession) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Already clocked in' },
      { status: 409 },
    );
  }

  const [workModeCols, sessionCols] = await Promise.all([
    hasWorkModeColumns(),
    hasSessionColumns(),
  ]);
  const flags = workModeCols
    ? await queryOne<{ work_mode: string; allow_multiple_sessions: number | boolean }>(
        'SELECT work_mode, allow_multiple_sessions FROM employees WHERE id = ?',
        [auth.id],
      )
    : null;
  const workMode = flags?.work_mode ?? 'on_site';
  const allowMultipleSessions = !!(flags?.allow_multiple_sessions ?? false);

  // A row may already exist for today's date (a previously completed session, or
  // an 'absent'/leave placeholder). We convert it in place rather than inserting
  // a duplicate, which would violate the unique (employee_id, work_date) key.
  const existing = await queryOne<{
    id: number;
    clock_in_utc: Date | null;
    clock_out_utc: Date | null;
    total_minutes: number | null;
    status: string;
  }>(
    `SELECT id, clock_in_utc, clock_out_utc, total_minutes, status
     FROM attendance WHERE employee_id = ? AND work_date = ?`,
    [auth.id, workDate],
  );

  // A COMPLETED session already exists today. Multi-session employees (plant
  // staff) open a fresh session with the earlier minutes banked; everyone else
  // is done for the day — previously this silently ERASED the first session.
  // The bypass also requires the banking columns: in a half-migrated database
  // (employees ALTER ran, attendance ALTER did not) re-opening would silently
  // destroy the completed session, so refuse instead.
  const completedToday = !!(existing?.clock_in_utc && existing?.clock_out_utc);
  if (completedToday && !(allowMultipleSessions && sessionCols)) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Attendance already completed for today' },
      { status: 409 },
    );
  }
  const bankedMinutes = completedToday ? Number(existing?.total_minutes ?? 0) : 0;

  // 3. Fetch the schedules in force today (shift + location details via JOIN).
  //    A double-shift employee holds more than one, so take them all and pick
  //    the one this arrival belongs to — judging a 18:00 arrival against the
  //    06:00 morning start would mark every evening clock-in late.
  const daySchedules = await query<ActiveSchedule>(
    `SELECT
       es.id           AS schedule_id,
       es.shift_id,
       es.location_id,
       es.geofencing_enabled,
       s.start_time,
       s.end_time,
       s.required_hours,
       s.grace_minutes,
       s.type          AS shift_type,
       s.name          AS shift_name,
       l.latitude      AS loc_lat,
       l.longitude     AS loc_lng,
       l.radius_meters AS loc_radius,
       l.name          AS loc_name
     FROM employee_schedules es
     JOIN shifts s ON es.shift_id = s.id
     LEFT JOIN locations l ON es.location_id = l.id
     WHERE es.employee_id = ?
       AND es.effective_from <= ?
       AND (es.effective_to IS NULL OR es.effective_to >= ?)
     ORDER BY COALESCE(s.start_time, '00:00:00') ASC, es.id ASC`,
    [auth.id, workDate, workDate],
  );

  const nowIstHHMM = formatInTimeZone(new Date(), TIMEZONE, 'HH:mm');
  const schedule = pickScheduleForArrival(daySchedules, nowIstHHMM);

  // 4. Geofence check — enforced for on-site employees only. Off-site (field)
  //    staff clock in from anywhere. The fence is at least MIN_LOGIN_RADIUS_M.
  let geofenceStatus: GeofenceStatus = 'not_required';

  // A schedule that says "fenced" but carries no location has nothing to check
  // against. That used to fall through to "no fence required", so the admin saw
  // geofencing switched on while clock-in was accepted from anywhere. Refuse
  // instead: a fence that cannot be evaluated must not read as a pass.
  if (workMode === 'on_site' && schedule?.geofencing_enabled && !schedule.location_id) {
    await insertAuditLog({
      action: 'geofence_misconfigured',
      entity: 'employee_schedule',
      entity_id: schedule.schedule_id,
      performed_by: auth.id,
      details: {
        employee_id: auth.id,
        shift: schedule.shift_name,
        reason: 'geofencing_enabled_without_location',
      },
      ip_address: ip,
    });
    return NextResponse.json<ApiResponse>(
      {
        success: false,
        error: 'Your work location has not been set up, so attendance cannot be verified. Please contact your admin.',
      },
      { status: 409 },
    );
  }

  if (
    workMode === 'on_site' &&
    schedule?.geofencing_enabled &&
    schedule.location_id &&
    schedule.loc_lat !== null &&
    schedule.loc_lng !== null
  ) {
    const effectiveRadius = Math.max(Number(schedule.loc_radius ?? 100), MIN_LOGIN_RADIUS_M);
    const inside = isWithinGeofence(
      lat,
      lng,
      schedule.loc_lat,
      schedule.loc_lng,
      effectiveRadius,
    );
    geofenceStatus = inside ? 'inside' : 'outside';

    if (geofenceStatus === 'outside') {
      return NextResponse.json<ApiResponse>(
        {
          success: false,
          error: `You are outside ${schedule.loc_name ?? 'your work location'} — move within ${effectiveRadius} m to clock in`,
        },
        { status: 403 },
      );
    }
  }

  // 5. Determine attendance status
  const nowUtc = new Date();
  let status: AttendanceStatus = 'present';

  if (schedule?.start_time && schedule.shift_type !== 'flexible') {
    status = isLate(nowUtc, schedule.start_time, schedule.grace_minutes)
      ? 'late'
      : 'present';
  }

  // Record how this employee authenticates: if they have a passkey they logged
  // in with WebAuthn; otherwise they used a PIN exemption.
  const passkeyCount = await queryOne<{ c: number }>(
    'SELECT COUNT(*) AS c FROM passkeys WHERE employee_id = ?',
    [auth.id],
  );
  const authMethod: 'webauthn' | 'pin_exemption' =
    Number(passkeyCount?.c ?? 0) > 0 ? 'webauthn' : 'pin_exemption';

  // 6. Persist the clock-in.
  //    If a no-clock-in row already exists for today (absent/leave/holiday),
  //    convert it in place; otherwise insert a new record.
  let insertId: number;
  if (existing) {
    // For a multi-session re-open, keep the finished minutes in banked_minutes
    // so clock-out adds this session on top instead of starting from zero.
    // The day's STATUS is set by the FIRST session (a punctual morning arrival
    // must not turn 'late' because the afternoon session starts after the
    // shift's start time) — preserve it on re-open.
    const effectiveStatus = completedToday ? existing.status : status;
    const sessionSet = sessionCols
      ? ', banked_minutes = ?, session_count = session_count + ?'
      : '';
    const sessionParams = sessionCols ? [bankedMinutes, completedToday ? 1 : 0] : [];
    await query(
      `UPDATE attendance
       SET clock_in_utc    = ?,
           clock_in_lat    = ?,
           clock_in_lng    = ?,
           ip_address      = ?,
           geofence_status = ?,
           auth_method     = ?,
           status          = ?,
           clock_out_utc   = NULL,
           total_minutes   = NULL
           ${sessionSet}
       WHERE id = ?`,
      [toMySQLDatetime(nowUtc), lat, lng, ip, geofenceStatus, authMethod, effectiveStatus, ...sessionParams, existing.id],
    );
    insertId = existing.id;
  } else {
    const result = await query<{ insertId: number }>(
      `INSERT INTO attendance
         (employee_id, work_date, clock_in_utc, clock_in_lat, clock_in_lng,
          ip_address, geofence_status, auth_method, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        auth.id,
        workDate,
        toMySQLDatetime(nowUtc),
        lat,
        lng,
        ip,
        geofenceStatus,
        authMethod,
        status,
      ],
    );
    // mysql2 returns OkPacket-shaped result with insertId
    insertId = (result as unknown as { insertId: number }).insertId ?? 0;
  }

  // 7. Audit log
  await insertAuditLog({
    action: 'clock_in',
    entity: 'attendance',
    entity_id: insertId,
    performed_by: auth.id,
    details: {
      // employee_id is carried on every attendance event so one filter can
      // pull a person's whole trail, whoever performed the action.
      employee_id: auth.id,
      work_date: workDate,
      status,
      geofence_status: geofenceStatus,
      auto: parsed.data.auto === true,
      latitude: lat,
      longitude: lng,
      auth_method: authMethod,
    },
    ip_address: ip,
  });

  // 7.5 Auto-start live tracking right after successful clock-in.
  // If live-tracking tables are missing in a local/legacy DB, we do not fail clock-in.
  try {
    const employeeSettings = await queryOne<{ live_tracking_enabled: number | boolean }>(
      'SELECT live_tracking_enabled FROM employees WHERE id = ?',
      [auth.id],
    );
    if (!employeeSettings?.live_tracking_enabled) {
      throw new Error('LIVE_TRACKING_DISABLED');
    }

    const nowSql = toMySQLDatetime(nowUtc);
    let activeSession = await queryOne<{ id: number }>(
      `SELECT id
       FROM live_tracking_sessions
       WHERE employee_id = ? AND is_active = TRUE
       ORDER BY started_at_utc DESC
       LIMIT 1`,
      [auth.id],
    );

    if (!activeSession) {
      const sessionInsert = await query<{ insertId: number }>(
        `INSERT INTO live_tracking_sessions (employee_id, started_at_utc, is_active, last_ping_utc)
         VALUES (?, ?, TRUE, ?)`,
        [auth.id, nowSql, nowSql],
      );
      const sessionId = (sessionInsert as unknown as { insertId: number }).insertId;
      activeSession = { id: sessionId };
    } else {
      await query(
        `UPDATE live_tracking_sessions
         SET last_ping_utc = ?
         WHERE id = ?`,
        [nowSql, activeSession.id],
      );
    }

    await query(
      `INSERT INTO live_tracking_points (session_id, employee_id, tracked_at_utc, latitude, longitude, accuracy_meters)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      [activeSession.id, auth.id, nowSql, lat, lng],
    );
  } catch (error) {
    if ((error as Error).message === 'LIVE_TRACKING_DISABLED') {
      // tracking is optional and disabled for this employee
    } else {
    // no-op on purpose: attendance must still succeed even when live-tracking infra is missing
    }
  }

  // 8. Return the created record
  const record = await queryOne<AttendanceRecord>(
    `SELECT a.*, e.name AS employee_name, e.emp_id
     FROM attendance a
     JOIN employees e ON a.employee_id = e.id
     WHERE a.id = ?`,
    [insertId],
  );

  return NextResponse.json<ApiResponse<AttendanceRecord>>(
    { success: true, data: record! },
    { status: 201 },
  );
}

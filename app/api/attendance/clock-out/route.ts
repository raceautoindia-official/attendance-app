import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { assessLocation } from '@/lib/locationTrust';
import { checkDevice } from '@/lib/deviceBinding';
import { requireAuth } from '@/lib/auth';
import {
  getWorkDateIST,
  getClientIp,
  toMySQLDatetime,
} from '@/lib/attendance';
import { hasSessionColumns } from '@/lib/employeeDetails';
import type { ApiResponse, AttendanceRecord } from '@/lib/types';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ClockOutSchema = z.object({
  latitude: z.number({ error: 'latitude must be a number' }).nullable().optional(),
  longitude: z.number({ error: 'longitude must be a number' }).nullable().optional(),
  // True when the phone performed this action itself (geofence exit, or
  // location kept off through all warnings) rather than a button tap.
  auto: z.boolean().optional(),
  reason: z.enum(['geofence_exit', 'location_off']).optional(),
  is_mocked: z.boolean().optional(),
  accuracy_m: z.number().nullable().optional(),
});

// Coordinates used to be MANDATORY for a manual clock-out. On a phone that
// cannot get a fix — indoors, location off, GPS never locking — that turned
// "tap Clock Out and go home" into a spinner that never finished, and the day
// stayed open until the next morning settled it.
//
// Refusing here bought nothing. Reaching this endpoint needs the employee's own
// token, and clocking OUT early only shortens their own day; the fraud worth
// stopping is clocking IN from somewhere they are not, which is still refused.
// So a clock-out with no position is accepted and RECORDED as position
// unknown — an honest gap in the record, rather than an employee unable to end
// their shift.

// ---------------------------------------------------------------------------
// Shape of the attendance + shift info we need
// ---------------------------------------------------------------------------

interface AttendanceWithShift {
  id: number;
  employee_id: number;
  work_date: string;
  clock_in_utc: Date;
  clock_out_utc: Date | null;
  status: string;
  // Joined shift data (may be null if no schedule)
  end_time: string | null;
  shift_type: string | null;
  grace_minutes: number | null;
}

// ---------------------------------------------------------------------------
// POST /api/attendance/clock-out
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

  const parsed = ClockOutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Validation error' },
      { status: 400 },
    );
  }

  const lat = parsed.data.latitude ?? null;
  const lng = parsed.data.longitude ?? null;
  const workDate = getWorkDateIST();
  const ip = getClientIp(request);

  // -------------------------------------------------------------------------
  // Should this phone be allowed to end somebody's day?
  //
  // There are three independent automatic clock-outs in this system, and the
  // two on the PHONE answer to nothing on the server:
  //
  //   1. the server's geofence watchdog  - obeys employee_schedules
  //   2. the phone's fence-exit rule     - obeys a fence stored on the device
  //   3. the phone's location-off rule   - obeys nothing at all
  //
  // Switching geofencing off therefore stopped (1) and left (2) and (3) still
  // ending days. Employees working until 19:00 were reported clocked out at
  // 17:47 with the fences already disarmed, because old builds were still
  // enforcing rules the company had withdrawn.
  //
  // The decision belongs here, on the server, where it can be changed for
  // everybody at once instead of waiting for a fleet to update. A refusal is a
  // 4xx, which every existing build already treats as "the server understood,
  // stop enforcing" - so this reaches phones that will never be updated again.
  // -------------------------------------------------------------------------
  if (parsed.data.auto === true) {
    const autoReason = parsed.data.reason ?? null;
    let refuse: string | null = null;

    if (autoReason === 'location_off') {
      // The weakest evidence there is: it reports that the phone could not get
      // a fix, which says nothing whatever about where its owner is. Ending a
      // day on it turns a battery-saver setting into a missing afternoon. The
      // four warnings still happen; only the clock-out is withheld. Opt back in
      // with AUTO_CLOCK_OUT_ON_LOCATION_OFF=true.
      if (process.env.AUTO_CLOCK_OUT_ON_LOCATION_OFF !== 'true') {
        refuse = 'location_off_enforcement_disabled';
      }
    } else if (autoReason === 'geofence_exit') {
      // The phone judged this against a fence it stored when it last armed. If
      // geofencing is no longer on for this employee, that fence has been
      // withdrawn and its verdict goes with it.
      const fenced = await queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n
           FROM employee_schedules es
          WHERE es.employee_id = ?
            AND es.geofencing_enabled = TRUE
            AND es.effective_from <= ?
            AND (es.effective_to IS NULL OR es.effective_to >= ?)`,
        [auth.id, workDate, workDate],
      ).catch(() => null);
      if (Number(fenced?.n ?? 0) === 0) refuse = 'geofencing_disabled_for_employee';
    }

    if (refuse) {
      // Recorded, not silently dropped: a phone repeatedly trying to clock
      // somebody out is a fault worth seeing - usually location permission or
      // battery optimisation - and the employee never finds out on their own.
      await insertAuditLog({
        action: 'auto_clock_out_refused',
        entity: 'employee',
        entity_id: auth.id,
        performed_by: null,
        details: {
          employee_id: auth.id,
          emp_id: auth.emp_id,
          work_date: workDate,
          requested_reason: autoReason,
          refused_because: refuse,
          note: 'Day left open. The phone, not the employee, is what needs attention.',
        },
        ip_address: ip,
      });
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'Automatic clock-out is not in force for this account' },
        { status: 409 },
      );
    }
  }

  // An unrecognised device is RECORDED on clock-out, not refused.
  //
  // Refusing looked right at first, but the reasoning does not hold: reaching
  // this endpoint at all requires that employee's own access token, so a
  // "wrong device" here is not someone impersonating them — it is almost always
  // their own reinstalled or replaced phone. Blocking it strands the open
  // session until an admin intervenes. And clocking OUT early only shortens
  // their own day; the fraud worth stopping is clocking IN from somewhere they
  // are not, which is refused.
  await checkDevice(auth.id, request, { action: 'clock_out', ip });

  // Doubtful coordinates are RECORDED here but do not block the clock-out.
  // Refusing would leave the session open until the midnight sweep closed it,
  // which costs the employee real hours — a worse outcome than the fake
  // location it would prevent. The audit entry is what the admin acts on.
  if (lat != null && lng != null) {
    await assessLocation(
      auth.id,
      { latitude: lat, longitude: lng, is_mocked: parsed.data.is_mocked, accuracy_m: parsed.data.accuracy_m },
      { action: 'clock_out', ip },
    );
  }

  // 2. Find the employee's open (clocked-in but not yet clocked-out) session.
  //    We deliberately do NOT filter by a.work_date = today: if the server's
  //    clock/timezone drifts, or an employee forgot to clock out on a previous
  //    day, the open session may carry a different work_date. Matching on the
  //    open session itself (clock_in present, clock_out NULL) makes clock-out
  //    robust to those date mismatches. The schedule join keys off the record's
  //    own work_date so the right shift end_time is used for early-departure.
  const record = await queryOne<AttendanceWithShift>(
    `SELECT
       a.id, a.employee_id, a.work_date, a.clock_in_utc,
       a.clock_out_utc, a.status,
       s.end_time, s.type AS shift_type, s.grace_minutes
     FROM attendance a
     LEFT JOIN employee_schedules es
       ON es.employee_id = a.employee_id
       AND es.effective_from <= a.work_date
       AND (es.effective_to IS NULL OR es.effective_to >= a.work_date)
     LEFT JOIN shifts s ON es.shift_id = s.id
     WHERE a.employee_id = ?
       AND a.clock_in_utc IS NOT NULL
       AND a.clock_out_utc IS NULL
     ORDER BY a.clock_in_utc DESC, es.effective_from DESC
     LIMIT 1`,
    [auth.id],
  );

  if (!record) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'No open clock-in found' },
      { status: 404 },
    );
  }

  // 3. A manual clock-out records the REAL time worked (clock-in → now). Only
  //    the automatic close-sessions cron credits a flat 9 hours when an
  //    employee forgets to clock out. So an early checkout shows the real,
  //    shorter duration — not 9 hours.
  const nowUtc = new Date();
  const nowSql = toMySQLDatetime(nowUtc);
  const clockInUtc = new Date(record.clock_in_utc);
  const totalMinutes = Math.max(
    0,
    Math.round((nowUtc.getTime() - clockInUtc.getTime()) / 60_000),
  );

  // 4. Status is left unchanged on clock-out — no early-departure time check.

  // 5. Close EVERY open session for this employee (normally just one). This also
  //    cleans up any duplicate open rows left over from earlier clock/timezone
  //    skew, so the dashboard never gets stuck showing "Clock Out". total_minutes
  //    is this session (from its own clock-in) plus minutes banked from earlier
  //    sessions today (multi-session/plant employees).
  const sessionCols = await hasSessionColumns();
  const bankedExpr = sessionCols ? 'banked_minutes + ' : '';
  await query(
    `UPDATE attendance
     SET clock_out_utc = ?,
         clock_out_lat = ?,
         clock_out_lng = ?,
         total_minutes = ${bankedExpr}GREATEST(0, TIMESTAMPDIFF(MINUTE, clock_in_utc, ?))
     WHERE employee_id = ?
       AND clock_in_utc IS NOT NULL
       AND clock_out_utc IS NULL`,
    [nowSql, lat, lng, nowSql, auth.id],
  );

  // Anchor the movement path at the clock-out location, then end any active
  // live-tracking session. Storing a final point first guarantees the path
  // runs end-to-end (clock-in → … → clock-out) instead of stopping at the last
  // ping up to ~15s earlier. Non-fatal if the tables are absent.
  try {
    // No anchor point when coordinates are unknown (auto clock-out with
    // location off) — the points table requires lat/lng.
    const liveSessions = lat != null && lng != null
      ? await query<{ id: number }>(
          `SELECT id FROM live_tracking_sessions
           WHERE employee_id = ? AND is_active = TRUE`,
          [auth.id],
        )
      : [];
    for (const s of liveSessions) {
      await query(
        `INSERT INTO live_tracking_points
           (session_id, employee_id, tracked_at_utc, latitude, longitude, accuracy_meters)
         VALUES (?, ?, ?, ?, ?, NULL)`,
        [s.id, auth.id, nowSql, lat, lng],
      );
    }
    await query(
      `UPDATE live_tracking_sessions
       SET is_active = FALSE, ended_at_utc = ?, last_ping_utc = ?
       WHERE employee_id = ? AND is_active = TRUE`,
      [nowSql, nowSql, auth.id],
    );
  } catch {
    // live-tracking tables may not exist in some installs — ignore.
  }

  const newStatus = record.status;

  // 6. Read the updated row first so the audit records the FULL day total
  //    (banked earlier sessions + this one), not just this session.
  const updated = await queryOne<AttendanceRecord>(
    `SELECT a.*, e.name AS employee_name, e.emp_id
     FROM attendance a
     JOIN employees e ON a.employee_id = e.id
     WHERE a.id = ?`,
    [record.id],
  );

  await insertAuditLog({
    action: 'clock_out',
    entity: 'attendance',
    entity_id: record.id,
    performed_by: auth.id,
    details: {
      employee_id: auth.id,
      work_date: workDate,
      total_minutes: updated?.total_minutes ?? totalMinutes,
      status: newStatus,
      auto: parsed.data.auto === true,
      reason: parsed.data.reason ?? null,
      // The phone could not produce a fix. Worth recording: it is the same
      // fault that stops tracking, and the employee cannot see it themselves.
      position_unavailable: lat == null || lng == null,
      latitude: lat,
      longitude: lng,
    },
    ip_address: ip,
  });

  return NextResponse.json<ApiResponse<AttendanceRecord>>(
    { success: true, data: updated! },
  );
}

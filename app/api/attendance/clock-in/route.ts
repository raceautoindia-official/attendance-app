import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { isWithinGeofence, haversineDistance } from '@/lib/geo';
import {
  hasWorkModeColumns,
  hasSessionColumns,
  hasOutOfFenceReasonColumn,
  hasOutOfFenceReviewColumns,
  hasFirstClockInColumn,
} from '@/lib/employeeDetails';
import {
  getWorkDateIST,
  isLate,
  getClientIp,
  toMySQLDatetime,
} from '@/lib/attendance';
import { formatInTimeZone } from 'date-fns-tz';
import { TIMEZONE, MIN_FENCE_RADIUS_M } from '@/lib/constants';
import { shiftForClockIn, type DayShift } from '@/lib/shifts';
import { assessLocation } from '@/lib/locationTrust';
import { activeOnDuty } from '@/lib/permissions';
import { lastFenceClosure } from '@/lib/fenceClosure';
import { closeOpenSessions } from '@/lib/closeSessions';
import { checkDevice } from '@/lib/deviceBinding';
import { sendOutOfFenceClockInAlert } from '@/lib/mailer';
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
  // out_of_fence_reason used to live here: the phone asked why, after a refusal,
  // and the sentence got the employee in. It is gone. Outside the fence is
  // refused, and the only exception is an on-duty window a manager approved in
  // advance. Zod strips unknown keys, so the APKs still sending one are simply
  // ignored rather than rejected.
});

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
  //
  //    That deliberate lack of a date bound has a second, unintended reach: a
  //    session left open on an EARLIER day blocks this morning's clock-in too.
  //    The employee sees "Already clocked in" over a Today card reading "-" for
  //    clock in, clock out and hours — the app is describing yesterday while
  //    showing today, so there is nothing on screen to act on and no way to
  //    clock out of a day that has already been settled.
  //
  //    Yesterday is not this morning's problem. A day that has ENDED is settled
  //    here, on the spot, exactly as the end-of-day sweep would settle it —
  //    same credit, same audit entry — and the clock-in carries on. The sweep
  //    still runs; this only means a sweep that was missed (server restarted
  //    over the boundary, database briefly unreachable) costs somebody an
  //    argument with their phone at 9am instead of a day's attendance.
  const findOpenSession = () => queryOne<{
    id: number;
    work_date: string;
    clock_in_utc: Date;
  }>(
    `SELECT id, DATE_FORMAT(work_date, '%Y-%m-%d') AS work_date, clock_in_utc
     FROM attendance
     WHERE employee_id = ? AND clock_in_utc IS NOT NULL AND clock_out_utc IS NULL
     ORDER BY work_date DESC
     LIMIT 1`,
    [auth.id],
  );

  let openSession = await findOpenSession();
  if (openSession && openSession.work_date < workDate) {
    // Settles every ended day this employee has left open, not just the newest.
    await closeOpenSessions({ employeeId: auth.id }).catch(() => 0);
    openSession = await findOpenSession();
  }
  if (openSession) {
    // Say WHEN. "Already clocked in" against an empty card is the message that
    // sent this to support in the first place; the time is the one fact that
    // makes it actionable — either they remember clocking in, or they know to
    // report a session that is not theirs.
    const since = formatInTimeZone(new Date(openSession.clock_in_utc), TIMEZONE, 'h:mm a');
    return NextResponse.json<ApiResponse>(
      {
        success: false,
        error: openSession.work_date === workDate
          ? `Already clocked in at ${since}. Clock out first.`
          // A day that has not ended cannot be settled, and one dated ahead of
          // today means the clock is wrong somewhere. Neither is the employee's
          // to fix, so name the day and point them at someone who can.
          : `A session from ${openSession.work_date} (clocked in ${since}) is still open. ` +
            'Ask your administrator to close it.',
      },
      { status: 409 },
    );
  }

  const [workModeCols, sessionCols, reasonCol, reviewCols, firstInCol] = await Promise.all([
    hasWorkModeColumns(),
    hasSessionColumns(),
    hasOutOfFenceReasonColumn(),
    hasOutOfFenceReviewColumns(),
    hasFirstClockInColumn(),
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
     LEFT JOIN locations l ON es.location_id = l.id AND l.is_active = TRUE
     WHERE es.employee_id = ?
       AND es.effective_from <= ?
       AND (es.effective_to IS NULL OR es.effective_to >= ?)
     ORDER BY COALESCE(s.start_time, '00:00:00') ASC, es.id ASC`,
    [auth.id, workDate, workDate],
  );

  const nowIstHHMM = formatInTimeZone(new Date(), TIMEZONE, 'HH:mm');
  const schedule = pickScheduleForArrival(daySchedules, nowIstHHMM);

  // 4. Geofence check — enforced for on-site employees only. Off-site (field)
  //    staff clock in from anywhere. The fence is at least MIN_FENCE_RADIUS_M.
  let geofenceStatus: GeofenceStatus = 'not_required';

  // A schedule that says "fenced" but carries no location has nothing to check
  // against. That used to fall through to "no fence required", so the admin saw
  // geofencing switched on while clock-in was accepted from anywhere. Refuse
  // instead: a fence that cannot be evaluated must not read as a pass.
  // Test for USABLE COORDINATES, not merely for a location_id. A schedule can
  // point at a location that has since been deactivated — production had one
  // sitting at 0,0 — and then location_id is set while the join returns
  // nothing. Checking the id alone let that fall through to "no fence
  // required", which is the same hole in a new disguise: geofencing switched
  // on, and clock-in accepted from anywhere.
  const fenceUnusable = schedule?.loc_lat == null || schedule?.loc_lng == null;
  if (workMode === 'on_site' && schedule?.geofencing_enabled && fenceUnusable) {
    await insertAuditLog({
      action: 'geofence_misconfigured',
      entity: 'employee_schedule',
      entity_id: schedule.schedule_id,
      performed_by: auth.id,
      details: {
        employee_id: auth.id,
        shift: schedule.shift_name,
        reason: schedule.location_id
          ? 'location_missing_or_deactivated'
          : 'geofencing_enabled_without_location',
        location_id: schedule.location_id,
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
    const effectiveRadius = Math.max(Number(schedule.loc_radius ?? 100), MIN_FENCE_RADIUS_M);
    const inside = isWithinGeofence(
      lat,
      lng,
      schedule.loc_lat,
      schedule.loc_lng,
      effectiveRadius,
    );
    geofenceStatus = inside ? 'inside' : 'outside';

    // Working away from the site WITH AN ADMIN'S BLESSING. The watchdog already
    // honours this — an approved on-duty window never ends anyone's day — but
    // clock-in did not, so the sanctioned route still put people in front of
    // the reason box like an exception. Approved is approved: no reason asked,
    // nothing flagged for review.
    const onDuty = geofenceStatus === 'outside'
      ? await activeOnDuty(auth.id, workDate, formatInTimeZone(new Date(), TIMEZONE, 'HH:mm:ss'))
      : null;

    // OUTSIDE THE FENCE IS REFUSED. There is no way through it.
    //
    // There used to be: the employee typed a sentence and was let in, with the
    // day marked as an exception and an admin told. That was asked for, and
    // then it was watched being used to walk straight back onto the clock from
    // the spot the fence had just closed the day at. A fence an employee can
    // open by writing in a box is a fence in name only, so the box is gone.
    //
    // The one remaining exception is not the employee's to grant: an APPROVED
    // on-duty window, agreed by a manager in advance (see `onDuty` above). The
    // watchdog already honours it — an approved day away is not ended for being
    // away — and clock-in now matches, because a rule enforced at one end and
    // not the other is how this whole class of bug happens.
    //
    // `code` is what the app keys on. Matching on the message text would break
    // the moment the wording changed, and the wording carries a distance that
    // has to change.
    if (geofenceStatus === 'outside' && !onDuty) {
      const away = Math.round(haversineDistance(lat, lng, schedule.loc_lat, schedule.loc_lng));
      // Was this day already ended BY the fence? It changes what they are told,
      // and it is worth knowing on the audit entry. Looked up once.
      const closure = existing?.id ? await lastFenceClosure(existing.id) : null;

      // The refusal itself is recorded. Refusing silently would mean an
      // employee could try from three kilometres away, all day, and leave no
      // trace — and the admin's first sign of trouble would be a missing day
      // with no explanation in it. It is written before the response so a
      // failure here cannot be mistaken for a successful clock-in.
      //
      // `accuracy_m` is kept deliberately: when somebody insists they were
      // standing at the gate, it is the difference between a bad fix and a
      // bad excuse.
      try {
        await insertAuditLog({
          action: 'clock_in_refused_outside_fence',
          entity: 'employee',
          entity_id: auth.id,
          performed_by: auth.id,
          details: {
            employee_id: auth.id,
            work_date: workDate,
            location: schedule.loc_name ?? null,
            radius_m: effectiveRadius,
            distance_m: Number.isFinite(away) ? away : null,
            accuracy_m: parsed.data.accuracy_m ?? null,
            latitude: lat,
            longitude: lng,
            // Which refusal this was: the fence had already ended their day
            // once, or they simply were not at the site.
            after_fence_closure: !!closure,
          },
          ip_address: ip,
        });

        // Tell an admin — ONCE per person per day, however many times they try.
        // Somebody standing outside believing they are at work is worth hearing
        // about the same morning rather than discovering as an unexplained
        // missing day at month end. The count is taken AFTER the insert above,
        // so the first refusal sees exactly 1 and later ones see more; a phone
        // retrying a slow request cannot mail the admin twice.
        const refusalsToday = await queryOne<{ n: number }>(
          `SELECT COUNT(*) AS n FROM audit_log
            WHERE action = 'clock_in_refused_outside_fence'
              AND entity = 'employee' AND entity_id = ?
              AND JSON_UNQUOTE(JSON_EXTRACT(details, '$.work_date')) = ?`,
          [auth.id, workDate],
        );
        if (Number(refusalsToday?.n ?? 0) <= 1) {
          const admins = await query<{ email: string | null }>(
            `SELECT DISTINCT email FROM employees
              WHERE is_active = TRUE AND role IN ('super_admin', 'manager') AND email IS NOT NULL`,
          );
          const me = await queryOne<{ name: string; emp_id: string }>(
            'SELECT name, emp_id FROM employees WHERE id = ?', [auth.id]);
          // Fire-and-forget: the refusal must not wait on a mail server. The
          // audit entry above is the delivery that matters; send() swallows its
          // own failures.
          void Promise.all(
            admins
              .map(a => a.email)
              .filter((e): e is string => !!e)
              .map(email =>
                sendOutOfFenceClockInAlert(email, {
                  employeeName: me?.name ?? `Employee ${auth.id}`,
                  empId: me?.emp_id ?? String(auth.id),
                  locationName: schedule.loc_name ?? null,
                  distanceM: Number.isFinite(away) ? away : null,
                  radiusM: effectiveRadius,
                  accuracyM: parsed.data.accuracy_m ?? null,
                  afterFenceClosure: !!closure,
                  latitude: lat,
                  longitude: lng,
                  attemptedAt: new Date(),
                })),
          );
        }
      } catch { /* an audit failure must not turn a refusal into something else */ }

      // A day the fence itself closed gets the reason it was closed, not a bare
      // "you are outside" — the employee is standing where the app clocked them
      // out and deserves to be told that is why.
      return NextResponse.json<ApiResponse>(
        {
          success: false,
          code: closure ? 'fence_closed_day' : 'outside_fence',
          error: closure
            ? `Your day was closed automatically when you left ${schedule.loc_name ?? 'your work location'}`
              + `. You are ${Number.isFinite(away) ? `${away} m` : 'still'} away — return to within ${effectiveRadius} m`
              + ' to clock in again.'
            : `You are outside ${schedule.loc_name ?? 'your work location'}`
              + `${Number.isFinite(away) ? ` by ${away} m` : ''}`
              + ` — move within ${effectiveRadius} m to clock in.`,
          location_name: schedule.loc_name ?? null,
          radius_m: effectiveRadius,
          distance_m: Number.isFinite(away) ? away : null,
        },
        { status: 403 },
      );
    }
  }

  // Always null now: a clock-in cannot be excused from outside the fence any
  // more, so no new row ever carries a reason. It is still WRITTEN, on every
  // clock-in, precisely because it is always null — an attendance row is reused
  // all day, and an old reason left over from a session recorded under the
  // previous rule must be cleared rather than inherited by today's work.
  // Historical rows keep theirs; the column and its review screens stay.
  const outOfFenceReason: string | null = null;

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
    // Always written, never only when set: an attendance row is reused all day,
    // so a later session clocked in from the site would otherwise keep the
    // morning's excuse attached and read as an exception it was not.
    const reasonSet = reasonCol ? ', out_of_fence_reason = ?' : '';
    const reasonParams = reasonCol ? [outOfFenceReason] : [];
    // 'pending' the moment it happens, so it appears in the admin's
    // Notifications tab. Cleared back to NULL on an ordinary clock-in, or a
    // later session from the desk would inherit the morning's review state and
    // sit in that list for ever.
    const reviewSet = reviewCols
      ? ', out_of_fence_status = ?, out_of_fence_reviewed_by = NULL, out_of_fence_reviewed_at = NULL, out_of_fence_review_notes = NULL'
      : '';
    const reviewParams = reviewCols ? [outOfFenceReason ? 'pending' : null] : [];
    // The day's FIRST login survives every later session. clock_in_utc is
    // legitimately overwritten on re-open (it means "current session start",
    // and the session maths depends on that) — but the morning belongs to the
    // record, and this row used to lose it. COALESCE: set once, never touched.
    const firstInSet = firstInCol ? ', first_clock_in_utc = COALESCE(first_clock_in_utc, ?)' : '';
    const firstInParams = firstInCol ? [toMySQLDatetime(nowUtc)] : [];
    // The duplicate-clock-in check earlier is a SEPARATE statement, so two
    // requests can both pass it before either one writes — a phone retrying a
    // slow request is enough to arrange that. Unguarded, the second UPDATE
    // re-opens a session that is already open: two clock-ins with no clock-out
    // between them, session_count counting one more session than happened, and
    // the minutes between the two lost, because banked_minutes is overwritten
    // with the same stale figure both times. Production has a day shaped
    // exactly like that.
    //
    // Re-stating the precondition in the WHERE makes the write itself the
    // arbiter: whichever request lands second matches no rows and is told it is
    // already clocked in, which is true by then.
    const raceGuard = completedToday
      ? 'AND clock_out_utc IS NOT NULL' // re-opening a finished day
      : 'AND clock_in_utc IS NULL';     // converting an absent/leave/holiday row
    const updated = await query(
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
           ${sessionSet}${reasonSet}${reviewSet}${firstInSet}
       WHERE id = ? ${raceGuard}`,
      [toMySQLDatetime(nowUtc), lat, lng, ip, geofenceStatus, authMethod, effectiveStatus,
       ...sessionParams, ...reasonParams, ...reviewParams, ...firstInParams, existing.id],
    );
    if ((updated as unknown as { affectedRows: number }).affectedRows === 0) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'Already clocked in' },
        { status: 409 },
      );
    }
    insertId = existing.id;
  } else {
    const result = await query<{ insertId: number }>(
      `INSERT INTO attendance
         (employee_id, work_date, clock_in_utc, clock_in_lat, clock_in_lng,
          ip_address, geofence_status, auth_method, status${reasonCol ? ', out_of_fence_reason' : ''}${reviewCols ? ', out_of_fence_status' : ''}${firstInCol ? ', first_clock_in_utc' : ''})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?${reasonCol ? ', ?' : ''}${reviewCols ? ', ?' : ''}${firstInCol ? ', ?' : ''})`,
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
        ...(reasonCol ? [outOfFenceReason] : []),
        ...(reviewCols ? [outOfFenceReason ? 'pending' : null] : []),
        ...(firstInCol ? [toMySQLDatetime(nowUtc)] : []),
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
      out_of_fence_reason: outOfFenceReason,
    },
    ip_address: ip,
  });

  // The alert that used to sit here told an admin the fence had been WAIVED —
  // that somebody clocked in off-site on their own say-so. There is no waiver
  // any more, so there is nothing to announce at this point: a clock-in that
  // reaches here was either inside the fence, unfenced, or approved on-duty in
  // advance. The alert now fires on the REFUSAL instead, at the point of
  // refusal, where the thing worth telling an admin actually happens.

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

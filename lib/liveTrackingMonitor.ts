// ---------------------------------------------------------------------------
// The live-tracking sweep, as plain logic.
//
// It used to live inside the cron route, which meant it ONLY ever ran when
// something POSTed to /api/cron/live-tracking-monitor with the right secret.
// The end-of-day jobs were deliberately moved in-process so no crontab was
// needed — this one was left behind, so on any server without an external cron
// (or with CRON_SECRET unset, where the endpoint rejects everything) the
// geofence auto clock-out silently never happened.
//
// Now both callers share this: the route for a manual trigger, and the in-app
// scheduler on its regular sweep.
// ---------------------------------------------------------------------------

import { query, queryOne, insertAuditLog } from '@/lib/db';
import { sendLiveTrackingAlert, sendGeofenceAutoClockoutAlert } from '@/lib/mailer';
import {
  hasWorkModeColumns,
  hasSessionColumns,
  hasLiveTrackingColumn,
} from '@/lib/employeeDetails';
import { toMySQLDatetime } from '@/lib/attendance';
import { activeOnDuty, hasOnDutyColumn } from '@/lib/permissions';
import { pushToEmployee } from '@/lib/push';
import { formatInTimeZone } from 'date-fns-tz';
import { TIMEZONE, MIN_FENCE_RADIUS_M, MAX_ACCURACY_ALLOWANCE_M } from '@/lib/constants';

interface StaleSessionRow {
  session_id: number;
  employee_id: number;
  employee_name: string;
  emp_id: string;
  last_ping_utc: Date | null;
}

// An on-site employee who has been placed OUTSIDE their fence, with no fix
// placing them back inside for this long, is clocked out — credited only up to
// the last moment their presence was confirmed.
const OUTSIDE_LIMIT_MIN = Number(process.env.GEOFENCE_PRESENCE_GRACE_MIN) || 30;

/**
 * How many fixes must place someone outside the fence before their day is
 * ended. Silence is never enough.
 *
 * This rule once said "absence of evidence is absence". On a fleet where the
 * phones were not reporting at all, that cost four people their entire day
 * inside one morning:
 *
 *     clocked in 09:58, clocked out 09:58, 0h 0m, present
 *
 * A floor of 15 minutes' tracked presence was added, and it only moved the
 * problem: every phone whose tracking was killed later in the day — battery
 * saver, an OEM task killer, a reboot — was clocked out 30 minutes after its
 * last fix, from the desk it never left. Single-session accounts could not
 * clock back in, so every hour after that was lost. That was the standing
 * complaint: "clocked out inside the geofence", "hours missing".
 *
 * The flaw was always the inference. "Left the site" and "this phone stopped
 * reporting" produce identical silence, and only one is the employee's doing.
 * So the day now ends only on POSITIVE evidence: fixes that put them outside
 * the fence even after each is forgiven its whole reported accuracy. A phone
 * that is still reporting produces dozens of those within the grace period of
 * someone actually leaving; a phone that went quiet produces none.
 *
 * Silence is reported instead of acted on: an audit entry naming the employee
 * and the gap, and the end-of-day sweep settles the day at the last fix if
 * nobody clocks out — so a phone switched off to leave early still earns
 * nothing past the moment it went dark.
 */
const MIN_OUTSIDE_FIXES = Math.max(1, Number(process.env.GEOFENCE_MIN_OUTSIDE_FIXES) || 3);

interface GeofenceCandidateRow {
  attendance_id: number;
  employee_id: number;
  employee_name: string;
  emp_id: string;
  clock_in_utc: Date;
  loc_name: string | null;
  loc_lat: number;
  loc_lng: number;
  loc_radius: number;
}

/** Last moment a fix placed this employee inside their fence, or null. */
async function lastConfirmedInside(
  c: GeofenceCandidateRow,
  fence: number,
): Promise<{ tracked_at_utc: Date; latitude: number; longitude: number } | null> {
  // Haversine in SQL so only the single most recent qualifying fix comes back —
  // a full shift can hold thousands of points. A fix counts as inside when it
  // lands within the fence once its own accuracy is allowed for (capped, so a
  // wildly imprecise fix cannot vouch for someone from far away).
  return queryOne<{ tracked_at_utc: Date; latitude: number; longitude: number }>(
    `SELECT tracked_at_utc, latitude, longitude
     FROM live_tracking_points
     WHERE employee_id = ?
       AND tracked_at_utc >= ?
       AND (6371000 * 2 * ASIN(SQRT(
             POWER(SIN(RADIANS(latitude - ?) / 2), 2) +
             COS(RADIANS(?)) * COS(RADIANS(latitude)) *
             POWER(SIN(RADIANS(longitude - ?) / 2), 2)
           ))) <= ? + LEAST(COALESCE(accuracy_meters, 0), ?)
     ORDER BY tracked_at_utc DESC
     LIMIT 1`,
    [
      c.employee_id,
      toMySQLDatetime(new Date(c.clock_in_utc)),
      c.loc_lat, c.loc_lat, c.loc_lng,
      fence, Math.min(MAX_ACCURACY_ALLOWANCE_M, fence),
    ],
  );
}

/**
 * Fixes after `since` that place the employee outside the fence even when each
 * is given the benefit of its own accuracy — the whole circle of uncertainty
 * lies beyond the fence. Uncapped on purpose: the vaguer a fix, the less it
 * proves about someone having left, which is the opposite of the presence test
 * above, where a vague fix must not vouch from far away.
 */
async function confirmedOutsideSince(
  c: GeofenceCandidateRow,
  fence: number,
  since: Date,
): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n
     FROM live_tracking_points
     WHERE employee_id = ?
       AND tracked_at_utc > ?
       AND (6371000 * 2 * ASIN(SQRT(
             POWER(SIN(RADIANS(latitude - ?) / 2), 2) +
             COS(RADIANS(?)) * COS(RADIANS(latitude)) *
             POWER(SIN(RADIANS(longitude - ?) / 2), 2)
           ))) > ? + COALESCE(accuracy_meters, 0)`,
    [c.employee_id, toMySQLDatetime(since), c.loc_lat, c.loc_lat, c.loc_lng, fence],
  );
  return Number(row?.n ?? 0);
}

/**
 * A phone that is not reporting, recorded as exactly that.
 *
 * The employee stays clocked in. This is the whole point: their day is not
 * endable on this evidence, and the thing that actually needs attention is the
 * phone — background location permission, battery optimisation, or no route to
 * the server. Ending the day would hide that behind a plausible-looking
 * attendance row, which is how the fault survived unnoticed for as long as it
 * did.
 *
 * Once per employee per work day. This runs every few minutes, and an entry per
 * sweep would bury the log in the same fact three hundred times.
 */
async function reportUnverifiablePresence(
  c: GeofenceCandidateRow,
  trackedMs: number,
  silentMs: number,
  outsideFixes: number,
): Promise<void> {
  const workDate = formatInTimeZone(new Date(c.clock_in_utc), TIMEZONE, 'yyyy-MM-dd');
  const already = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit_log
      WHERE action = 'geofence_presence_unverifiable'
        AND entity = 'attendance'
        AND entity_id = ?`,
    [c.attendance_id],
  );
  if (Number(already?.n ?? 0) > 0) return;

  await insertAuditLog({
    action: 'geofence_presence_unverifiable',
    entity: 'attendance',
    entity_id: c.attendance_id,
    performed_by: null,
    details: {
      employee_id: c.employee_id,
      emp_id: c.emp_id,
      employee_name: c.employee_name,
      work_date: workDate,
      location: c.loc_name,
      // Everything needed to tell a tracking fault from a real departure.
      tracked_minutes: Math.round(trackedMs / 60_000),
      minutes_unconfirmed: Math.round(silentMs / 60_000),
      outside_fixes: outsideFixes,
      minimum_outside_fixes: MIN_OUTSIDE_FIXES,
      presence_grace_min: OUTSIDE_LIMIT_MIN,
      outcome: 'left_clocked_in',
      note: 'Phone stopped confirming presence without placing them outside the fence. Day left open on purpose.',
    },
    ip_address: null,
  });

  console.warn(
    `[live-monitor] ${c.emp_id} (${c.employee_name}): phone confirmed ` +
    `${Math.round(trackedMs / 60_000)} min inside ${c.loc_name ?? 'site'} then nothing for ` +
    `${Math.round(silentMs / 60_000)} min, with ${outsideFixes} fix(es) outside. Day LEFT OPEN — ` +
    "check the phone's location permission and battery settings, not the employee.",
  );
}

// Close any on-site session whose presence inside the fence has not been
// confirmed for OUTSIDE_LIMIT_MIN, crediting only up to the last confirmed
// moment. Returns how many were clocked out.
async function runGeofenceWatchdog(adminEmails: string[]): Promise<number> {
  if (!(await hasWorkModeColumns())) return 0;
  const sessionCols = await hasSessionColumns();
  const trackingCol = await hasLiveTrackingColumn();

  const candidates = await query<GeofenceCandidateRow>(
    `SELECT
       a.id   AS attendance_id,
       a.employee_id,
       e.name AS employee_name,
       e.emp_id,
       a.clock_in_utc,
       l.name AS loc_name,
       l.latitude  AS loc_lat,
       l.longitude AS loc_lng,
       l.radius_meters AS loc_radius
     FROM attendance a
     JOIN employees e ON e.id = a.employee_id AND e.is_active = TRUE AND e.work_mode = 'on_site'
     JOIN employee_schedules es
       ON es.id = (
         SELECT id FROM employee_schedules
         WHERE employee_id = e.id
           AND effective_from <= a.work_date
           AND (effective_to IS NULL OR effective_to >= a.work_date)
         ORDER BY effective_from DESC
         LIMIT 1
       )
       AND es.geofencing_enabled = TRUE
     JOIN locations l ON l.id = es.location_id AND l.is_active = TRUE
     WHERE a.clock_in_utc IS NOT NULL
       AND a.clock_out_utc IS NULL
       -- Never judge an employee whose tracking the ADMIN switched off: their
       -- phone is not meant to report, so silence is not their doing.
       ${trackingCol ? 'AND e.live_tracking_enabled = TRUE' : ''}
       AND a.clock_in_utc <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE)`,
    [OUTSIDE_LIMIT_MIN],
  );

  const onDutyAvailable = await hasOnDutyColumn();

  let clockedOut = 0;
  for (const c of candidates) {
    // Approved OUT-OF-OFFICE DUTY: the employee is working away from the site
    // with an admin's blessing, so being outside the fence is expected and must
    // NOT end their day.
    if (onDutyAvailable) {
      const workDate = formatInTimeZone(new Date(), TIMEZONE, 'yyyy-MM-dd');
      const nowTime = formatInTimeZone(new Date(), TIMEZONE, 'HH:mm:ss');
      if (await activeOnDuty(c.employee_id, workDate, nowTime)) continue;
    }

    const fence = Math.max(Number(c.loc_radius ?? 100), MIN_FENCE_RADIUS_M);
    const inside = await lastConfirmedInside(c, fence);

    // Clock-in itself verified the fence, so that instant is the earliest
    // presence we can stand behind when no fix has done so since.
    const confirmedAt = inside ? new Date(inside.tracked_at_utc) : new Date(c.clock_in_utc);
    const silentMs = Date.now() - confirmedAt.getTime();
    if (silentMs < OUTSIDE_LIMIT_MIN * 60_000) continue; // still vouched for

    // Evidence they LEFT, or only that their phone went quiet? See
    // MIN_OUTSIDE_FIXES. Without fixes outside, this reports and moves on
    // rather than ending somebody's day on an inference.
    const trackedMs = confirmedAt.getTime() - new Date(c.clock_in_utc).getTime();
    const outsideFixes = await confirmedOutsideSince(c, fence, confirmedAt);
    if (outsideFixes < MIN_OUTSIDE_FIXES) {
      await reportUnverifiablePresence(c, trackedMs, silentMs, outsideFixes);
      continue;
    }

    const reason = inside ? 'left_the_fence' : 'presence_never_confirmed';
    const closeAt = toMySQLDatetime(confirmedAt);
    const bankedExpr = sessionCols ? 'banked_minutes + ' : '';
    // Credit stops at the last confirmed presence — NOT at "now", which would
    // pay for the whole unverified stretch, and not a flat shift.
    await query(
      `UPDATE attendance
       SET clock_out_utc = ?,
           clock_out_lat = ?,
           clock_out_lng = ?,
           total_minutes = ${bankedExpr}GREATEST(0, TIMESTAMPDIFF(MINUTE, clock_in_utc, ?))
       WHERE id = ? AND clock_out_utc IS NULL`,
      [closeAt, inside?.latitude ?? null, inside?.longitude ?? null, closeAt, c.attendance_id],
    );
    await query(
      `UPDATE live_tracking_sessions
       SET is_active = FALSE, ended_at_utc = UTC_TIMESTAMP()
       WHERE employee_id = ? AND is_active = TRUE`,
      [c.employee_id],
    );
    await insertAuditLog({
      action: 'geofence_auto_clockout',
      entity: 'attendance',
      entity_id: c.attendance_id,
      performed_by: null,
      details: {
        employee_id: c.employee_id,
        emp_id: c.emp_id,
        location: c.loc_name,
        reason,
        presence_grace_min: OUTSIDE_LIMIT_MIN,
        fence_radius_m: fence,
        last_confirmed_inside: confirmedAt.toISOString(),
        minutes_unconfirmed: Math.round(silentMs / 60_000),
      },
      ip_address: null,
    });
    // The employee was never told: the phone announces only the clock-outs it
    // makes itself, and this one is the server's. Now they hear it at once,
    // with the time it was credited to and the way back.
    void pushToEmployee(c.employee_id, {
      title: 'Clocked out automatically',
      body: `Your phone showed you away from ${c.loc_name ?? 'your work site'}, so you were clocked out at `
        + `${formatInTimeZone(confirmedAt, TIMEZONE, 'h:mm a')}. Back on site? Clock in again.`,
      channelId: 'geofence-auto',
      data: { kind: 'auto_clock_out', attendance_id: c.attendance_id },
    });
    await Promise.all(
      adminEmails.map(email =>
        sendGeofenceAutoClockoutAlert(email, {
          employeeName: c.employee_name,
          empId: c.emp_id,
          locationName: c.loc_name,
          minutesOutside: Math.round(silentMs / 60_000),
          detectedAt: new Date(),
        }),
      ),
    );
    clockedOut++;
  }
  return clockedOut;
}


export interface MonitorResult {
  message: string;
  /** Stale live-tracking sessions closed this sweep. */
  count: number;
  /** Admin alert emails sent because a phone stopped reporting. */
  alertsSent: number;
  /** Employees auto clocked-out for being away from their fence. */
  geofenceClockouts: number;
}

export async function runLiveTrackingMonitor(): Promise<MonitorResult> {
  const staleMinutes = Math.max(1, Number(process.env.LIVE_TRACKING_STALE_MINUTES) || 3);

  const admins = await query<{ email: string | null }>(
    `SELECT DISTINCT email
     FROM employees
     WHERE is_active = TRUE
       AND role IN ('super_admin', 'manager')
       AND email IS NOT NULL`,
  );
  const adminEmails = admins.map(a => a.email).filter((email): email is string => !!email);

  // On-site employees outside their geofence for 30+ minutes → auto clock-out.
  const geofenceClockouts = await runGeofenceWatchdog(adminEmails);

  const staleSessions = await query<StaleSessionRow>(
    `SELECT
       s.id AS session_id,
       s.employee_id,
       e.name AS employee_name,
       e.emp_id,
       s.last_ping_utc
     FROM live_tracking_sessions s
     JOIN employees e ON e.id = s.employee_id
     -- Only somebody ON SHIFT can meaningfully go silent. Sessions are no
     -- longer executed for staleness, so without this join a session lingering
     -- after clock-out would raise a fresh alert every cooldown, forever.
     JOIN attendance a ON a.employee_id = s.employee_id
       AND a.clock_in_utc IS NOT NULL
       AND a.clock_out_utc IS NULL
     WHERE s.is_active = TRUE
       AND e.is_active = TRUE
       AND s.last_ping_utc IS NOT NULL
       AND TIMESTAMPDIFF(MINUTE, s.last_ping_utc, UTC_TIMESTAMP()) >= ?`,
    [staleMinutes],
  );

  if (!staleSessions.length) {
    return { message: 'No stale live-tracking sessions', count: 0, alertsSent: 0, geofenceClockouts };
  }

  let alertsSent = 0;

  for (const session of staleSessions) {
    const recentAlert = await queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total
       FROM audit_log
       WHERE action = 'live_tracking_signal_lost'
         AND JSON_EXTRACT(details, '$.session_id') = ?
         AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 MINUTE)`,
      [session.session_id],
    );

    if (Number(recentAlert?.total ?? 0) > 0) continue;

    await insertAuditLog({
      action: 'live_tracking_signal_lost',
      entity: 'attendance',
      entity_id: session.session_id,
      performed_by: null,
      details: {
        session_id: session.session_id,
        employee_id: session.employee_id,
        emp_id: session.emp_id,
        last_ping_utc: session.last_ping_utc,
        stale_minutes_threshold: staleMinutes,
      },
      ip_address: null,
    });

    // The session is NOT ended here — deliberately, and it used to be, which
    // took the whole fleet dark at once. A phone that pauses for three minutes
    // (doze, a lift, a network blip) is a condition to REPORT, not a session to
    // execute: once ended, every later fix from that phone bounced off "no
    // active session" for the rest of the day, so a 3-minute gap became
    // permanent silence. The session lives as long as the shift does; what
    // ends it is clock-out, an admin disabling tracking, or the geofence
    // watchdog ending the day itself. Prolonged silence while fenced is
    // already handled by the watchdog — as absence of the employee, which it
    // is, rather than as a bookkeeping state.
    await Promise.all(
      adminEmails.map(email => sendLiveTrackingAlert(email, {
        employeeName: session.employee_name,
        empId: session.emp_id,
        reason: 'stale_ping',
        detectedAt: new Date(),
        sessionId: session.session_id,
      })),
    );
    alertsSent++;
  }

  return {
    message: `Processed ${staleSessions.length} stale session(s)`,
    count: staleSessions.length,
    alertsSent,
    geofenceClockouts,
  };
}

import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { sendLiveTrackingAlert, sendGeofenceAutoClockoutAlert } from '@/lib/mailer';
import { haversineDistance } from '@/lib/geo';
import { hasWorkModeColumns, hasSessionColumns } from '@/lib/employeeDetails';
import { toMySQLDatetime } from '@/lib/attendance';

interface StaleSessionRow {
  session_id: number;
  employee_id: number;
  employee_name: string;
  emp_id: string;
  last_ping_utc: Date | null;
}

// On-site employees who stay outside their geofence this long while clocked in
// are automatically clocked out and admins are alerted.
const OUTSIDE_LIMIT_MIN = 30;
// Fences are enforced with at least this radius (matches clock-in).
const MIN_FENCE_RADIUS_M = 200;
// GPS fixes worse than this cannot prove someone is outside.
const MAX_FIX_ACCURACY_M = 200;

interface GeofenceCandidateRow {
  attendance_id: number;
  employee_id: number;
  employee_name: string;
  emp_id: string;
  loc_name: string | null;
  loc_lat: number;
  loc_lng: number;
  loc_radius: number;
}

interface RecentPointRow {
  latitude: number;
  longitude: number;
  accuracy_meters: number | null;
  tracked_at_utc: Date;
}

// Auto clock-out employees who have provably been outside their fence for the
// whole OUTSIDE_LIMIT_MIN window. Returns how many were clocked out.
async function runGeofenceWatchdog(adminEmails: string[]): Promise<number> {
  if (!(await hasWorkModeColumns())) return 0;
  const sessionCols = await hasSessionColumns();

  const candidates = await query<GeofenceCandidateRow>(
    `SELECT
       a.id   AS attendance_id,
       a.employee_id,
       e.name AS employee_name,
       e.emp_id,
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
       AND a.clock_in_utc <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE)`,
    [OUTSIDE_LIMIT_MIN],
  );

  let clockedOut = 0;
  for (const c of candidates) {
    // Points from a bit more than the limit window, reliable fixes only.
    const points = await query<RecentPointRow>(
      `SELECT latitude, longitude, accuracy_meters, tracked_at_utc
       FROM live_tracking_points
       WHERE employee_id = ?
         AND tracked_at_utc >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE)
         AND (accuracy_meters IS NULL OR accuracy_meters <= ?)
       ORDER BY tracked_at_utc ASC`,
      [c.employee_id, OUTSIDE_LIMIT_MIN + 5, MAX_FIX_ACCURACY_M],
    );
    if (points.length < 2) continue; // not enough signal to judge

    const fence = Math.max(Number(c.loc_radius ?? 100), MIN_FENCE_RADIUS_M);
    const isOutside = (p: RecentPointRow) =>
      haversineDistance(Number(p.latitude), Number(p.longitude), Number(c.loc_lat), Number(c.loc_lng)) >
      fence + Math.min(Number(p.accuracy_meters ?? 0), 100);

    const anyInside = points.some(p => !isOutside(p));
    if (anyInside) continue; // they were (or came back) inside within the window
    const earliestMs = new Date(points[0].tracked_at_utc).getTime();
    if (Date.now() - earliestMs < OUTSIDE_LIMIT_MIN * 60_000) continue; // streak too short

    const last = points[points.length - 1];
    const nowSql = toMySQLDatetime(new Date());
    const bankedExpr = sessionCols ? 'banked_minutes + ' : '';
    await query(
      `UPDATE attendance
       SET clock_out_utc = ?,
           clock_out_lat = ?,
           clock_out_lng = ?,
           total_minutes = ${bankedExpr}GREATEST(0, TIMESTAMPDIFF(MINUTE, clock_in_utc, ?))
       WHERE id = ? AND clock_out_utc IS NULL`,
      [nowSql, last.latitude, last.longitude, nowSql, c.attendance_id],
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
        minutes_outside_threshold: OUTSIDE_LIMIT_MIN,
        fence_radius_m: fence,
      },
      ip_address: null,
    });
    await Promise.all(
      adminEmails.map(email =>
        sendGeofenceAutoClockoutAlert(email, {
          employeeName: c.employee_name,
          empId: c.emp_id,
          locationName: c.loc_name,
          minutesOutside: OUTSIDE_LIMIT_MIN,
          detectedAt: new Date(),
        }),
      ),
    );
    clockedOut++;
  }
  return clockedOut;
}

export async function POST(request: NextRequest) {
  const secret = request.headers.get('x-cron-secret');
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

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
     WHERE s.is_active = TRUE
       AND e.is_active = TRUE
       AND s.last_ping_utc IS NOT NULL
       AND TIMESTAMPDIFF(MINUTE, s.last_ping_utc, UTC_TIMESTAMP()) >= ?`,
    [staleMinutes],
  );

  if (!staleSessions.length) {
    return NextResponse.json({
      success: true,
      message: 'No stale live-tracking sessions',
      count: 0,
      geofence_clockouts: geofenceClockouts,
    });
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

    await query(
      `UPDATE live_tracking_sessions
       SET is_active = FALSE, ended_at_utc = UTC_TIMESTAMP()
       WHERE id = ? AND is_active = TRUE`,
      [session.session_id],
    );

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

  return NextResponse.json({
    success: true,
    message: `Processed ${staleSessions.length} stale session(s)`,
    count: staleSessions.length,
    alerts_sent: alertsSent,
    geofence_clockouts: geofenceClockouts,
  });
}

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, insertAuditLog } from '@/lib/db';
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
}).refine(
  // Coordinates are mandatory for manual clock-outs; only the automatic
  // location-off path may omit them (location is off — no fix exists).
  d => (d.latitude != null && d.longitude != null) || d.auto === true,
  { message: 'latitude and longitude are required' },
);

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
      work_date: workDate,
      total_minutes: updated?.total_minutes ?? totalMinutes,
      status: newStatus,
      auto: parsed.data.auto === true,
      reason: parsed.data.reason ?? null,
    },
    ip_address: ip,
  });

  return NextResponse.json<ApiResponse<AttendanceRecord>>(
    { success: true, data: updated! },
  );
}

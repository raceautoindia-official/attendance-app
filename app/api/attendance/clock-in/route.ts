import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { isWithinGeofence } from '@/lib/geo';
import {
  getWorkDateIST,
  isLate,
  getClientIp,
  toMySQLDatetime,
} from '@/lib/attendance';
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
  grace_minutes: number;
  shift_type: string;
  shift_name: string;
  loc_lat: number | null;
  loc_lng: number | null;
  loc_radius: number | null;
  loc_name: string | null;
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

  // 2. Prevent duplicate clock-in
  const existing = await queryOne<{ id: number }>(
    `SELECT id FROM attendance WHERE employee_id = ? AND work_date = ?`,
    [auth.id, workDate],
  );
  if (existing) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Already clocked in today' },
      { status: 409 },
    );
  }

  // 3. Fetch active schedule (shift + location details via JOIN)
  const schedule = await queryOne<ActiveSchedule>(
    `SELECT
       es.id           AS schedule_id,
       es.shift_id,
       es.location_id,
       es.geofencing_enabled,
       s.start_time,
       s.end_time,
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
       AND es.effective_from <= CURDATE()
       AND (es.effective_to IS NULL OR es.effective_to >= CURDATE())
     ORDER BY es.effective_from DESC
     LIMIT 1`,
    [auth.id],
  );

  // 4. Geofence check
  let geofenceStatus: GeofenceStatus = 'not_required';

  if (
    schedule?.geofencing_enabled &&
    schedule.location_id &&
    schedule.loc_lat !== null &&
    schedule.loc_lng !== null
  ) {
    const inside = isWithinGeofence(
      lat,
      lng,
      schedule.loc_lat,
      schedule.loc_lng,
      schedule.loc_radius ?? 100,
    );
    geofenceStatus = inside ? 'inside' : 'outside';

    if (geofenceStatus === 'outside') {
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'You are outside the required location' },
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

  // 6. Insert attendance record
  const result = await query<{ insertId: number }>(
    `INSERT INTO attendance
       (employee_id, work_date, clock_in_utc, clock_in_lat, clock_in_lng,
        ip_address, geofence_status, auth_method, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'webauthn', ?)`,
    [
      auth.id,
      workDate,
      toMySQLDatetime(nowUtc),
      lat,
      lng,
      ip,
      geofenceStatus,
      status,
    ],
  );

  // mysql2 returns OkPacket-shaped result with insertId
  const insertId = (result as unknown as { insertId: number }).insertId ?? 0;

  // 7. Audit log
  await insertAuditLog({
    action: 'clock_in',
    entity: 'attendance',
    entity_id: insertId,
    performed_by: auth.id,
    details: { work_date: workDate, status, geofence_status: geofenceStatus },
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

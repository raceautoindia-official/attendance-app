import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { getWorkDateIST } from '@/lib/attendance';
import { hasWorkModeColumns } from '@/lib/employeeDetails';
import type { ApiResponse, AttendanceRecord, EmployeeSchedule } from '@/lib/types';

// ---------------------------------------------------------------------------
// GET /api/attendance/today
// Returns the authenticated employee's attendance record for today plus their
// active schedule (for displaying shift info in the UI).
// ---------------------------------------------------------------------------

interface TodayResponse {
  attendance: AttendanceRecord | null;
  schedule: EmployeeSchedule | null;
  /** Plant staff: may clock in again after completing a session today */
  multi_session: boolean;
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const workDate = getWorkDateIST();

  // Fetch the employee's current attendance: prefer an OPEN session (clocked in,
  // not clocked out) regardless of its work_date, so the dashboard correctly
  // shows "clocked in" even if the server clock/timezone has drifted. Fall back
  // to today's row (e.g. a completed session or an absent placeholder).
  const attendance = await queryOne<AttendanceRecord>(
    `SELECT a.*, e.name AS employee_name, e.emp_id
     FROM attendance a
     JOIN employees e ON a.employee_id = e.id
     WHERE a.employee_id = ?
       AND ((a.clock_in_utc IS NOT NULL AND a.clock_out_utc IS NULL) OR a.work_date = ?)
     ORDER BY (a.clock_in_utc IS NOT NULL AND a.clock_out_utc IS NULL) DESC,
              a.work_date DESC, a.clock_in_utc DESC
     LIMIT 1`,
    [auth.id, workDate],
  );

  // Fetch the active schedule for shift-info display
  const schedule = await queryOne<EmployeeSchedule>(
    `SELECT
       es.*,
       JSON_OBJECT(
         'id',             s.id,
         'name',           s.name,
         'type',           s.type,
         'start_time',     s.start_time,
         'end_time',       s.end_time,
         'required_hours', s.required_hours,
         'grace_minutes',  s.grace_minutes,
         'working_days',   s.working_days
       ) AS shift,
       IF(l.id IS NOT NULL,
         JSON_OBJECT(
           'id',             l.id,
           'name',           l.name,
           'latitude',       l.latitude,
           'longitude',      l.longitude,
           'radius_meters',  l.radius_meters
         ),
         NULL
       ) AS location
     FROM employee_schedules es
     JOIN shifts s ON es.shift_id = s.id
     LEFT JOIN locations l ON es.location_id = l.id
     WHERE es.employee_id = ?
       AND es.effective_from <= ?
       AND (es.effective_to IS NULL OR es.effective_to >= ?)
     ORDER BY es.effective_from DESC
     LIMIT 1`,
    [auth.id, workDate, workDate],
  );

  // mysql2 returns JSON columns as strings; parse them before sending
  if (schedule) {
    const s = schedule as unknown as Record<string, unknown>;
    try {
      if (typeof s.shift === 'string') s.shift = JSON.parse(s.shift as string);
    } catch { s.shift = null; }
    try {
      if (typeof s.location === 'string') s.location = JSON.parse(s.location as string);
    } catch { s.location = null; }
  }

  const multiSession = (await hasWorkModeColumns())
    ? !!Number(
        (await queryOne<{ allow_multiple_sessions: number | boolean }>(
          'SELECT allow_multiple_sessions FROM employees WHERE id = ?',
          [auth.id],
        ))?.allow_multiple_sessions ?? 0,
      )
    : false;

  return NextResponse.json<ApiResponse<TodayResponse>>(
    {
      success: true,
      data: {
        attendance: attendance ?? null,
        schedule: schedule ?? null,
        multi_session: multiSession,
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

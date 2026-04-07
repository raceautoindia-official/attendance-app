import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { getWorkDateIST } from '@/lib/attendance';
import type { ApiResponse, AttendanceRecord, EmployeeSchedule } from '@/lib/types';

// ---------------------------------------------------------------------------
// GET /api/attendance/today
// Returns the authenticated employee's attendance record for today plus their
// active schedule (for displaying shift info in the UI).
// ---------------------------------------------------------------------------

interface TodayResponse {
  attendance: AttendanceRecord | null;
  schedule: EmployeeSchedule | null;
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const workDate = getWorkDateIST();

  // Fetch today's attendance record (if any)
  const attendance = await queryOne<AttendanceRecord>(
    `SELECT a.*, e.name AS employee_name, e.emp_id
     FROM attendance a
     JOIN employees e ON a.employee_id = e.id
     WHERE a.employee_id = ? AND a.work_date = ?`,
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
       AND es.effective_from <= CURDATE()
       AND (es.effective_to IS NULL OR es.effective_to >= CURDATE())
     ORDER BY es.effective_from DESC
     LIMIT 1`,
    [auth.id],
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

  return NextResponse.json<ApiResponse<TodayResponse>>({
    success: true,
    data: {
      attendance: attendance ?? null,
      schedule: schedule ?? null,
    },
  });
}

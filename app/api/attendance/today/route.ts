import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { getWorkDateIST } from '@/lib/attendance';
import { hasWorkModeColumns } from '@/lib/employeeDetails';
import {
  activeOnDuty,
  creditedMinutes,
  emptyBalance,
  getMonthlyBalance,
  hasPermissionTable,
  requiredMinutesForShift,
} from '@/lib/permissions';
import { formatInTimeZone } from 'date-fns-tz';
import { TIMEZONE, MIN_FENCE_RADIUS_M } from '@/lib/constants';
import type {
  ApiResponse,
  AttendanceRecord,
  EmployeeSchedule,
  PermissionBalance,
  Shift,
} from '@/lib/types';

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
  /** Approved permission minutes for today */
  permission_minutes: number;
  /** The employee's permission entitlement for the current month */
  permission_balance: PermissionBalance;
  /** Approved out-of-office duty covering RIGHT NOW. While this is set the
   *  phone must not auto clock-out on leaving the work-site geofence. */
  on_duty_now: { start_time: string; end_time: string; reason: string | null } | null;
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
           -- The radius that will ACTUALLY be enforced, not the one typed into
           -- the admin form. The server raises a too-tight fence to
           -- MIN_FENCE_RADIUS_M before measuring anything against it, so
           -- sending the raw value would have the phone drawing one circle
           -- while the server judged against another.
           'radius_meters',  GREATEST(l.radius_meters, ${MIN_FENCE_RADIUS_M}),
           'radius_configured', l.radius_meters
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

  // Approved permission hours top today's worked time back up to the shift
  // length — see creditedMinutes() for the exact rule.
  const permissionsAvailable = await hasPermissionTable();
  let permissionMinutes = 0;
  if (permissionsAvailable && attendance) {
    const row = await queryOne<{ minutes: number | null }>(
      `SELECT COALESCE(SUM(minutes), 0) AS minutes
       FROM permission_requests
       WHERE employee_id = ? AND permission_date = ? AND status = 'approved'`,
      [auth.id, attendance.work_date],
    );
    permissionMinutes = Number(row?.minutes ?? 0);
  }

  const requiredMinutes = requiredMinutesForShift(
    (schedule as unknown as { shift?: Shift | null })?.shift ?? null,
  );

  if (attendance) {
    attendance.permission_minutes = permissionMinutes;
    attendance.required_minutes = requiredMinutes;
    attendance.credited_minutes = creditedMinutes(
      attendance.total_minutes,
      permissionMinutes,
      requiredMinutes,
    );
    // Hours on the day so far — banked sessions plus the open one — and how
    // much of that is beyond the rostered day. The phone shows both so someone
    // working late can see the extra time accruing rather than a figure pinned
    // at the shift length.
    const banked = Number(attendance.banked_minutes ?? 0);
    const worked = attendance.total_minutes ?? (banked > 0 ? banked : null);
    attendance.worked_minutes = worked;
    attendance.overtime_minutes =
      worked != null && requiredMinutes != null && worked > requiredMinutes
        ? worked - requiredMinutes
        : 0;
  }

  return NextResponse.json<ApiResponse<TodayResponse>>(
    {
      success: true,
      data: {
        attendance: attendance ?? null,
        schedule: schedule ?? null,
        multi_session: multiSession,
        permission_minutes: permissionMinutes,
        permission_balance: permissionsAvailable
          ? await getMonthlyBalance(auth.id, workDate)
          : emptyBalance(workDate),
        on_duty_now: permissionsAvailable
          ? await activeOnDuty(
              auth.id,
              workDate,
              formatInTimeZone(new Date(), TIMEZONE, 'HH:mm:ss'),
            )
          : null,
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

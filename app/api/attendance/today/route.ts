import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { getWorkDateIST } from '@/lib/attendance';
import { hasWorkModeColumns } from '@/lib/employeeDetails';
import {
  hasOnDutyColumn,
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
  /**
   * Permission requests reviewed in the last few days, so the PHONE can tell
   * the employee the verdict. There is no push server: the phone polls this
   * endpoint from the dashboard and the background watch anyway, raises a
   * local notification for any decision it has not announced yet, and keeps
   * its own record of which ids it has already announced. Without this, an
   * approval changed a status silently in a list nobody was looking at.
   */
  permission_updates: Array<{
    id: number;
    request_type: string;
    permission_date: string;
    start_time: string;
    end_time: string;
    status: string;
    review_notes: string | null;
    reviewed_at: string;
  }>;
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
           -- The radius the server will actually measure against, so the phone
           -- draws the same circle rather than one of its own. MIN_FENCE_RADIUS_M
           -- is 0 by default, so this is simply the site's configured radius.
           'radius_meters',  GREATEST(l.radius_meters, ${MIN_FENCE_RADIUS_M})
         ),
         NULL
       ) AS location
     FROM employee_schedules es
     JOIN shifts s ON es.shift_id = s.id
     LEFT JOIN locations l ON es.location_id = l.id AND l.is_active = TRUE
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

    // Did the away-from-site watchdog close this session?
    //
    // The phone needs to know, because auto clock-in on re-entry used to happen
    // only for a day the PHONE itself had closed. In practice the server's
    // watchdog is what closes these days — it is the half that works with the
    // app swiped away — and the phone treated that as "someone ended the day
    // deliberately", refused to re-open it, and tore its own geofence down. The
    // result was an employee clocked out for stepping away and never clocked
    // back in, on a phone that had also stopped watching.
    if (attendance.clock_out_utc) {
      const auto = await queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM audit_log
          WHERE action = 'geofence_auto_clockout'
            AND entity = 'attendance'
            AND entity_id = ?
            -- Tied to THIS closure, not an earlier session on the same row: a
            -- multi-session day reuses one attendance row all day.
            AND created_at >= DATE_SUB(?, INTERVAL 2 MINUTE)`,
        [attendance.id, attendance.clock_out_utc],
      );
      attendance.auto_clocked_out = Number(auto?.n ?? 0) > 0;
    } else {
      attendance.auto_clocked_out = false;
    }
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
        // Decisions from the last 3 days — wide enough to survive a phone that
        // was off overnight, small enough that the dedup set on the phone stays
        // tiny. Cancelled is excluded: the employee did that themselves.
        permission_updates: permissionsAvailable
          ? await query<TodayResponse['permission_updates'][number]>(
              `SELECT pr.id,
                      ${await hasOnDutyColumn() ? 'pr.request_type' : "'permission' AS request_type"},
                      DATE_FORMAT(pr.permission_date, '%Y-%m-%d') AS permission_date,
                      pr.start_time, pr.end_time, pr.status, pr.review_notes, pr.reviewed_at
               FROM permission_requests pr
               WHERE pr.employee_id = ?
                 AND pr.status IN ('approved', 'rejected')
                 AND pr.reviewed_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 DAY)
               ORDER BY pr.reviewed_at DESC
               LIMIT 20`,
              [auth.id],
            ).catch(() => [])
          : [],
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

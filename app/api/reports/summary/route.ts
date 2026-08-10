import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/lib/constants';
import {
  hasOnDutyColumn,
  hasPermissionTable,
  timeOffOnly,
} from '@/lib/permissions';
import { getPeriodDays } from '@/lib/periodDays';
import { companyHolidays, weekdayCounts, workingDaysFor } from '@/lib/workingDays';
import {
  dayRequiredMinutesSelect,
  expectedMinutesFor,
  hasMixedWorkingDays,
  overlappingShiftNames,
  shiftsForEmployees,
  totalShiftMinutes,
  workingWeekdays,
} from '@/lib/shifts';
import type { ApiResponse } from '@/lib/types';

interface EmployeeSummary {
  id: number;
  emp_id: string;
  name: string;
  total_days_present: number;
  total_days_late: number;
  total_days_absent: number;
  total_days_leave: number;
  total_minutes_worked: number;
  /** Approved permission minutes in the period */
  total_permission_minutes: number;
  /** Worked minutes topped up by permission, capped per day at the shift length */
  total_minutes_credited: number;
  /** Minutes worked beyond the rostered day, summed day by day */
  total_overtime_minutes: number;
  /** The employee's own shift length; null when they have no schedule */
  required_minutes_per_day: number | null;   // null when the shifts work different weekdays
  mixed_working_days: boolean;
  overlapping_shifts: string[] | null;
  /** Days THIS employee's shift works in the period (holidays removed) */
  working_days: number;
  /** working days × THIS employee's shift; null when they have no schedule */
  expected_minutes: number | null;
  days_with_hours: number;
}

// GET /api/reports/summary — manager | super_admin, paginated
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);

  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
  const limit = Math.min(
    Math.max(1, parseInt(searchParams.get('limit') ?? String(DEFAULT_PAGE_SIZE), 10)),
    MAX_PAGE_SIZE,
  );
  const offset = (page - 1) * limit;

  const fromDate = searchParams.get('from_date');
  const toDate = searchParams.get('to_date');
  const employeeId = searchParams.get('employee_id');
  const employeeFilterId =
    employeeId && !Number.isNaN(parseInt(employeeId, 10))
      ? parseInt(employeeId, 10)
      : null;

  if (!fromDate || !toDate) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'from_date and to_date are required (YYYY-MM-DD)' },
      { status: 400 },
    );
  }

  const conditions: string[] = ['e.is_active = TRUE'];
  const conditionParams: unknown[] = [];

  if (auth.role === 'manager') {
    conditions.push('e.manager_id = ?');
    conditionParams.push(auth.id);
  }

  if (employeeFilterId !== null) {
    conditions.push('e.id = ?');
    conditionParams.push(employeeFilterId);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  // Approved permission minutes per employee per day. Credited hours cap each
  // day at the standard shift length (see lib/permissions.creditedMinutes) —
  // permission tops a short day back up, it never inflates one past the shift.
  // On-duty rows are excluded throughout: that is work being clocked, not time
  // off, so it neither tops up hours nor appears as permission taken.
  const [permissionsAvailable, hasType] = await Promise.all([
    hasPermissionTable(),
    hasOnDutyColumn(),
  ]);
  const permissionJoin = permissionsAvailable
    ? `LEFT JOIN (
         SELECT employee_id, permission_date, SUM(minutes) AS minutes
         FROM permission_requests
         WHERE status = 'approved' AND permission_date BETWEEN ? AND ?
           ${timeOffOnly(hasType)}
         GROUP BY employee_id, permission_date
       ) p ON p.employee_id = a.employee_id AND p.permission_date = a.work_date`
    : '';
  const permissionJoinParams = permissionsAvailable ? [fromDate, toDate] : [];
  const dayPermissionExpr = permissionsAvailable ? 'COALESCE(p.minutes, 0)' : '0';
  const totalPermissionExpr = permissionsAvailable
    ? `COALESCE((
         SELECT SUM(pr.minutes)
         FROM permission_requests pr
         WHERE pr.employee_id = e.id
           AND pr.status = 'approved'
           ${timeOffOnly(hasType, 'pr')}
           AND pr.permission_date BETWEEN ? AND ?
       ), 0)`
    : '0';
  const totalPermissionParams = permissionsAvailable ? [fromDate, toDate] : [];

  const [countRow, rows, workingDaysRow, leaveDaysRow] = await Promise.all([
    queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM employees e ${where}`,
      conditionParams,
    ),
    query<EmployeeSummary>(
      `SELECT
         e.id,
         e.emp_id,
         e.name,
         COALESCE(SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END), 0)            AS total_days_present,
         COALESCE(SUM(CASE WHEN a.status = 'late'    THEN 1 ELSE 0 END), 0)            AS total_days_late,
         COALESCE(SUM(CASE WHEN a.status = 'absent'  THEN 1 ELSE 0 END), 0)            AS total_days_absent,
         (
           SELECT COUNT(DISTINCT lr.leave_date)
           FROM leave_records lr
           WHERE lr.employee_id = e.id
             AND lr.leave_date BETWEEN ? AND ?
             AND lr.leave_type <> 'holiday'
         ) +
         COALESCE(COUNT(DISTINCT CASE
           WHEN a.status = 'leave'
            AND NOT EXISTS (
              SELECT 1
              FROM leave_records lr2
              WHERE lr2.employee_id = e.id
                AND lr2.leave_date = a.work_date
                AND lr2.leave_type <> 'holiday'
            )
           THEN a.work_date
         END), 0)                                                                  AS total_days_leave,
         COALESCE(SUM(a.total_minutes), 0)                                              AS total_minutes_worked,
         ${totalPermissionExpr}                                                         AS total_permission_minutes,
         COALESCE(SUM(
           CASE
             WHEN a.total_minutes IS NULL THEN 0
             ELSE LEAST(
                    a.total_minutes + ${dayPermissionExpr},
                    GREATEST(a.total_minutes, ${dayRequiredMinutesSelect('a.employee_id', 'a.work_date')})
                  )
           END
         ), 0)                                                                          AS total_minutes_credited,
         -- Hours worked BEYOND the day's roster, summed per day so a long day
         -- is not cancelled out by a short one. This is the part the credited
         -- figure caps away, and what "worked extra" means on a report.
         COALESCE(SUM(GREATEST(0,
           COALESCE(a.total_minutes, 0) - ${dayRequiredMinutesSelect('a.employee_id', 'a.work_date')}
         )), 0)                                                                         AS total_overtime_minutes,
         COUNT(CASE WHEN a.total_minutes IS NOT NULL THEN 1 END)                        AS days_with_hours
       FROM employees e
       LEFT JOIN attendance a
         ON a.employee_id = e.id
         AND a.work_date BETWEEN ? AND ?
       ${permissionJoin}
       ${where}
       GROUP BY e.id
       ORDER BY e.name ASC
       LIMIT ? OFFSET ?`,
      [
        fromDate, toDate,                 // leave-days subquery
        ...totalPermissionParams,         // approved-permission subquery
        fromDate, toDate,                 // attendance join
        ...permissionJoinParams,          // per-day permission join
        ...conditionParams,
        limit, offset,
      ],
    ),
    getPeriodDays(fromDate, toDate),
    queryOne<{ total_leave_days: number }>(
      `SELECT COUNT(*) AS total_leave_days
       FROM leave_records lr
       JOIN employees e ON e.id = lr.employee_id
       WHERE lr.leave_date BETWEEN ? AND ?
         AND lr.leave_type <> 'holiday'
         AND e.is_active = TRUE
         ${auth.role === 'manager' ? 'AND e.manager_id = ?' : ''}
         ${employeeFilterId !== null ? 'AND e.id = ?' : ''}`,
      [
        fromDate,
        toDate,
        ...(auth.role === 'manager' ? [auth.id] : []),
        ...(employeeFilterId !== null ? [employeeFilterId] : []),
      ],
    ),
  ]);

  const total = Number(countRow?.total ?? 0);
  const workingDays = Number(workingDaysRow?.total_working_days ?? 0);

  // SUM() comes back as a DECIMAL string from mysql2 — hand the clients numbers.
  // Expected hours are the employee's OWN shift length × the days THAT SHIFT
  // works. Counting the employee's own working days is what keeps a Saturday
  // absence consistent with the hours they were expected to put in — the absent
  // job reads the same shift.
  const counts = weekdayCounts(fromDate, toDate);
  const holidays = await companyHolidays(fromDate, toDate);

  // Resolve every shift each listed employee is rostered on. A double-shift
  // employee has two rows here, so their per-day requirement is the SUM and
  // their working days are the UNION.
  const pageShifts = await shiftsForEmployees(rows.map(r => r.id), toDate);

  const summary = rows.map(r => {
    const shifts = pageShifts.get(r.id) ?? [];
    const perDay = totalShiftMinutes(shifts);
    const ownWorkingDays = workingDaysFor(workingWeekdays(shifts), counts, holidays);
    // Counted weekday by weekday, not perDay × days: when two shifts work
    // different weekdays there is no single per-day figure to multiply.
    const mixed = hasMixedWorkingDays(shifts);
    const overlaps = overlappingShiftNames(shifts);
    return {
      ...r,
      total_minutes_worked: Number(r.total_minutes_worked ?? 0),
      total_permission_minutes: Number(r.total_permission_minutes ?? 0),
      total_minutes_credited: Number(r.total_minutes_credited ?? 0),
      total_overtime_minutes: Number(r.total_overtime_minutes ?? 0),
      required_minutes_per_day: mixed ? null : perDay,
      shift_count: shifts.length,
      shift_names: shifts.map(s => s.name),
      mixed_working_days: mixed,
      overlapping_shifts: overlaps.length ? overlaps : null,
      working_days: ownWorkingDays,
      expected_minutes: perDay == null ? null : expectedMinutesFor(shifts, counts, holidays),
      days_with_hours: Number(r.days_with_hours ?? 0),
    };
  });

  // Period totals across EVERY employee in scope, not just the current page —
  // otherwise "total working hours" would change as the admin pages through.
  const [totalsRow, permissionTotalRow, expectedTotalRow] = await Promise.all([
    queryOne<{
      minutes_worked: number | null;
      minutes_credited: number | null;
    }>(
      `SELECT
         COALESCE(SUM(a.total_minutes), 0) AS minutes_worked,
         COALESCE(SUM(
           CASE
             WHEN a.total_minutes IS NULL THEN 0
             ELSE LEAST(
                    a.total_minutes + ${dayPermissionExpr},
                    GREATEST(a.total_minutes, ${dayRequiredMinutesSelect('a.employee_id', 'a.work_date')})
                  )
           END
         ), 0) AS minutes_credited
       FROM employees e
       LEFT JOIN attendance a
         ON a.employee_id = e.id
         AND a.work_date BETWEEN ? AND ?
       ${permissionJoin}
       ${where}`,
      [fromDate, toDate, ...permissionJoinParams, ...conditionParams],
    ),
    // Counted straight off permission_requests, NOT off the attendance join:
    // permission approved for a day with no attendance row yet (typically one
    // booked ahead) still belongs in the period's approved total. Joining
    // through attendance silently dropped those, so this figure disagreed with
    // the sum of the per-employee column.
    permissionsAvailable
      ? queryOne<{ minutes: number | null }>(
          `SELECT COALESCE(SUM(pr.minutes), 0) AS minutes
           FROM permission_requests pr
           JOIN employees e ON e.id = pr.employee_id
           WHERE pr.status = 'approved'
             ${timeOffOnly(hasType, 'pr')}
             AND pr.permission_date BETWEEN ? AND ?
             AND ${conditions.join(' AND ')}`,
          [fromDate, toDate, ...conditionParams],
        )
      : Promise.resolve(null),
    // Expected hours for everyone in scope: each employee's OWN shift length
    // over their OWN working days. Returned per employee and summed below,
    // because working days now differ between shifts. Employees with no
    // schedule contribute nothing — inventing hours for them would be a guess.
    // Just the ids — their shifts are resolved in one batch below, which is
    // what lets a double-shift employee contribute BOTH shift lengths.
    query<{ id: number }>(`SELECT e.id FROM employees e ${where}`, conditionParams),
  ]);

  // Roll the per-employee expectations up across everyone in scope, not just
  // the current page, so paging never changes the header figure. A double-shift
  // employee contributes BOTH shift lengths, over the union of days those
  // shifts work.
  const allShifts = await shiftsForEmployees(
    (expectedTotalRow ?? []).map(e => e.id),
    toDate,
  );
  let expectedTotalMinutes = 0;
  let employeesWithShift = 0;
  for (const e of expectedTotalRow ?? []) {
    const shifts = allShifts.get(e.id);
    if (totalShiftMinutes(shifts) == null) continue;
    employeesWithShift++;
    expectedTotalMinutes += expectedMinutesFor(shifts!, counts, holidays);
  }

  return NextResponse.json<ApiResponse<{
    summary: EmployeeSummary[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
    period: {
      from_date: string;
      to_date: string;
      total_days: number;
      weekend_days: number;
      festive_holidays: number;
      total_working_days: number;
      total_leave_days: number;
    };
    totals: {
      employees: number;
      /** Employees whose shift length is known (the rest have no schedule) */
      employees_with_shift: number;
      /** Sum over employees of (their shift length × working days) */
      expected_minutes: number;
      minutes_worked: number;
      permission_minutes: number;
      minutes_credited: number;
    };
  }>>({
    success: true,
    data: {
      summary,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      totals: {
        employees: total,
        employees_with_shift: employeesWithShift,
        // Sum over employees of (their shift length × their own working days).
        // No flat 9-hour day and no shared working-day count.
        expected_minutes: expectedTotalMinutes,
        minutes_worked: Number(totalsRow?.minutes_worked ?? 0),
        permission_minutes: Number(permissionTotalRow?.minutes ?? 0),
        minutes_credited: Number(totalsRow?.minutes_credited ?? 0),
      },
      period: {
        from_date: fromDate,
        to_date: toDate,
        total_days: Number(workingDaysRow?.total_days ?? 0),
        weekend_days: Number(workingDaysRow?.weekend_days ?? 0),
        festive_holidays: Number(workingDaysRow?.festive_holidays ?? 0),
        total_working_days: workingDays,
        total_leave_days: Number(leaveDaysRow?.total_leave_days ?? 0),
      },
    },
  });
}

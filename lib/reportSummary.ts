import { query, queryOne } from '@/lib/db';
import { OVERTIME_AFTER_MINUTES } from '@/lib/constants';
import { hasOnDutyColumn, hasPermissionTable, timeOffOnly } from '@/lib/permissions';
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
import { hasWorkModeColumns, workModeSelect, hasDailyUpdatesTable, hasFirstClockInColumn } from '@/lib/employeeDetails';
import { lateMinutes } from '@/lib/attendance';

// ---------------------------------------------------------------------------
// The per-employee attendance summary for a date range — one row per
// employee, everything the Reports page's Summary tab and the JSON API both
// need to show it.
//
// Pulled out of app/api/reports/summary/route.ts so a second consumer (the
// Excel export) computes the SAME figures through the SAME queries, rather
// than a hand-copied second implementation that drifts the first time credited
// hours or late-minutes logic changes here and not there.
// ---------------------------------------------------------------------------

/** Calendar days from one YYYY-MM-DD to another, both ends included. */
function daysInclusive(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}

export interface EmployeeSummary {
  id: number;
  emp_id: string;
  name: string;
  work_mode: string;
  daily_updates_count: number;
  calendar_days: number;
  company_holidays: number;
  weekly_off_days: number;
  late_minutes: number;
  late_days: number;
  attendance_percentage: number | null;
  total_days_present: number;
  total_days_late: number;
  total_days_absent: number;
  total_days_leave: number;
  total_minutes_worked: number;
  total_permission_minutes: number;
  total_minutes_credited: number;
  total_overtime_minutes: number;
  required_minutes_per_day: number | null;
  mixed_working_days: boolean;
  overlapping_shifts: string[] | null;
  working_days: number;
  expected_minutes: number | null;
  days_with_hours: number;
  shift_count?: number;
  shift_names?: string[];
}

export interface SummaryReportParams {
  fromDate: string;
  toDate: string;
  /** Non-null narrows to one employee. */
  employeeFilterId: number | null;
  /** Non-null scopes to a manager's own reports. */
  managerId: number | null;
  /** Omit both for every matching employee, unpaginated (the Excel export's shape). */
  page?: number;
  limit?: number;
}

export interface SummaryReportResult {
  summary: EmployeeSummary[];
  total: number;
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
    employees_with_shift: number;
    expected_minutes: number;
    minutes_worked: number;
    permission_minutes: number;
    minutes_credited: number;
  };
}

export async function computeSummaryReport(params: SummaryReportParams): Promise<SummaryReportResult> {
  const { fromDate, toDate, employeeFilterId, managerId } = params;

  const conditions: string[] = ['e.is_active = TRUE'];
  const conditionParams: unknown[] = [];
  if (managerId != null) {
    conditions.push('e.manager_id = ?');
    conditionParams.push(managerId);
  }
  if (employeeFilterId !== null) {
    conditions.push('e.id = ?');
    conditionParams.push(employeeFilterId);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;

  const [permissionsAvailable, hasType, workModeCols, updatesTable, firstInCol] = await Promise.all([
    hasPermissionTable(),
    hasOnDutyColumn(),
    hasWorkModeColumns(),
    hasDailyUpdatesTable(),
    hasFirstClockInColumn(),
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

  // Pagination is optional: the on-screen JSON API pages, the Excel export
  // wants every row in one pass. LIMIT -1 is not portable across engines, so
  // the clause itself is only added when a page/limit was actually asked for.
  const paginated = params.page != null && params.limit != null;
  const limit = params.limit ?? 0;
  const offset = paginated ? (params.page! - 1) * limit : 0;
  const limitClause = paginated ? 'LIMIT ? OFFSET ?' : '';
  const limitParams = paginated ? [limit, offset] : [];

  const [countRow, rows, workingDaysRow, leaveDaysRow] = await Promise.all([
    queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM employees e ${where}`, conditionParams),
    query<EmployeeSummary>(
      `SELECT
         e.id,
         e.emp_id,
         e.name,
         ${workModeSelect(workModeCols)},
         ${updatesTable ? `(SELECT COUNT(DISTINCT dwu.work_date)
              FROM daily_work_updates dwu
             WHERE dwu.employee_id = e.id
               AND dwu.work_date BETWEEN ? AND ?)` : '0'} AS daily_updates_count,
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
         COALESCE(SUM(GREATEST(0,
           COALESCE(a.total_minutes, 0) - ${OVERTIME_AFTER_MINUTES}
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
       ${limitClause}`,
      [
        ...(updatesTable ? [fromDate, toDate] : []),
        fromDate, toDate,
        ...totalPermissionParams,
        fromDate, toDate,
        ...permissionJoinParams,
        ...conditionParams,
        ...limitParams,
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
         ${managerId != null ? 'AND e.manager_id = ?' : ''}
         ${employeeFilterId !== null ? 'AND e.id = ?' : ''}`,
      [
        fromDate,
        toDate,
        ...(managerId != null ? [managerId] : []),
        ...(employeeFilterId !== null ? [employeeFilterId] : []),
      ],
    ),
  ]);

  const total = Number(countRow?.total ?? 0);
  const workingDays = Number(workingDaysRow?.total_working_days ?? 0);
  const counts = weekdayCounts(fromDate, toDate);
  const holidays = await companyHolidays(fromDate, toDate);
  const pageShifts = await shiftsForEmployees(rows.map(r => r.id), toDate);

  const lateRows = rows.length
    ? await query<{
        employee_id: number; first_in: string | null;
        shift_start_time: string | null; shift_grace_minutes: number | null; shift_type: string | null;
      }>(
        `SELECT a.employee_id,
                ${firstInCol ? 'COALESCE(a.first_clock_in_utc, a.clock_in_utc)' : 'a.clock_in_utc'} AS first_in,
                s.start_time AS shift_start_time, s.grace_minutes AS shift_grace_minutes,
                s.type AS shift_type
           FROM attendance a
           LEFT JOIN employee_schedules es ON es.id = (
             SELECT es2.id FROM employee_schedules es2
              WHERE es2.employee_id = a.employee_id
                AND es2.effective_from <= a.work_date
                AND (es2.effective_to IS NULL OR es2.effective_to >= a.work_date)
              ORDER BY es2.effective_from DESC, es2.id DESC LIMIT 1)
           LEFT JOIN shifts s ON s.id = es.shift_id
          WHERE a.clock_in_utc IS NOT NULL
            AND a.work_date BETWEEN ? AND ?
            AND a.employee_id IN (${rows.map(() => '?').join(',')})`,
        [fromDate, toDate, ...rows.map(r => r.id)],
      )
    : [];

  const lateByEmployee = new Map<number, { minutes: number; days: number }>();
  for (const lr of lateRows) {
    const mins = lateMinutes(
      lr.first_in ? new Date(lr.first_in) : null,
      lr.shift_start_time, lr.shift_grace_minutes, lr.shift_type,
    );
    if (mins == null || mins <= 0) continue;
    const acc = lateByEmployee.get(lr.employee_id) ?? { minutes: 0, days: 0 };
    acc.minutes += mins;
    acc.days += 1;
    lateByEmployee.set(lr.employee_id, acc);
  }

  const calendarDays = daysInclusive(fromDate, toDate);

  const summary: EmployeeSummary[] = rows.map(r => {
    const shifts = pageShifts.get(r.id) ?? [];
    const perDay = totalShiftMinutes(shifts);
    const ownWorkingDays = workingDaysFor(workingWeekdays(shifts), counts, holidays);
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
      calendar_days: calendarDays,
      company_holidays: holidays.length,
      weekly_off_days: Math.max(0, calendarDays - ownWorkingDays - holidays.length),
      late_minutes: lateByEmployee.get(r.id)?.minutes ?? 0,
      late_days: lateByEmployee.get(r.id)?.days ?? 0,
      attendance_percentage: ownWorkingDays > 0
        ? Math.round(
            ((Number(r.total_days_present ?? 0) + Number(r.total_days_late ?? 0))
              / ownWorkingDays) * 1000,
          ) / 10
        : null,
    };
  });

  const [totalsRow, permissionTotalRow, expectedTotalRow] = await Promise.all([
    queryOne<{ minutes_worked: number | null; minutes_credited: number | null }>(
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
    query<{ id: number }>(`SELECT e.id FROM employees e ${where}`, conditionParams),
  ]);

  const allShifts = await shiftsForEmployees((expectedTotalRow ?? []).map(e => e.id), toDate);
  let expectedTotalMinutes = 0;
  let employeesWithShift = 0;
  for (const e of expectedTotalRow ?? []) {
    const shifts = allShifts.get(e.id);
    if (totalShiftMinutes(shifts) == null) continue;
    employeesWithShift++;
    expectedTotalMinutes += expectedMinutesFor(shifts!, counts, holidays);
  }

  return {
    summary,
    total,
    period: {
      from_date: fromDate,
      to_date: toDate,
      total_days: Number(workingDaysRow?.total_days ?? 0),
      weekend_days: Number(workingDaysRow?.weekend_days ?? 0),
      festive_holidays: Number(workingDaysRow?.festive_holidays ?? 0),
      total_working_days: workingDays,
      total_leave_days: Number(leaveDaysRow?.total_leave_days ?? 0),
    },
    totals: {
      employees: total,
      employees_with_shift: employeesWithShift,
      expected_minutes: expectedTotalMinutes,
      minutes_worked: Number(totalsRow?.minutes_worked ?? 0),
      permission_minutes: Number(permissionTotalRow?.minutes ?? 0),
      minutes_credited: Number(totalsRow?.minutes_credited ?? 0),
    },
  };
}

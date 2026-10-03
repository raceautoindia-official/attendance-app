/**
 * lib/chat/tools/attendance.ts — attendance statistics for the admin chat.
 *
 * CORRECTNESS NOTE (do not "optimise" this away):
 *   Worked minutes are SUM(a.total_minutes) ONLY.
 *   `attendance.total_minutes` is already cumulative for multi-session (plant)
 *   staff — lib/closeSessions.ts sets it to `banked_minutes + current session`.
 *   Writing SUM(total_minutes + banked_minutes) double-counts every plant
 *   worker's hours. This mirrors app/api/reports/summary/route.ts, which stays
 *   the independent cross-check on these figures.
 */

import { query, queryOne } from '@/lib/db';
import {
  resolveRange,
  minutesToHours,
  toIstTime,
  toYmdString,
  type RangeInput,
} from '../dates';
import {
  requireSuperAdmin,
  type ChatContext,
  type DateRange,
  type ToolResult,
} from '../types';
import {
  fetchCompanyHolidays,
  classifyAttendanceRow,
  DAY_KIND_LABEL,
} from '@/lib/reportClassification';

/** Filters shared by the group-level tools. */
export interface ScopeArgs extends RangeInput {
  employee_ids?: number[];
  department?: string;
  include_inactive?: boolean;
}

/** Build the employees-table WHERE fragment from validated args. */
function employeeScope(args: ScopeArgs): { sql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (!args.include_inactive) conditions.push('e.is_active = TRUE');

  const ids = (args.employee_ids ?? []).filter(n => Number.isInteger(n));
  if (ids.length > 0) {
    conditions.push(`e.id IN (${ids.map(() => '?').join(', ')})`);
    params.push(...ids);
  }

  if (args.department) {
    conditions.push('e.department = ?');
    params.push(args.department);
  }

  return {
    sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

/**
 * Count clock-ins still open in the range. Their `total_minutes` is not final,
 * so any answer covering them must be flagged as provisional.
 */
async function openSessionNote(
  range: DateRange,
  scope: { sql: string; params: unknown[] },
): Promise<string[] | undefined> {
  const row = await queryOne<{ open_count: number }>(
    `SELECT COUNT(*) AS open_count
       FROM attendance a
       JOIN employees e ON e.id = a.employee_id
      ${scope.sql ? scope.sql + ' AND' : 'WHERE'} a.work_date BETWEEN ? AND ?
        AND a.clock_in_utc IS NOT NULL
        AND a.clock_out_utc IS NULL`,
    [...scope.params, range.from, range.to],
  );
  const open = Number(row?.open_count ?? 0);
  return open > 0
    ? [
        `${open} clock-in session(s) in this period are still open, so worked-hours figures for those days are provisional.`,
      ]
    : undefined;
}

export interface PeriodInfo {
  total_days: number;
  weekend_days: number;
  festive_holidays: number;
  total_working_days: number;
}

/**
 * Calendar shape of the range: weekends and company-wide holidays excluded.
 * Mirrors app/api/reports/summary/route.ts so both agree on what a
 * "working day" is.
 */
export async function getWorkingDays(range: DateRange): Promise<PeriodInfo> {
  const row = await queryOne<PeriodInfo>(
    `WITH RECURSIVE date_range AS (
       SELECT CAST(? AS DATE) AS d
       UNION ALL
       SELECT DATE_ADD(d, INTERVAL 1 DAY) FROM date_range WHERE d < CAST(? AS DATE)
     )
     SELECT
       COUNT(*)                                                   AS total_days,
       SUM(CASE WHEN DAYOFWEEK(dr.d) IN (1, 7) THEN 1 ELSE 0 END) AS weekend_days,
       SUM(CASE WHEN EXISTS (
         SELECT 1 FROM leave_records lr
          WHERE lr.leave_date = dr.d AND lr.employee_id IS NULL
            AND lr.leave_type = 'holiday') THEN 1 ELSE 0 END)     AS festive_holidays,
       SUM(CASE
             WHEN DAYOFWEEK(dr.d) IN (1, 7) THEN 0
             WHEN EXISTS (
               SELECT 1 FROM leave_records lr
                WHERE lr.leave_date = dr.d AND lr.employee_id IS NULL
                  AND lr.leave_type = 'holiday') THEN 0
             ELSE 1
           END)                                                   AS total_working_days
     FROM date_range dr`,
    [range.from, range.to],
  );
  return {
    total_days: Number(row?.total_days ?? 0),
    weekend_days: Number(row?.weekend_days ?? 0),
    festive_holidays: Number(row?.festive_holidays ?? 0),
    total_working_days: Number(row?.total_working_days ?? 0),
  };
}

export interface AttendanceSummaryRow {
  id: number;
  emp_id: string;
  name: string;
  department: string | null;
  days_present: number;
  days_late: number;
  days_absent: number;
  days_leave: number;
  days_with_hours: number;
  total_minutes_worked: number;
  hours_worked_display: string;
}

/**
 * Per-employee attendance totals over a range — the workhorse for
 * "give me X's report" and "report for the Plant team".
 */
export async function getAttendanceSummary(
  ctx: ChatContext,
  args: ScopeArgs = {},
): Promise<ToolResult<AttendanceSummaryRow> & { period: PeriodInfo }> {
  requireSuperAdmin(ctx);

  const range = resolveRange(args);
  const scope = employeeScope(args);

  const rows = await query<Omit<AttendanceSummaryRow, 'hours_worked_display'>>(
    `SELECT
       e.id, e.emp_id, e.name, e.department,
       COALESCE(SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END), 0) AS days_present,
       COALESCE(SUM(CASE WHEN a.status = 'late'    THEN 1 ELSE 0 END), 0) AS days_late,
       COALESCE(SUM(CASE WHEN a.status = 'absent'  THEN 1 ELSE 0 END), 0) AS days_absent,
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
            SELECT 1 FROM leave_records lr2
             WHERE lr2.employee_id = e.id
               AND lr2.leave_date = a.work_date
               AND lr2.leave_type <> 'holiday')
         THEN a.work_date
       END), 0)                                                          AS days_leave,
       COUNT(CASE WHEN a.total_minutes IS NOT NULL THEN 1 END)           AS days_with_hours,
       COALESCE(SUM(a.total_minutes), 0)                                 AS total_minutes_worked
     FROM employees e
     LEFT JOIN attendance a
            ON a.employee_id = e.id
           AND a.work_date BETWEEN ? AND ?
     ${scope.sql}
     GROUP BY e.id
     ORDER BY e.name ASC
     LIMIT 200`,
    [range.from, range.to, range.from, range.to, ...scope.params],
  );

  const [period, notes] = await Promise.all([
    getWorkingDays(range),
    openSessionNote(range, scope),
  ]);

  return {
    range,
    period,
    count: rows.length,
    notes,
    rows: rows.map(r => ({
      ...r,
      total_minutes_worked: Number(r.total_minutes_worked),
      hours_worked_display: minutesToHours(Number(r.total_minutes_worked)),
    })),
  };
}

export interface AttendanceDetailRow {
  work_date: string;
  status: string;
  /**
   * Human label distinguishing a weekly off from a government holiday — both
   * are stored as status 'holiday'. Without this the assistant reported a
   * Sunday as a "holiday", matching the bug the reports had.
   */
  day_type: string;
  clock_in_ist: string;
  clock_out_ist: string;
  minutes_worked: number | null;
  hours_display: string;
  session_count: number;
  geofence_status: string;
  is_open: boolean;
  notes: string | null;
}

/** Day-by-day attendance for one employee. */
export async function getAttendanceDetail(
  ctx: ChatContext,
  args: { employee_id: number } & RangeInput,
): Promise<ToolResult<AttendanceDetailRow>> {
  requireSuperAdmin(ctx);

  const range = resolveRange(args);
  const companyHolidays = await fetchCompanyHolidays(range.from, range.to);

  const rows = await query<{
    work_date: Date | string;
    status: string;
    clock_in_utc: Date | null;
    clock_out_utc: Date | null;
    total_minutes: number | null;
    session_count: number;
    geofence_status: string;
    notes: string | null;
  }>(
    `SELECT a.work_date, a.status, a.clock_in_utc, a.clock_out_utc,
            a.total_minutes, a.session_count, a.geofence_status, a.notes
       FROM attendance a
      WHERE a.employee_id = ?
        AND a.work_date BETWEEN ? AND ?
      ORDER BY a.work_date ASC
      LIMIT 400`,
    [args.employee_id, range.from, range.to],
  );

  return {
    range,
    count: rows.length,
    rows: rows.map(r => ({
      work_date: toYmdString(r.work_date),
      status: r.status,
      day_type: DAY_KIND_LABEL[
        classifyAttendanceRow(r.status, r.work_date, companyHolidays)
      ],
      clock_in_ist: toIstTime(r.clock_in_utc),
      clock_out_ist: toIstTime(r.clock_out_utc),
      minutes_worked: r.total_minutes == null ? null : Number(r.total_minutes),
      hours_display: minutesToHours(r.total_minutes),
      session_count: Number(r.session_count ?? 1),
      geofence_status: r.geofence_status,
      is_open: r.clock_in_utc != null && r.clock_out_utc == null,
      notes: r.notes,
    })),
  };
}

export interface DailySnapshotRow {
  emp_id: string;
  name: string;
  department: string | null;
  status: string;
  /** Week Off vs Holiday — both stored as status 'holiday'. */
  day_type: string;
  clock_in_ist: string;
  clock_out_ist: string;
  hours_display: string;
}

/** Who was present / late / absent / on leave on a single date. */
export async function getDailySnapshot(
  ctx: ChatContext,
  args: { date?: string; department?: string } = {},
): Promise<
  ToolResult<DailySnapshotRow> & {
    totals: Record<string, number>;
    no_record_count: number;
  }
> {
  requireSuperAdmin(ctx);

  const range = resolveRange(
    args.date
      ? { from_date: args.date, to_date: args.date }
      : { preset: 'today' },
  );
  const scope = employeeScope({ department: args.department });
  const companyHolidays = await fetchCompanyHolidays(range.from, range.to);

  const rows = await query<{
    emp_id: string;
    name: string;
    department: string | null;
    status: string | null;
    clock_in_utc: Date | null;
    clock_out_utc: Date | null;
    total_minutes: number | null;
  }>(
    `SELECT e.emp_id, e.name, e.department,
            a.status, a.clock_in_utc, a.clock_out_utc, a.total_minutes
       FROM employees e
       LEFT JOIN attendance a
              ON a.employee_id = e.id AND a.work_date = ?
       ${scope.sql}
       ORDER BY e.name ASC
       LIMIT 400`,
    [range.from, ...scope.params],
  );

  const totals: Record<string, number> = {};
  let noRecord = 0;
  for (const r of rows) {
    if (!r.status) {
      noRecord += 1;
      continue;
    }
    // Key the totals by day KIND, not raw status, so "3 on holiday" can never
    // actually mean "3 on their weekly off".
    const kind = classifyAttendanceRow(r.status, range.from, companyHolidays);
    totals[kind] = (totals[kind] ?? 0) + 1;
  }

  return {
    range,
    count: rows.length,
    totals,
    no_record_count: noRecord,
    notes:
      noRecord > 0
        ? [`${noRecord} employee(s) have no attendance row for this date at all.`]
        : undefined,
    rows: rows.map(r => ({
      emp_id: r.emp_id,
      name: r.name,
      department: r.department,
      status: r.status ?? 'no_record',
      day_type: r.status
        ? DAY_KIND_LABEL[classifyAttendanceRow(r.status, range.from, companyHolidays)]
        : 'No record',
      clock_in_ist: toIstTime(r.clock_in_utc),
      clock_out_ist: toIstTime(r.clock_out_utc),
      hours_display: minutesToHours(r.total_minutes),
    })),
  };
}

export interface RankedRow {
  emp_id: string;
  name: string;
  department: string | null;
  day_count: number;
}

async function rankByStatus(
  args: ScopeArgs,
  status: 'late' | 'absent',
): Promise<ToolResult<RankedRow>> {
  const range = resolveRange(args);
  const scope = employeeScope(args);

  const rows = await query<RankedRow>(
    `SELECT e.emp_id, e.name, e.department, COUNT(*) AS day_count
       FROM attendance a
       JOIN employees e ON e.id = a.employee_id
      ${scope.sql ? scope.sql + ' AND' : 'WHERE'} a.work_date BETWEEN ? AND ?
        AND a.status = ?
      GROUP BY e.id
      ORDER BY day_count DESC, e.name ASC
      LIMIT 200`,
    [...scope.params, range.from, range.to, status],
  );

  return {
    range,
    count: rows.length,
    rows: rows.map(r => ({ ...r, day_count: Number(r.day_count) })),
    notes: rows.length === 0 ? [`No ${status} records in this period.`] : undefined,
  };
}

/** Employees ranked by late days over a range. */
export async function getLateArrivals(
  ctx: ChatContext,
  args: ScopeArgs = {},
): Promise<ToolResult<RankedRow>> {
  requireSuperAdmin(ctx);
  return rankByStatus(args, 'late');
}

/** Employees ranked by absent days over a range. */
export async function getAbsentees(
  ctx: ChatContext,
  args: ScopeArgs = {},
): Promise<ToolResult<RankedRow>> {
  requireSuperAdmin(ctx);
  return rankByStatus(args, 'absent');
}

export interface DepartmentRollupRow {
  department: string;
  employee_count: number;
  days_present: number;
  days_late: number;
  days_absent: number;
  total_minutes_worked: number;
  hours_worked_display: string;
  avg_minutes_per_present_day: number;
}

/** Department-level statistics — the "group report" case. */
export async function getDepartmentRollup(
  ctx: ChatContext,
  args: RangeInput = {},
): Promise<ToolResult<DepartmentRollupRow> & { period: PeriodInfo }> {
  requireSuperAdmin(ctx);

  const range = resolveRange(args);

  const rows = await query<{
    department: string;
    employee_count: number;
    days_present: number;
    days_late: number;
    days_absent: number;
    total_minutes_worked: number;
  }>(
    `SELECT COALESCE(e.department, 'Unassigned')                            AS department,
            COUNT(DISTINCT e.id)                                            AS employee_count,
            COALESCE(SUM(CASE WHEN a.status='present' THEN 1 ELSE 0 END), 0) AS days_present,
            COALESCE(SUM(CASE WHEN a.status='late'    THEN 1 ELSE 0 END), 0) AS days_late,
            COALESCE(SUM(CASE WHEN a.status='absent'  THEN 1 ELSE 0 END), 0) AS days_absent,
            COALESCE(SUM(a.total_minutes), 0)                               AS total_minutes_worked
       FROM employees e
       LEFT JOIN attendance a
              ON a.employee_id = e.id
             AND a.work_date BETWEEN ? AND ?
      WHERE e.is_active = TRUE
      GROUP BY COALESCE(e.department, 'Unassigned')
      ORDER BY department ASC`,
    [range.from, range.to],
  );

  const period = await getWorkingDays(range);

  return {
    range,
    period,
    count: rows.length,
    rows: rows.map(r => {
      const minutes = Number(r.total_minutes_worked);
      const presentDays = Number(r.days_present) + Number(r.days_late);
      return {
        department: r.department,
        employee_count: Number(r.employee_count),
        days_present: Number(r.days_present),
        days_late: Number(r.days_late),
        days_absent: Number(r.days_absent),
        total_minutes_worked: minutes,
        hours_worked_display: minutesToHours(minutes),
        // Averaged here from SQL-computed totals — never by the model.
        avg_minutes_per_present_day:
          presentDays > 0 ? Math.round(minutes / presentDays) : 0,
      };
    }),
  };
}

export interface GeofenceExceptionRow {
  work_date: string;
  emp_id: string;
  name: string;
  department: string | null;
  work_mode: string;
  geofence_status: string;
  clock_in_ist: string;
}

/** Clock-ins recorded outside the permitted geofence. */
export async function getGeofenceExceptions(
  ctx: ChatContext,
  args: ScopeArgs = {},
): Promise<ToolResult<GeofenceExceptionRow>> {
  requireSuperAdmin(ctx);

  const range = resolveRange(args);
  const scope = employeeScope(args);

  const rows = await query<{
    work_date: Date | string;
    emp_id: string;
    name: string;
    department: string | null;
    work_mode: string;
    geofence_status: string;
    clock_in_utc: Date | null;
  }>(
    `SELECT a.work_date, e.emp_id, e.name, e.department, e.work_mode,
            a.geofence_status, a.clock_in_utc
       FROM attendance a
       JOIN employees e ON e.id = a.employee_id
      ${scope.sql ? scope.sql + ' AND' : 'WHERE'} a.work_date BETWEEN ? AND ?
        AND a.geofence_status = 'outside'
      ORDER BY a.work_date DESC, e.name ASC
      LIMIT 200`,
    [...scope.params, range.from, range.to],
  );

  return {
    range,
    count: rows.length,
    rows: rows.map(r => ({
      work_date: toYmdString(r.work_date),
      emp_id: r.emp_id,
      name: r.name,
      department: r.department,
      work_mode: r.work_mode,
      geofence_status: r.geofence_status,
      clock_in_ist: toIstTime(r.clock_in_utc),
    })),
    notes:
      rows.length === 0
        ? ['No out-of-geofence clock-ins in this period.']
        : undefined,
  };
}

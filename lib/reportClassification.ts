/**
 * lib/reportClassification.ts — one place that decides what kind of day a
 * record represents.
 *
 * WHY THIS EXISTS
 * ---------------
 * `attendance.status` cannot distinguish a weekly off from a government
 * holiday: the enum has one `'holiday'` value and `lib/markSundayHolidays.ts`
 * writes it for every Sunday. So the same value meant both things, and each
 * report route guessed differently — the on-screen summary counted a Sunday as
 * a weekend, the PDF counted it as leave, and the CSV printed it as a holiday.
 * Same day, three answers, one export.
 *
 * The distinction is recoverable from data already stored, with no migration:
 *
 *   status 'holiday' AND the date has a company-wide holiday row
 *     in leave_records (employee_id IS NULL, leave_type 'holiday')  -> HOLIDAY
 *   status 'holiday' AND it does not                                -> WEEK_OFF
 *
 * because the only two writers of `'holiday'` are the company-holiday flow
 * (app/api/leaves/route.ts) and the Sunday sweep.
 *
 * Personal leave is read from `leave_records`, never inferred from attendance:
 * granting leave only UPDATEs an existing attendance row and never inserts one
 * (app/api/leaves/route.ts:274 and :332), so an approved leave on a day with no
 * clock-in leaves NO trace in `attendance`. A report that counts only
 * attendance rows silently loses real leave.
 *
 * Nothing here writes to the database.
 */

import { query } from '@/lib/db';
import { formatInTimeZone } from 'date-fns-tz';

/** The kinds of day a report can show. */
export type DayKind =
  | 'present'
  | 'late'
  | 'early_departure'
  | 'absent'
  | 'leave'
  | 'holiday'
  | 'week_off';

/** Column/label text for each kind. */
export const DAY_KIND_LABEL: Record<DayKind, string> = {
  present: 'Present',
  late: 'Late',
  early_departure: 'Early Departure',
  absent: 'Absent',
  leave: 'Leave',
  holiday: 'Holiday',
  week_off: 'Week Off',
};

/**
 * A DATE column rendered as YYYY-MM-DD.
 *
 * `mysql2` is configured with `dateStrings: false` (lib/db.ts), so a DATE comes
 * back as a JS Date at midnight UTC — NOT a string. `String(date).slice(0,10)`
 * therefore yields "Sat May 23": no year, no numeric month. Every report that
 * did that produced an unusable date column.
 */
export function toYmd(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return formatInTimeZone(value, 'UTC', 'yyyy-MM-dd');
  }
  return String(value).slice(0, 10);
}

/**
 * Dates in the range that are holidays for EVERY location.
 *
 * These are `leave_records` rows with `employee_id IS NULL` **and**
 * `location_id IS NULL`. The location filter is essential: without it a holiday
 * declared for one site is treated as company-wide, so employees at other sites
 * — and employees with no location at all — would wrongly show a holiday.
 * Location-scoped holidays come from `fetchLocationHolidays` instead.
 */
export async function fetchCompanyHolidays(
  fromDate: string,
  toDate: string,
): Promise<Set<string>> {
  const rows = await query<{ leave_date: Date | string }>(
    `SELECT lr.leave_date
       FROM leave_records lr
      WHERE lr.employee_id IS NULL
        AND lr.location_id IS NULL
        AND lr.leave_type = 'holiday'
        AND lr.leave_date BETWEEN ? AND ?`,
    [fromDate, toDate],
  );
  return new Set(rows.map(r => toYmd(r.leave_date)));
}

/**
 * Holiday dates that apply to a specific employee, including holidays scoped to
 * one location (`leave_records.location_id`).
 *
 * `fetchCompanyHolidays` only sees the company-wide rows. Without this, a
 * holiday declared for one site would be classified as a WEEK OFF for the
 * employees at that site — the very confusion this module exists to remove.
 *
 * Returns `employee_id -> Set<'YYYY-MM-DD'>` covering ONLY location-scoped
 * holidays; union it with the company-wide set per employee.
 */
export async function fetchLocationHolidays(
  fromDate: string,
  toDate: string,
): Promise<Map<number, Set<string>>> {
  const rows = await query<{ employee_id: number; leave_date: Date | string }>(
    `SELECT DISTINCT es.employee_id, lr.leave_date
       FROM leave_records lr
       JOIN employee_schedules es
         ON  es.location_id = lr.location_id
         AND es.effective_from <= lr.leave_date
         AND (es.effective_to IS NULL OR es.effective_to >= lr.leave_date)
      WHERE lr.employee_id IS NULL
        AND lr.location_id IS NOT NULL
        AND lr.leave_type = 'holiday'
        AND lr.leave_date BETWEEN ? AND ?`,
    [fromDate, toDate],
  );

  const byEmployee = new Map<number, Set<string>>();
  for (const r of rows) {
    const key = Number(r.employee_id);
    if (!byEmployee.has(key)) byEmployee.set(key, new Set());
    byEmployee.get(key)!.add(toYmd(r.leave_date));
  }
  return byEmployee;
}

/**
 * Every holiday date that applies to one employee: company-wide plus any scoped
 * to their location. Pass the result to `classifyAttendanceRow`.
 */
export function holidaysForEmployee(
  companyHolidays: Set<string>,
  locationHolidays: Map<number, Set<string>> | undefined,
  employeeId: number | undefined,
): Set<string> {
  const scoped = employeeId == null ? undefined : locationHolidays?.get(employeeId);
  if (!scoped || scoped.size === 0) return companyHolidays;
  return new Set([...companyHolidays, ...scoped]);
}

/**
 * Personal (non-holiday) leave dates per employee in the range, as
 * `employee_id -> Set<'YYYY-MM-DD'>`.
 *
 * This is the authoritative source for leave. Counting `attendance.status =
 * 'leave'` instead under-reports, because granting leave never creates a row.
 */
export async function fetchPersonalLeaveDates(
  fromDate: string,
  toDate: string,
): Promise<Map<number, Set<string>>> {
  const rows = await query<{ employee_id: number; leave_date: Date | string }>(
    `SELECT lr.employee_id, lr.leave_date
       FROM leave_records lr
      WHERE lr.employee_id IS NOT NULL
        AND lr.leave_type <> 'holiday'
        AND lr.leave_date BETWEEN ? AND ?`,
    [fromDate, toDate],
  );

  const byEmployee = new Map<number, Set<string>>();
  for (const r of rows) {
    const key = Number(r.employee_id);
    if (!byEmployee.has(key)) byEmployee.set(key, new Set());
    byEmployee.get(key)!.add(toYmd(r.leave_date));
  }
  return byEmployee;
}

/**
 * Classify one attendance row.
 *
 * `companyHolidays` comes from `fetchCompanyHolidays`. Pass the row's own
 * `work_date` (any shape — it is normalised here).
 */
export function classifyAttendanceRow(
  status: string | null | undefined,
  workDate: unknown,
  companyHolidays: Set<string>,
): DayKind {
  const ymd = toYmd(workDate);

  if (status === 'holiday') {
    // The pivotal distinction: a government holiday has a company-wide
    // leave_records row for that date; a weekly off does not.
    return companyHolidays.has(ymd) ? 'holiday' : 'week_off';
  }

  if (
    status === 'present' ||
    status === 'late' ||
    status === 'absent' ||
    status === 'leave' ||
    status === 'early_departure'
  ) {
    return status;
  }

  // Unknown/missing status: a company holiday still reads as a holiday.
  return companyHolidays.has(ymd) ? 'holiday' : 'absent';
}

/** Per-employee day-kind tallies. */
export interface DayKindTotals {
  present: number;
  late: number;
  early_departure: number;
  absent: number;
  /** Approved personal leave, counted from leave_records. */
  leave: number;
  /** Government / company-wide holidays. */
  holiday: number;
  /** Weekly offs (the Sunday sweep's rows). */
  week_off: number;
}

export function emptyTotals(): DayKindTotals {
  return {
    present: 0,
    late: 0,
    early_departure: 0,
    absent: 0,
    leave: 0,
    holiday: 0,
    week_off: 0,
  };
}

/**
 * Tally attendance rows for one employee, then fold in approved leave from
 * `leave_records`.
 *
 * `leaveDates` is that employee's entry from `fetchPersonalLeaveDates`. A leave
 * date is counted once whether or not an attendance row exists for it, and a
 * row already classified as `leave` is not double-counted.
 */
export function tallyEmployee(
  rows: Array<{ status?: string | null; work_date?: unknown }>,
  companyHolidays: Set<string>,
  leaveDates: Set<string> | undefined,
): DayKindTotals {
  const totals = emptyTotals();
  const countedLeave = new Set<string>();

  for (const row of rows) {
    const kind = classifyAttendanceRow(row.status, row.work_date, companyHolidays);
    if (kind === 'leave') countedLeave.add(toYmd(row.work_date));
    totals[kind] += 1;
  }

  // Approved leave with no attendance row would otherwise be invisible.
  if (leaveDates) {
    for (const d of leaveDates) {
      if (!countedLeave.has(d)) totals.leave += 1;
    }
  }

  return totals;
}

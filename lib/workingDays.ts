import { query } from '@/lib/db';
import { WEEKLY_OFF_DAYS } from '@/lib/constants';

// ---------------------------------------------------------------------------
// Working days for ONE employee over a period.
//
// The absent job decides a missed day from that employee's own shift
// (working_days), so expected hours have to be counted the same way — otherwise
// a Saturday can be an absence on a day the report says nobody was expected.
// Counting is arithmetic, not a day-by-day walk, so any range length is fine.
// ---------------------------------------------------------------------------

const ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** How many times each weekday occurs in the range, indexed 0=Sun … 6=Sat. */
export function weekdayCounts(fromDate: string, toDate: string): number[] {
  const counts = new Array(7).fill(0);
  const start = Date.parse(`${fromDate}T00:00:00Z`);
  const end = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return counts;

  const totalDays = Math.round((end - start) / 86_400_000) + 1;
  const whole = Math.floor(totalDays / 7);
  const remainder = totalDays % 7;
  const firstDow = new Date(start).getUTCDay();

  for (let i = 0; i < 7; i++) counts[i] = whole;
  for (let i = 0; i < remainder; i++) counts[(firstDow + i) % 7] += 1;
  return counts;
}

/** Company-wide holiday dates in the range, as YYYY-MM-DD. */
export async function companyHolidays(fromDate: string, toDate: string): Promise<string[]> {
  const rows = await query<{ d: string }>(
    `SELECT DISTINCT DATE_FORMAT(leave_date, '%Y-%m-%d') AS d
     FROM leave_records
     WHERE employee_id IS NULL AND leave_type = 'holiday'
       AND leave_date BETWEEN ? AND ?`,
    [fromDate, toDate],
  );
  return rows.map(r => r.d);
}

/**
 * Working days for an employee whose shift lists `workingDays`
 * (e.g. ["Mon","Tue","Wed","Thu","Fri","Sat"]). Employees with no shift fall
 * back to the company weekly-off rule — the same fallback the absent job uses,
 * so the two always agree.
 */
export function workingDaysFor(
  workingDays: string[] | null,
  counts: number[],
  holidays: string[],
): number {
  const active = workingDays?.length
    ? new Set(workingDays)
    : new Set(ABBR.filter(d => !WEEKLY_OFF_DAYS.includes(d)));

  let total = 0;
  for (let i = 0; i < 7; i++) if (active.has(ABBR[i])) total += counts[i];

  // A company holiday only removes a day the employee would otherwise work.
  for (const h of holidays) {
    const dow = new Date(`${h}T00:00:00Z`).getUTCDay();
    if (active.has(ABBR[dow])) total -= 1;
  }
  return Math.max(0, total);
}

/** mysql2 returns JSON columns as a value or a string depending on driver mode. */
export function parseWorkingDays(value: unknown): string[] | null {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

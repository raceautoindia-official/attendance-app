import { queryOne } from '@/lib/db';
import { WEEKLY_OFF_DAYOFWEEK } from '@/lib/constants';

// ---------------------------------------------------------------------------
// Calendar breakdown for a reporting period.
//
// This used to walk the range day by day with a RECURSIVE CTE. MySQL caps that
// at cte_max_recursion_depth (default 1000), so ANY report longer than ~2.7
// years died with "Recursive query aborted after 1001 iterations" — a 500 to
// the admin. The arithmetic below is exact, has no depth limit, and is cheaper:
// every 7 consecutive days contain exactly 2 weekend days, so only the
// remainder of the range needs inspecting, and that is at most 6 days.
// ---------------------------------------------------------------------------

export interface PeriodDays {
  /** Every date in the range, inclusive */
  total_days: number;
  /** Weekly off days (Sunday by default — Saturday is a working day) */
  weekend_days: number;
  /** Company-wide holidays, including any that land on a weekly off */
  festive_holidays: number;
  /** Days that are neither a weekly off nor a company holiday */
  total_working_days: number;
}

export async function getPeriodDays(fromDate: string, toDate: string): Promise<PeriodDays> {
  const offList = WEEKLY_OFF_DAYOFWEEK.length ? WEEKLY_OFF_DAYOFWEEK : [1];
  const offPlaceholders = offList.map(() => '?').join(',');

  const row = await queryOne<{
    total_days: number;
    festive_holidays: number;
    weekday_holidays: number;
    remainder_off_days: number;
  }>(
    `SELECT
       GREATEST(DATEDIFF(?, ?) + 1, 0) AS total_days,
       (SELECT COUNT(DISTINCT lr.leave_date)
          FROM leave_records lr
         WHERE lr.employee_id IS NULL
           AND lr.leave_type = 'holiday'
           AND lr.leave_date BETWEEN ? AND ?) AS festive_holidays,
       -- Holidays already excluded by the weekly-off count must not be
       -- subtracted twice when working days are derived.
       (SELECT COUNT(DISTINCT lr.leave_date)
          FROM leave_records lr
         WHERE lr.employee_id IS NULL
           AND lr.leave_type = 'holiday'
           AND lr.leave_date BETWEEN ? AND ?
           AND DAYOFWEEK(lr.leave_date) NOT IN (${offPlaceholders})) AS weekday_holidays,
       -- Weekly off days among the leftover days after the whole weeks.
       (SELECT COUNT(*)
          FROM (SELECT 0 AS i UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3
                UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6) o
         WHERE o.i < MOD(GREATEST(DATEDIFF(?, ?) + 1, 0), 7)
           AND DAYOFWEEK(DATE_ADD(?, INTERVAL o.i DAY)) IN (${offPlaceholders})) AS remainder_off_days`,
    [
      toDate, fromDate,
      fromDate, toDate,
      fromDate, toDate, ...offList,
      toDate, fromDate, fromDate, ...offList,
    ],
  );

  const totalDays = Number(row?.total_days ?? 0);
  // Every whole week contains exactly one of each weekday.
  const weekendDays =
    Math.floor(totalDays / 7) * offList.length + Number(row?.remainder_off_days ?? 0);
  const festiveHolidays = Number(row?.festive_holidays ?? 0);
  const weekdayHolidays = Number(row?.weekday_holidays ?? 0);

  return {
    total_days: totalDays,
    weekend_days: weekendDays,
    festive_holidays: festiveHolidays,
    total_working_days: Math.max(0, totalDays - weekendDays - weekdayHolidays),
  };
}

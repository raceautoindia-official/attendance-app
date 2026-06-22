import { query } from '@/lib/db';
import { formatInTimeZone } from 'date-fns-tz';
import { TIMEZONE } from '@/lib/constants';

// ---------------------------------------------------------------------------
// Sunday = company-wide holiday. For the given IST date, IF it is a Sunday,
// inserts a 'holiday' attendance row for every active employee who has no
// attendance row that day. Employees who actually WORK that Sunday already have
// a row (or their clock-in converts the holiday row to present in place), so
// their real record always wins. Idempotent — safe to run repeatedly.
// Returns the number of holiday rows created.
// ---------------------------------------------------------------------------
export async function markSundayHolidays(workDate: string): Promise<number> {
  const weekday = formatInTimeZone(new Date(`${workDate}T12:00:00+05:30`), TIMEZONE, 'EEE');
  if (weekday !== 'Sun') return 0;

  const result = await query<{ affectedRows?: number }>(
    `INSERT INTO attendance (employee_id, work_date, status)
     SELECT e.id, ?, 'holiday'
     FROM employees e
     WHERE e.is_active = TRUE
       AND NOT EXISTS (
             SELECT 1 FROM attendance a
             WHERE a.employee_id = e.id AND a.work_date = ?
           )
     ON DUPLICATE KEY UPDATE status = status`,
    [workDate, workDate],
  );

  return (result as unknown as { affectedRows: number }).affectedRows ?? 0;
}

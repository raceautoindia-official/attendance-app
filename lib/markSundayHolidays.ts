import { query, insertAuditLog } from '@/lib/db';
import { formatInTimeZone } from 'date-fns-tz';


// ---------------------------------------------------------------------------
// Sunday = company-wide holiday. For the given IST date, IF it is a Sunday,
// inserts a 'holiday' attendance row for every active employee who has no
// attendance row that day. Employees who actually WORK that Sunday already have
// a row (or their clock-in converts the holiday row to present in place), so
// their real record always wins. Idempotent — safe to run repeatedly.
// Returns the number of holiday rows created.
// ---------------------------------------------------------------------------
export async function markSundayHolidays(workDate: string): Promise<number> {
  // Weekday of the calendar date itself, timezone-free (see markAbsent.ts for
  // why the old +05:30 anchor was wrong for deployments west of UTC-6).
  const weekday = formatInTimeZone(new Date(`${workDate}T00:00:00Z`), 'UTC', 'EEE');
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

  const created = (result as unknown as { affectedRows: number }).affectedRows ?? 0;

  // This writes attendance rows, so it has to leave a trail like every other
  // path that does — previously it wrote silently.
  if (created > 0) {
    await insertAuditLog({
      action: 'sunday_holidays_marked',
      entity: 'attendance',
      performed_by: null,
      details: { work_date: workDate, rows_created: created, reason: 'sunday_company_holiday' },
      ip_address: null,
    });
  }

  return created;
}

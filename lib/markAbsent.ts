import { query, insertAuditLog } from '@/lib/db';
import { formatInTimeZone } from 'date-fns-tz';
import { TIMEZONE } from '@/lib/constants';

// ---------------------------------------------------------------------------
// Marks employees ABSENT for a given IST work date (YYYY-MM-DD) when they:
//   • have an active schedule covering that date,
//   • that date is a working day per their shift's working_days,
//   • have NO attendance row for that date, and
//   • have NO leave record for that date that applies to them — personal leave,
//     a company-wide holiday (leave_records.location_id IS NULL), or a holiday
//     scoped to the location their schedule points at on that date.
//
// Idempotent — the INSERT uses ON DUPLICATE KEY UPDATE and the row checks make
// it safe to run repeatedly. Returns the number of employees newly considered
// absent. Shared by the cron endpoint and the in-app scheduler.
// ---------------------------------------------------------------------------
export async function markAbsentees(workDate: string): Promise<number> {
  // Weekday abbreviation ("Mon".."Sun") for the IST work date (noon IST avoids
  // any midnight edge), matching the values stored in shifts.working_days.
  const weekdayAbbr = formatInTimeZone(new Date(`${workDate}T12:00:00+05:30`), TIMEZONE, 'EEE');

  const employees = await query<{ id: number; name: string }>(
    `SELECT DISTINCT e.id, e.name
     FROM employees e
     JOIN employee_schedules es
       ON  es.employee_id = e.id
       AND es.effective_from <= ?
       AND (es.effective_to IS NULL OR es.effective_to >= ?)
     JOIN shifts s ON s.id = es.shift_id
     WHERE e.is_active = TRUE
       AND JSON_CONTAINS(s.working_days, JSON_QUOTE(?))
       AND NOT EXISTS (
             SELECT 1 FROM attendance a
             WHERE a.employee_id = e.id AND a.work_date = ?
           )
       AND NOT EXISTS (
             SELECT 1 FROM leave_records lr
             WHERE lr.leave_date = ?
               AND (lr.employee_id = e.id OR lr.employee_id IS NULL)
               -- Location scoping: a company-wide row (location_id IS NULL)
               -- applies everywhere, but a row scoped to one location must only
               -- exempt employees whose schedule on that date points at it.
               -- Without this, a Chennai holiday would stop Pune employees
               -- being marked absent.
               AND (
                 lr.location_id IS NULL
                 OR EXISTS (
                      SELECT 1 FROM employee_schedules es2
                       WHERE es2.employee_id = e.id
                         AND es2.location_id = lr.location_id
                         AND es2.effective_from <= ?
                         AND (es2.effective_to IS NULL OR es2.effective_to >= ?)
                    )
               )
           )`,
    [workDate, workDate, weekdayAbbr, workDate, workDate, workDate, workDate],
  );

  if (employees.length > 0) {
    const placeholders = employees.map(() => "(?, ?, 'absent')").join(', ');
    const values = employees.flatMap(e => [e.id, workDate]);
    await query(
      `INSERT INTO attendance (employee_id, work_date, status)
       VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE status = status`,
      values,
    );
  }

  // Normalize "dangling" rows: a row exists for the date but has no clock-in and
  // isn't leave/holiday -> mark absent.
  await query(
    `UPDATE attendance a
     JOIN employees e ON e.id = a.employee_id
     JOIN employee_schedules es
       ON  es.employee_id = e.id
       AND es.effective_from <= ?
       AND (es.effective_to IS NULL OR es.effective_to >= ?)
     JOIN shifts s ON s.id = es.shift_id
     SET a.status = 'absent'
     WHERE a.work_date = ?
       AND e.is_active = TRUE
       AND JSON_CONTAINS(s.working_days, JSON_QUOTE(?))
       AND a.clock_in_utc IS NULL
       AND a.status NOT IN ('leave', 'holiday')
       AND NOT EXISTS (
             SELECT 1 FROM leave_records lr
             WHERE lr.leave_date = ?
               AND (lr.employee_id = e.id OR lr.employee_id IS NULL)
               AND (
                 lr.location_id IS NULL
                 OR EXISTS (
                      SELECT 1 FROM employee_schedules es2
                       WHERE es2.employee_id = e.id
                         AND es2.location_id = lr.location_id
                         AND es2.effective_from <= ?
                         AND (es2.effective_to IS NULL OR es2.effective_to >= ?)
                    )
               )
           )`,
    [workDate, workDate, workDate, weekdayAbbr, workDate, workDate, workDate],
  );

  if (employees.length > 0) {
    await insertAuditLog({
      action: 'bulk_absent_marked',
      entity: 'attendance',
      performed_by: null,
      details: { count: employees.length, work_date: workDate, employee_ids: employees.map(e => e.id) },
      ip_address: null,
    });
  }

  return employees.length;
}

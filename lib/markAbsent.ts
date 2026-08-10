import { query, insertAuditLog } from '@/lib/db';
import { formatInTimeZone } from 'date-fns-tz';
import { TIMEZONE, WEEKLY_OFF_DAYS } from '@/lib/constants';

// ---------------------------------------------------------------------------
// Marks employees ABSENT for a given IST work date (YYYY-MM-DD) when they:
//   • have an active schedule covering that date,
//   • that date is a working day per their shift's working_days,
//   • have NO attendance row for that date, and
//   • have NO leave record (personal or company-wide holiday) for that date.
//
// Idempotent — the INSERT uses ON DUPLICATE KEY UPDATE and the row checks make
// it safe to run repeatedly. Returns the number of employees newly considered
// absent. Shared by the cron endpoint and the in-app scheduler.
// ---------------------------------------------------------------------------
export async function markAbsentees(workDate: string): Promise<number> {
  // Weekday abbreviation ("Mon".."Sun") for the IST work date (noon IST avoids
  // any midnight edge), matching the values stored in shifts.working_days.
  const weekdayAbbr = formatInTimeZone(new Date(`${workDate}T12:00:00+05:30`), TIMEZONE, 'EEE');

  // An employee counts for this day when their SHIFT lists the weekday as a
  // working day. Employees with no schedule have no shift to consult, and used
  // to be skipped entirely — they could miss every day of the month and never
  // be recorded. They now fall back to the company weekly-off rule (Saturday is
  // a working day; only WEEKLY_OFF_DAYS are off), so the midnight check covers
  // everyone rather than only the scheduled.
  const isCompanyOffDay = WEEKLY_OFF_DAYS.includes(weekdayAbbr);

  const employees = await query<{ id: number; name: string }>(
    `SELECT DISTINCT e.id, e.name
     FROM employees e
     -- ANY shift the employee is rostered on counts: a double-shift employee
     -- works the day if either shift does. LEFT JOIN (not LIMIT 1) so both are
     -- considered; DISTINCT above collapses the duplicate rows.
     LEFT JOIN employee_schedules es
       ON  es.employee_id = e.id
       AND es.effective_from <= ?
       AND (es.effective_to IS NULL OR es.effective_to >= ?)
     LEFT JOIN shifts s ON s.id = es.shift_id
     WHERE e.is_active = TRUE
       AND (
             -- Scheduled: trust the shift's own working days.
             (s.id IS NOT NULL AND JSON_CONTAINS(s.working_days, JSON_QUOTE(?)))
             -- Unscheduled: fall back to the company weekly-off rule.
             OR (s.id IS NULL AND ? = FALSE)
           )
       AND NOT EXISTS (
             SELECT 1 FROM attendance a
             WHERE a.employee_id = e.id AND a.work_date = ?
           )
       AND NOT EXISTS (
             SELECT 1 FROM leave_records lr
             WHERE lr.leave_date = ?
               AND (lr.employee_id = e.id OR lr.employee_id IS NULL)
           )`,
    [workDate, workDate, weekdayAbbr, isCompanyOffDay, workDate, workDate],
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
     -- ANY shift the employee is rostered on counts: a double-shift employee
     -- works the day if either shift does. LEFT JOIN (not LIMIT 1) so both are
     -- considered; DISTINCT above collapses the duplicate rows.
     LEFT JOIN employee_schedules es
       ON  es.employee_id = e.id
       AND es.effective_from <= ?
       AND (es.effective_to IS NULL OR es.effective_to >= ?)
     LEFT JOIN shifts s ON s.id = es.shift_id
     SET a.status = 'absent'
     WHERE a.work_date = ?
       AND e.is_active = TRUE
       AND (
             (s.id IS NOT NULL AND JSON_CONTAINS(s.working_days, JSON_QUOTE(?)))
             OR (s.id IS NULL AND ? = FALSE)
           )
       AND a.clock_in_utc IS NULL
       AND a.status NOT IN ('leave', 'holiday')
       AND NOT EXISTS (
             SELECT 1 FROM leave_records lr
             WHERE lr.leave_date = ?
               AND (lr.employee_id = e.id OR lr.employee_id IS NULL)
           )`,
    [workDate, workDate, workDate, weekdayAbbr, isCompanyOffDay, workDate],
  );

  if (employees.length > 0) {
    // One entry per employee, linked to the row that was created, so a day
    // marked absent can be traced to a person rather than only to a count.
    const marked = await query<{ id: number; employee_id: number; emp_id: string; name: string }>(
      `SELECT a.id, a.employee_id, e.emp_id, e.name
       FROM attendance a
       JOIN employees e ON e.id = a.employee_id
       WHERE a.work_date = ?
         AND a.employee_id IN (${employees.map(() => '?').join(',')})`,
      [workDate, ...employees.map(e => e.id)],
    );
    for (const m of marked) {
      await insertAuditLog({
        action: 'marked_absent',
        entity: 'attendance',
        entity_id: m.id,
        performed_by: null,
        details: {
          employee_id: m.employee_id,
          emp_id: m.emp_id,
          employee_name: m.name,
          work_date: workDate,
          reason: 'no_clock_in_and_no_leave',
        },
        ip_address: null,
      });
    }

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

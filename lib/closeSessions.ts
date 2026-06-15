import { query, insertAuditLog } from '@/lib/db';
import { getWorkDateIST } from '@/lib/attendance';
import { REQUIRED_SHIFT_MINUTES } from '@/lib/constants';

export interface CloseOpenSessionsOptions {
  // Also close TODAY's still-open sessions (test/manual use). Default false:
  // only previous-day sessions are closed, so each day stands on its own.
  includeToday?: boolean;
  // Restrict to a single employee (test/manual use). Default: all employees.
  employeeId?: number | null;
}

// ---------------------------------------------------------------------------
// Auto-close (auto clock-out) any session that was clocked in but never clocked
// out, crediting the standard required shift length (REQUIRED_SHIFT_MINUTES =
// 9 hours). A real clock-out always wins the race because every UPDATE guards
// on clock_out_utc IS NULL. Shared by the cron endpoint and the in-app
// midnight scheduler so both behave identically. Returns the number closed.
// ---------------------------------------------------------------------------
export async function closeOpenSessions(
  opts: CloseOpenSessionsOptions = {},
): Promise<number> {
  const { includeToday = false, employeeId = null } = opts;
  const today = getWorkDateIST();

  // Build the WHERE clause. The clock-out time is computed in SQL
  // (clock_in_utc + INTERVAL 9h) so it never depends on JS/driver timezone
  // handling, and the whole thing is one atomic UPDATE. The clock_out_utc IS
  // NULL guard means a real manual clock-out always wins the race.
  const conditions = ['clock_out_utc IS NULL', 'clock_in_utc IS NOT NULL'];
  const whereParams: (string | number)[] = [];
  conditions.push(includeToday ? 'work_date <= ?' : 'work_date < ?');
  whereParams.push(today);
  if (employeeId != null) {
    conditions.push('employee_id = ?');
    whereParams.push(employeeId);
  }

  const result = await query<{ affectedRows?: number }>(
    `UPDATE attendance
     SET clock_out_utc = clock_in_utc + INTERVAL ? MINUTE,
         total_minutes  = ?
     WHERE ${conditions.join(' AND ')}`,
    [REQUIRED_SHIFT_MINUTES, REQUIRED_SHIFT_MINUTES, ...whereParams],
  );

  const closed = (result as unknown as { affectedRows: number }).affectedRows ?? 0;

  if (closed > 0) {
    await insertAuditLog({
      action: 'sessions_auto_closed',
      entity: 'attendance',
      performed_by: null,
      details: {
        count: closed,
        closed_before: today,
        include_today: includeToday,
        employee_id: employeeId,
      },
      ip_address: null,
    });
  }

  return closed;
}

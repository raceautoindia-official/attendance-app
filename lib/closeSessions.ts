import { query, insertAuditLog } from '@/lib/db';
import { getWorkDateIST } from '@/lib/attendance';
import { hasSessionColumns, hasWorkModeColumns } from '@/lib/employeeDetails';
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

  const [sessionCols, workModeCols] = await Promise.all([
    hasSessionColumns(),
    hasWorkModeColumns(),
  ]);

  // Multi-session (plant) employees have their hours tracked precisely across
  // sessions all day, so midnight SETTLES the day at the ACTUAL total: minutes
  // banked from completed sessions plus however long the still-open session
  // really ran until now. No flat credit — that would overpay someone whose
  // real sessions summed to less than a standard day.
  let closedMulti = 0;
  if (sessionCols && workModeCols) {
    const aliasedConditions = conditions.map(c => `a.${c}`);
    const multiResult = await query<{ affectedRows?: number }>(
      `UPDATE attendance a
       JOIN employees e ON e.id = a.employee_id AND e.allow_multiple_sessions = TRUE
       SET a.clock_out_utc = UTC_TIMESTAMP(),
           a.total_minutes = a.banked_minutes + GREATEST(0, TIMESTAMPDIFF(MINUTE, a.clock_in_utc, UTC_TIMESTAMP()))
       WHERE ${aliasedConditions.join(' AND ')}`,
      [...whereParams],
    );
    closedMulti = (multiResult as unknown as { affectedRows: number }).affectedRows ?? 0;
  }

  // Everyone else keeps the standard credit: forgetting to clock out yields
  // the required shift length (never less than any banked minutes). Rows the
  // multi-session pass already closed are skipped by the clock_out IS NULL
  // guard.
  const result = sessionCols
    ? await query<{ affectedRows?: number }>(
        `UPDATE attendance
         SET clock_out_utc = DATE_ADD(clock_in_utc, INTERVAL GREATEST(0, ? - banked_minutes) MINUTE),
             total_minutes  = GREATEST(banked_minutes, ?)
         WHERE ${conditions.join(' AND ')}`,
        [REQUIRED_SHIFT_MINUTES, REQUIRED_SHIFT_MINUTES, ...whereParams],
      )
    : await query<{ affectedRows?: number }>(
        `UPDATE attendance
         SET clock_out_utc = clock_in_utc + INTERVAL ? MINUTE,
             total_minutes  = ?
         WHERE ${conditions.join(' AND ')}`,
        [REQUIRED_SHIFT_MINUTES, REQUIRED_SHIFT_MINUTES, ...whereParams],
      );

  const closed = ((result as unknown as { affectedRows: number }).affectedRows ?? 0) + closedMulti;

  if (closed > 0) {
    await insertAuditLog({
      action: 'sessions_auto_closed',
      entity: 'attendance',
      performed_by: null,
      details: {
        count: closed,
        settled_actual_time: closedMulti,
        closed_before: today,
        include_today: includeToday,
        employee_id: employeeId,
      },
      ip_address: null,
    });
  }

  return closed;
}

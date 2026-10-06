import { query, queryOne, insertAuditLog } from '@/lib/db';
import { toYmd } from '@/lib/date';

/**
 * lib/monthClose.ts — closing a month, and the lock that follows.
 *
 * WHY
 * ---
 * Everything else in this app answers "what are the hours". This answers "are
 * these hours final". Without it a report run today and the same report run
 * next week can differ — somebody edits a row, a late clock-out settles, an
 * absence is corrected — all legitimate, all silent, and all after the figures
 * were used to pay somebody.
 *
 * Closing records that a person reviewed the month, which one, and when. After
 * that the attendance inside it is read-only until the month is reopened, and
 * the reopening is recorded too, because "it was unlocked and changed" is
 * exactly what an auditor needs to be able to see.
 *
 * WHAT THE LOCK DOES NOT DO
 * -------------------------
 * It does not freeze the numbers into a snapshot. The figures stay derived from
 * the attendance rows, so there is still one source of truth; the lock is a
 * gate on WRITES, not a copy. A snapshot table would be a second set of numbers
 * that could disagree with the first, which is the problem it was meant to fix.
 *
 * It also does not block clock-in or clock-out. You cannot clock into a past
 * month, and the mobile app shares this database — it must never be refused for
 * a reason it has no way to explain to the person holding the phone.
 */

export interface MonthClosure {
  id: number;
  /** First day of the closed month, YYYY-MM-DD. */
  period_month: string;
  /** Everything up to and including this date is locked. */
  closed_through: string;
  is_closed: boolean;
  closed_by: number | null;
  closed_by_name: string | null;
  closed_at: string;
  reopened_by: number | null;
  reopened_by_name: string | null;
  reopened_at: string | null;
  reopen_reason: string | null;
  notes: string | null;
}

const YM = /^\d{4}-\d{2}$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Last day of a YYYY-MM, as YYYY-MM-DD. */
export function lastDayOfMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, '0')}`;
}

function rowToClosure(r: Record<string, unknown>): MonthClosure {
  return {
    id: Number(r.id),
    period_month: toYmd(r.period_month),
    closed_through: toYmd(r.closed_through),
    is_closed: Boolean(r.is_closed),
    closed_by: r.closed_by == null ? null : Number(r.closed_by),
    closed_by_name: (r.closed_by_name as string) ?? null,
    closed_at: r.closed_at ? new Date(r.closed_at as string).toISOString() : '',
    reopened_by: r.reopened_by == null ? null : Number(r.reopened_by),
    reopened_by_name: (r.reopened_by_name as string) ?? null,
    reopened_at: r.reopened_at ? new Date(r.reopened_at as string).toISOString() : null,
    reopen_reason: (r.reopen_reason as string) ?? null,
    notes: (r.notes as string) ?? null,
  };
}

const SELECT = `
  SELECT mc.*,
         c.name AS closed_by_name,
         r.name AS reopened_by_name
    FROM month_closures mc
    LEFT JOIN employees c ON c.id = mc.closed_by
    LEFT JOIN employees r ON r.id = mc.reopened_by`;

/** Every closure on record, newest month first. */
export async function listClosures(limit = 24): Promise<MonthClosure[]> {
  const rows = await query<Record<string, unknown>>(
    `${SELECT} ORDER BY mc.period_month DESC LIMIT ?`, [limit],
  );
  return rows.map(rowToClosure);
}

/** The closure covering a month, closed or not. */
export async function getClosure(month: string): Promise<MonthClosure | null> {
  if (!YM.test(month)) return null;
  const row = await queryOne<Record<string, unknown>>(
    `${SELECT} WHERE mc.period_month = ?`, [`${month}-01`],
  );
  return row ? rowToClosure(row) : null;
}

/**
 * Is this work date locked?
 *
 * Returns the closure that locks it, or null. Asked by every write path, so
 * there is one answer rather than each route having its own idea of what
 * "closed" means.
 */
export async function lockFor(workDate: string): Promise<MonthClosure | null> {
  if (!YMD.test(workDate)) return null;
  const row = await queryOne<Record<string, unknown>>(
    `${SELECT}
      WHERE mc.is_closed = TRUE
        AND mc.period_month <= ?
        AND mc.closed_through >= ?
      LIMIT 1`,
    [workDate, workDate],
  );
  return row ? rowToClosure(row) : null;
}

/** Thrown by write paths when the date they touch is inside a closed month. */
export class MonthLockedError extends Error {
  readonly closure: MonthClosure;
  constructor(closure: MonthClosure, workDate: string) {
    super(
      `${workDate} falls in a month that was closed on `
      + `${new Date(closure.closed_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`
      + `${closure.closed_by_name ? ` by ${closure.closed_by_name}` : ''}. `
      + 'Reopen the month before editing it, so the change is on the record.',
    );
    this.name = 'MonthLockedError';
    this.closure = closure;
  }
}

/**
 * Guard for a write. Throws MonthLockedError when the date is locked.
 *
 * Call it BEFORE the write, never after: a row that was changed and then
 * complained about is worse than one that was refused.
 */
export async function assertDateWritable(workDate: string): Promise<void> {
  const closure = await lockFor(workDate);
  if (closure) throw new MonthLockedError(closure, workDate);
}

export interface CloseResult {
  closure: MonthClosure;
  /** Reasons the month arguably was not ready. Advisory — closing is allowed. */
  warnings: string[];
}

/**
 * Close a month.
 *
 * Warnings are returned rather than enforced. The app does not know the whole
 * story — an open session may be a night shift mid-run, a zero-hour employee
 * may be a known leaver — so it surfaces what it noticed and leaves the
 * decision with the person signing the month off.
 */
export async function closeMonth(params: {
  month: string;
  closedBy: number;
  closedThrough?: string;
  notes?: string | null;
  ip?: string | null;
}): Promise<CloseResult> {
  const { month, closedBy, notes = null, ip = null } = params;
  if (!YM.test(month)) throw new Error('month must be YYYY-MM.');

  const monthStart = `${month}-01`;
  const monthEnd = lastDayOfMonth(month);
  const through = params.closedThrough ?? monthEnd;
  if (!YMD.test(through)) throw new Error('closed_through must be YYYY-MM-DD.');
  if (through < monthStart || through > monthEnd) {
    throw new Error(`closed_through must fall inside ${month}.`);
  }

  // A month cannot be closed before it has finished happening.
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  if (through > today) {
    throw new Error(
      `${through} has not happened yet. Close up to ${today} at the latest, `
      + 'or wait until the month has finished.',
    );
  }

  const warnings: string[] = [];

  const open = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM attendance
      WHERE work_date BETWEEN ? AND ?
        AND clock_in_utc IS NOT NULL AND clock_out_utc IS NULL`,
    [monthStart, through],
  );
  if (Number(open?.n ?? 0) > 0) {
    warnings.push(
      `${open!.n} day(s) are still clocked in with no clock-out. Their hours are `
      + 'provisional, and closing freezes them as they stand.',
    );
  }

  const noHours = await query<{ name: string }>(
    `SELECT e.name FROM employees e
      WHERE e.is_active = TRUE
        AND e.role = 'employee'
        AND EXISTS (SELECT 1 FROM employee_schedules es WHERE es.employee_id = e.id)
        AND NOT EXISTS (
          SELECT 1 FROM attendance a
           WHERE a.employee_id = e.id
             AND a.work_date BETWEEN ? AND ?
             AND a.total_minutes > 0)`,
    [monthStart, through],
  );
  if (noHours.length > 0) {
    warnings.push(
      `${noHours.length} rostered employee(s) recorded no hours at all: `
      + `${noHours.slice(0, 5).map(e => e.name).join(', ')}`
      + `${noHours.length > 5 ? `, and ${noHours.length - 5} more` : ''}.`,
    );
  }

  const existing = await getClosure(month);
  if (existing?.is_closed) {
    throw new Error(`${month} is already closed.`);
  }

  // Reopened and closed again: keep the same row so the history of this month
  // stays in one place, and clear the reopen fields now that it is shut.
  await query(
    `INSERT INTO month_closures
       (period_month, closed_through, is_closed, closed_by, closed_at, notes)
     VALUES (?, ?, TRUE, ?, NOW(), ?)
     ON DUPLICATE KEY UPDATE
       closed_through = VALUES(closed_through),
       is_closed      = TRUE,
       closed_by      = VALUES(closed_by),
       closed_at      = NOW(),
       notes          = VALUES(notes),
       reopened_by    = NULL,
       reopened_at    = NULL,
       reopen_reason  = NULL`,
    [monthStart, through, closedBy, notes],
  );

  const closure = (await getClosure(month))!;

  await insertAuditLog({
    action: 'month_closed',
    entity: 'month_closure',
    entity_id: closure.id,
    performed_by: closedBy,
    ip_address: ip,
    details: { month, closed_through: through, notes, warnings },
  });

  return { closure, warnings };
}

/**
 * Reopen a closed month.
 *
 * A reason is required. "Why was a signed-off month changed" is the first
 * question anybody will ask, and the answer should not depend on somebody
 * remembering.
 */
export async function reopenMonth(params: {
  month: string;
  reopenedBy: number;
  reason: string;
  ip?: string | null;
}): Promise<MonthClosure> {
  const { month, reopenedBy, reason, ip = null } = params;
  if (!YM.test(month)) throw new Error('month must be YYYY-MM.');
  if (!reason || reason.trim().length < 5) {
    throw new Error('Give a reason for reopening — it goes on the record.');
  }

  const existing = await getClosure(month);
  if (!existing) throw new Error(`${month} has never been closed.`);
  if (!existing.is_closed) throw new Error(`${month} is already open.`);

  await query(
    `UPDATE month_closures
        SET is_closed = FALSE, reopened_by = ?, reopened_at = NOW(), reopen_reason = ?
      WHERE period_month = ?`,
    [reopenedBy, reason.trim(), `${month}-01`],
  );

  await insertAuditLog({
    action: 'month_reopened',
    entity: 'month_closure',
    entity_id: existing.id,
    performed_by: reopenedBy,
    ip_address: ip,
    details: { month, reason: reason.trim(), originally_closed_at: existing.closed_at },
  });

  return (await getClosure(month))!;
}

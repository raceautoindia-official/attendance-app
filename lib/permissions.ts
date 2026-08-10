import { queryOne } from '@/lib/db';
import {
  PERMISSION_MAX_MINUTES_PER_MONTH,
  PERMISSION_MAX_MINUTES_PER_REQUEST,
  PERMISSION_MIN_MINUTES,
  REQUIRED_SHIFT_MINUTES,
} from '@/lib/constants';
import { getWorkDateIST } from '@/lib/attendance';

// ---------------------------------------------------------------------------
// Permission hours — short paid absence inside a working day (added 2026-08-04
// migration). Employee applies from the app, manager / super admin approves.
// ---------------------------------------------------------------------------

/** True once the 2026-08-04 permission migration has run. Every read path
 *  degrades to "no permissions" when it hasn't, same defensive pattern as the
 *  bank-detail and multi-session columns. */
export async function hasPermissionTable(): Promise<boolean> {
  const row = await queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'permission_requests'`,
  );
  return Number(row?.c ?? 0) > 0;
}

export function missingPermissionTableError(): string {
  return 'Permission requests table is missing. Run migration: database/migrations/2026-08-04_add_permission_requests.sql';
}

/** True once the 2026-08-07 on-duty migration has run. */
export async function hasOnDutyColumn(): Promise<boolean> {
  const row = await queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'permission_requests'
       AND COLUMN_NAME = 'request_type'`,
  );
  return Number(row?.c ?? 0) > 0;
}

/** SQL predicate restricting rows to paid TIME OFF, which is the only kind that
 *  consumes quota or tops up hours. Degrades to "everything" before the
 *  migration, when every row was time off anyway. */
export function timeOffOnly(hasType: boolean, alias = ''): string {
  const p = alias ? `${alias}.` : '';
  return hasType ? `AND ${p}request_type = 'permission'` : '';
}

/**
 * Is this employee on approved OUT-OF-OFFICE DUTY at this moment?
 *
 * On-duty means they are working away from the site with an admin's approval,
 * so the geofence must not treat their absence as leaving work. Returns the
 * covering row when one exists.
 */
export async function activeOnDuty(
  employeeId: number,
  workDate: string,
  timeHHMM: string,
): Promise<{ id: number; start_time: string; end_time: string; reason: string | null } | null> {
  if (!(await hasOnDutyColumn())) return null;
  return queryOne<{ id: number; start_time: string; end_time: string; reason: string | null }>(
    `SELECT id, start_time, end_time, reason
     FROM permission_requests
     WHERE employee_id = ?
       AND request_type = 'on_duty'
       AND status = 'approved'
       AND permission_date = ?
       AND start_time <= ?
       AND end_time >= ?
     ORDER BY start_time ASC
     LIMIT 1`,
    [employeeId, workDate, timeHHMM, timeHHMM],
  );
}

// ---------------------------------------------------------------------------
// Time helpers — permission times are IST wall-clock, never UTC instants.
// ---------------------------------------------------------------------------

/** "HH:MM" / "HH:MM:SS" → minutes since midnight, or null when malformed. */
export function parseClockTime(value: string): number | null {
  const m = value.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Normalize to the "HH:MM:00" form MySQL TIME columns round-trip. */
export function toSqlTime(value: string): string | null {
  const minutes = parseClockTime(value);
  if (minutes === null) return null;
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m}:00`;
}

/** Duration of a same-day slice; null when the end is not after the start. */
export function durationMinutes(start: string, end: string): number | null {
  const s = parseClockTime(start);
  const e = parseClockTime(end);
  if (s === null || e === null) return null;
  const diff = e - s;
  return diff > 0 ? diff : null;
}

/** Minutes → "2h", "1h 30m", "45m" — matches minutesToHoursDisplay(). */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// ---------------------------------------------------------------------------
// Hours calculation
// ---------------------------------------------------------------------------

/**
 * How many minutes the day's shift asks for. Flexible shifts carry it
 * explicitly; fixed shifts derive it from start→end (wrapping past midnight).
 * Falls back to the standard 9-hour day when there is no schedule.
 */
export function requiredMinutesForShift(shift: {
  type?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  required_hours?: number | string | null;
} | null | undefined): number {
  if (shift?.required_hours != null) {
    const hours = Number(shift.required_hours);
    if (Number.isFinite(hours) && hours > 0) return Math.round(hours * 60);
  }
  if (shift?.start_time && shift?.end_time) {
    const s = parseClockTime(shift.start_time);
    const e = parseClockTime(shift.end_time);
    if (s !== null && e !== null) {
      const span = ((e - s) % 1440 + 1440) % 1440;
      if (span > 0) return span;
    }
  }
  return REQUIRED_SHIFT_MINUTES;
}

/**
 * The day's credited hours: time actually clocked, topped up by approved
 * permission but never beyond what the shift requires.
 *
 *   credited = LEAST(worked + permission, GREATEST(worked, required))
 *
 * The GREATEST keeps a day that legitimately ran long from being trimmed, and
 * the LEAST stops permission double-counting when the employee stayed clocked
 * in through the permission window (their clocked span already covers it).
 * A day with no clock-in earns no credit — permission tops up, it does not
 * stand in for attendance.
 */
export function creditedMinutes(
  workedMinutes: number | null | undefined,
  permissionMinutes: number | null | undefined,
  requiredMinutes: number = REQUIRED_SHIFT_MINUTES,
): number | null {
  if (workedMinutes == null) return null;
  const worked = Math.max(0, Number(workedMinutes));
  const permission = Math.max(0, Number(permissionMinutes ?? 0));
  if (permission === 0) return worked;
  return Math.min(worked + permission, Math.max(worked, requiredMinutes));
}

// ---------------------------------------------------------------------------
// SQL fragments — shared by the attendance list, today, and report routes so
// the "approved minutes for this employee on this date" rule lives in one place.
// ---------------------------------------------------------------------------

/**
 * Scalar subquery yielding approved permission minutes for an attendance row.
 * Returns a literal 0 when the migration hasn't run.
 *
 * @param exists     result of hasPermissionTable()
 * @param empColumn  SQL expression for the employee id (e.g. "a.employee_id")
 * @param dateColumn SQL expression for the date (e.g. "a.work_date")
 */
export function permissionMinutesSelect(
  exists: boolean,
  empColumn: string,
  dateColumn: string,
  hasType = false,
): string {
  if (!exists) return '0';
  // Only paid TIME OFF tops up a day. On-duty hours are already being clocked
  // — counting them here would pay the employee twice for the same minutes.
  return `COALESCE((
    SELECT SUM(pr.minutes)
    FROM permission_requests pr
    WHERE pr.employee_id = ${empColumn}
      AND pr.permission_date = ${dateColumn}
      AND pr.status = 'approved'
      ${timeOffOnly(hasType, 'pr')}
  ), 0)`;
}

/** Required-minutes expression for a joined shift alias (defaults to 9h). */
export function requiredMinutesSelect(shiftAlias = 's'): string {
  return `COALESCE(
    ${shiftAlias}.required_hours * 60,
    IF(${shiftAlias}.start_time IS NOT NULL AND ${shiftAlias}.end_time IS NOT NULL,
       NULLIF(MOD(TIME_TO_SEC(TIMEDIFF(${shiftAlias}.end_time, ${shiftAlias}.start_time)) / 60 + 1440, 1440), 0),
       NULL),
    ${REQUIRED_SHIFT_MINUTES}
  )`;
}

// ---------------------------------------------------------------------------
// Monthly entitlement
// ---------------------------------------------------------------------------

/** First and last calendar day of the month containing `ymd` (IST dates). */
export function monthBounds(ymd: string): { from: string; to: string; month: string } {
  const [y, m] = ymd.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return {
    from: `${y}-${mm}-01`,
    to: `${y}-${mm}-${String(lastDay).padStart(2, '0')}`,
    month: `${y}-${mm}`,
  };
}

/**
 * Minutes an employee has already committed this month. Pending requests count
 * against the entitlement too, so a queue of unapproved requests can't be used
 * to overshoot it.
 */
export async function getMonthlyUsage(
  employeeId: number,
  ymd: string = getWorkDateIST(),
  excludeRequestId?: number,
): Promise<{ used: number; pending: number; month: string }> {
  const { from, to, month } = monthBounds(ymd);
  // On-duty is work, not time off, so it never eats into the entitlement.
  const typeFilter = timeOffOnly(await hasOnDutyColumn());
  const row = await queryOne<{ used: number | null; pending: number | null }>(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'approved' THEN minutes ELSE 0 END), 0) AS used,
       COALESCE(SUM(CASE WHEN status = 'pending'  THEN minutes ELSE 0 END), 0) AS pending
     FROM permission_requests
     WHERE employee_id = ?
       AND permission_date BETWEEN ? AND ?
       AND status IN ('approved', 'pending')
       ${typeFilter}
       ${excludeRequestId ? 'AND id <> ?' : ''}`,
    excludeRequestId ? [employeeId, from, to, excludeRequestId] : [employeeId, from, to],
  );
  return {
    used: Number(row?.used ?? 0),
    pending: Number(row?.pending ?? 0),
    month,
  };
}

/** The balance payload shared by the API and both clients. */
export async function getMonthlyBalance(employeeId: number, ymd?: string) {
  const { used, pending, month } = await getMonthlyUsage(employeeId, ymd);
  return {
    month,
    monthly_limit_minutes: PERMISSION_MAX_MINUTES_PER_MONTH,
    used_minutes: used,
    pending_minutes: pending,
    remaining_minutes: Math.max(0, PERMISSION_MAX_MINUTES_PER_MONTH - used - pending),
    max_minutes_per_request: PERMISSION_MAX_MINUTES_PER_REQUEST,
    min_minutes_per_request: PERMISSION_MIN_MINUTES,
  };
}

/** Empty balance used when the migration hasn't run. */
export function emptyBalance(ymd: string = getWorkDateIST()) {
  return {
    month: monthBounds(ymd).month,
    monthly_limit_minutes: PERMISSION_MAX_MINUTES_PER_MONTH,
    used_minutes: 0,
    pending_minutes: 0,
    remaining_minutes: PERMISSION_MAX_MINUTES_PER_MONTH,
    max_minutes_per_request: PERMISSION_MAX_MINUTES_PER_REQUEST,
    min_minutes_per_request: PERMISSION_MIN_MINUTES,
  };
}

// ---------------------------------------------------------------------------
// Access control — mirrors canAccessEmployee() but for the approve/reject path,
// where an employee may never act on their own request.
// ---------------------------------------------------------------------------

export async function canReviewEmployee(
  auth: { id: number; role: string },
  employeeId: number,
): Promise<boolean> {
  if (auth.role === 'super_admin') return true;
  if (auth.role === 'manager') {
    if (auth.id === employeeId) return false; // no self-approval
    const emp = await queryOne<{ manager_id: number | null }>(
      'SELECT manager_id FROM employees WHERE id = ?',
      [employeeId],
    );
    return emp?.manager_id === auth.id;
  }
  return false;
}

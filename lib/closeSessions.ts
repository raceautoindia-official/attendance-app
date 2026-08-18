import { query, queryOne, insertAuditLog } from '@/lib/db';
import { getWorkDateIST, workDayEndUtc, toMySQLDatetime } from '@/lib/attendance';
import { hasSessionColumns } from '@/lib/employeeDetails';
import { AUTO_CLOSE_MAX_MINUTES } from '@/lib/constants';
import { dayRequiredMinutesSelect } from '@/lib/shifts';

/**
 * How recently the phone must have reported in for the employee to count as
 * "still working" at the boundary. A live-tracking ping inside this window is
 * the only evidence available that someone is genuinely still on shift rather
 * than having gone home without clocking out.
 */
const STILL_WORKING_WINDOW_MIN = 30;

/**
 * Carry a continuing shift across the 07:00 boundary.
 *
 * Someone working through the boundary should not have to clock in again — the
 * day they were in has been settled, so a fresh session is opened at 07:00 and
 * the new day starts counting from there.
 *
 * Deliberately conditional: opening a new session for EVERY closed one would
 * turn a single forgotten clock-out into a permanent open session, credited
 * 24 hours a day for ever. Only employees whose phone reported a position in
 * the last half hour are carried over; everyone else simply ends the day, and
 * clocks in normally when they next arrive.
 */
async function reopenAtBoundary(
  pending: Array<{ id: number; work_date: string }>,
  sessionCols: boolean,
): Promise<void> {
  if (!pending.length) return;

  const stillWorking = await query<{
    employee_id: number; emp_id: string; name: string; work_date: string;
  }>(
    `SELECT DISTINCT a.employee_id, e.emp_id, e.name,
            DATE_FORMAT(a.work_date, '%Y-%m-%d') AS work_date
     FROM attendance a
     JOIN employees e ON e.id = a.employee_id AND e.is_active = TRUE
     JOIN live_tracking_sessions lts ON lts.employee_id = a.employee_id
     JOIN live_tracking_points ltp ON ltp.session_id = lts.id
     WHERE a.id IN (${pending.map(() => '?').join(',')})
       AND ltp.tracked_at_utc >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE)`,
    [...pending.map(p => p.id), STILL_WORKING_WINDOW_MIN],
  ).catch(() => []);   // live-tracking tables absent → nobody is carried over

  for (const s of stillWorking) {
    const nextDate = nextWorkDate(s.work_date);
    const startedAt = toMySQLDatetime(workDayEndUtc(s.work_date));
    // Never open a session in the future, and never past today's own day.
    if (new Date(startedAt + 'Z').getTime() > Date.now()) continue;

    const inserted = await query<{ affectedRows?: number }>(
      `INSERT INTO attendance
         (employee_id, work_date, clock_in_utc, status${sessionCols ? ', banked_minutes, session_count' : ''})
       VALUES (?, ?, ?, 'present'${sessionCols ? ', 0, 1' : ''})
       ON DUPLICATE KEY UPDATE employee_id = employee_id`,
      [s.employee_id, nextDate, startedAt],
    );
    if (((inserted as unknown as { affectedRows: number }).affectedRows ?? 0) === 1) {
      await insertAuditLog({
        action: 'session_continued_across_day',
        entity: 'attendance',
        performed_by: null,
        details: {
          employee_id: s.employee_id,
          emp_id: s.emp_id,
          employee_name: s.name,
          previous_work_date: s.work_date,
          work_date: nextDate,
          started_at_utc: startedAt,
          reason: 'still_on_site_at_day_boundary',
        },
        ip_address: null,
      });
    }
  }
}

function nextWorkDate(workDate: string): string {
  const d = new Date(`${workDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export interface CloseOpenSessionsOptions {
  // Also close TODAY's still-open sessions (test/manual use). Default false:
  // only previous-day sessions are closed, so each day stands on its own.
  includeToday?: boolean;
  // Restrict to a single employee (test/manual use). Default: all employees.
  employeeId?: number | null;
}

// ---------------------------------------------------------------------------
// Settle every session still open when its work day ended.
//
// The day ends at WORK_DAY_START_HOUR (07:00 IST), not midnight, and it is
// settled at the hours ACTUALLY worked — clock-in through to that boundary —
// rather than at a shift length. Someone who works late is credited the extra
// time instead of being flattened to a nominal day, which is the whole point:
// per-day hours should say how long the person really worked.
//
// Anyone still working at the boundary has a FRESH session opened at 07:00 so
// the new day starts counting immediately (see reopenAtBoundary) — but only
// where there is evidence they are genuinely still on site, otherwise a
// forgotten clock-out would roll forward for ever.
//
// A real clock-out always wins the race because every UPDATE guards on
// clock_out_utc IS NULL. Shared by the cron endpoint and the in-app scheduler
// so both behave identically. Returns the number closed.
// ---------------------------------------------------------------------------
export async function closeOpenSessions(
  opts: CloseOpenSessionsOptions = {},
): Promise<number> {
  const { includeToday = false, employeeId = null } = opts;
  const today = getWorkDateIST();

  // Build the WHERE clause. "Previous day" means previous WORK day, which ends
  // at 07:00 IST — getWorkDateIST() already accounts for that, so a night still
  // in progress at 02:00 is not swept up as if it were yesterday's. The
  // clock_out_utc IS NULL guard means a real manual clock-out wins the race.
  const conditions = ['clock_out_utc IS NULL', 'clock_in_utc IS NOT NULL'];
  const whereParams: (string | number)[] = [];
  conditions.push(includeToday ? 'work_date <= ?' : 'work_date < ?');
  whereParams.push(today);
  if (employeeId != null) {
    conditions.push('employee_id = ?');
    whereParams.push(employeeId);
  }

  const sessionCols = await hasSessionColumns();

  // Every employee is settled the same way now — minutes banked from completed
  // sessions plus however long the still-open one really ran. Multi-session
  // (plant) staff used to be the only ones treated this way; everyone else got
  // a flat shift length, which hid both short days and overtime.
  const aliasedConditions = conditions.map(c => `a.${c}`);

  // Capture WHICH rows will be closed before touching them, so every auto-close
  // can be traced back to a named employee and day afterwards. Without this the
  // whole nightly run left a single "count: 47" line.
  //
  // required_minutes comes along because it is the fallback below: a day with no
  // tracking at all is settled at a normal day's length, not at elapsed time.
  const pending = await query<{
    id: number;
    employee_id: number;
    work_date: string;
    clock_in_utc: Date;
    required_minutes: number | null;
  }>(
    `SELECT a.id, a.employee_id,
            DATE_FORMAT(a.work_date, '%Y-%m-%d') AS work_date,
            a.clock_in_utc,
            ${dayRequiredMinutesSelect('a.employee_id', 'a.work_date')} AS required_minutes
     FROM attendance a
     WHERE ${aliasedConditions.join(' AND ')}`,
    [...whereParams],
  );

  // ---------------------------------------------------------------------------
  // What a forgotten clock-out is worth.
  //
  // This used to credit elapsed time to the day's 07:00 boundary. For somebody
  // who genuinely worked late that is exactly right; for somebody who simply
  // walked out without tapping the button it produced TWENTY-HOUR DAYS, which
  // is what the reports were showing. Elapsed time is not worked time, and a
  // figure that absurd discredits every honest figure beside it.
  //
  // So the day is settled at the last EVIDENCE the person was at work:
  //
  //   1. their last live-tracking fix — the phone was reporting from the site
  //      until it stopped, and that moment is a real observation;
  //   2. failing that, a normal day's length for them — the reading that says
  //      "they worked their day and forgot to tap", which is what actually
  //      happens. Never past the boundary.
  //   3. failing even a roster, the boundary, held to AUTO_CLOSE_MAX_HOURS if
  //      one is configured.
  //
  // Which one was used is recorded on the audit entry, so a figure can always
  // be traced to the evidence behind it rather than argued about.
  //
  // A real clock-out always wins: every UPDATE still guards on clock_out_utc
  // IS NULL.
  // ---------------------------------------------------------------------------
  const basisById = new Map<number, string>();
  let closed = 0;

  for (const p of pending) {
    const clockIn = new Date(p.clock_in_utc);
    // A day still in progress (only possible with includeToday) is settled at
    // "now" — its boundary has not arrived yet.
    const ceiling = new Date(Math.min(workDayEndUtc(p.work_date).getTime(), Date.now()));

    const lastFix = await queryOne<{ at: Date | string | null }>(
      `SELECT MAX(tracked_at_utc) AS at
         FROM live_tracking_points
        WHERE employee_id = ?
          AND tracked_at_utc >= ?
          AND tracked_at_utc <= ?`,
      [p.employee_id, toMySQLDatetime(clockIn), toMySQLDatetime(ceiling)],
    ).catch(() => null);   // tracking tables absent in a legacy DB

    let endAt: Date;
    let basis: string;
    if (lastFix?.at) {
      endAt = new Date(lastFix.at);
      basis = 'last_tracked_position';
    } else {
      const required = Number(p.required_minutes ?? 0);
      if (required > 0) {
        endAt = new Date(clockIn.getTime() + required * 60_000);
        basis = 'scheduled_day_length';
      } else {
        endAt = ceiling;
        basis = 'day_boundary';
      }
    }

    // Never credited into the day that follows.
    if (endAt.getTime() > ceiling.getTime()) {
      endAt = ceiling;
      basis = 'day_boundary';
    }
    if (AUTO_CLOSE_MAX_MINUTES != null) {
      const cap = new Date(clockIn.getTime() + AUTO_CLOSE_MAX_MINUTES * 60_000);
      if (cap.getTime() < endAt.getTime()) {
        endAt = cap;
        basis = 'capped_at_max_hours';
      }
    }
    // Guards a row whose clock-in somehow sits after its own boundary.
    if (endAt.getTime() < clockIn.getTime()) endAt = clockIn;

    const worked = Math.max(0, Math.round((endAt.getTime() - clockIn.getTime()) / 60_000));
    const result = await query<{ affectedRows?: number }>(
      `UPDATE attendance
          SET clock_out_utc = ?,
              total_minutes = ${sessionCols ? 'banked_minutes + ' : ''}?
        WHERE id = ? AND clock_out_utc IS NULL`,
      [toMySQLDatetime(endAt), worked, p.id],
    );
    if (((result as unknown as { affectedRows: number }).affectedRows ?? 0) > 0) {
      closed++;
      basisById.set(p.id, basis);
    }
  }

  const touchedIds = pending.map(p => p.id);

  // One traceable entry per employee: which day, who, how long they were
  // credited and on what basis. Written from the rows as they now stand, so the
  // figure logged is exactly the figure stored.
  const touched = touchedIds;
  if (touched.length) {
    const rows = await query<{
      id: number;
      employee_id: number;
      emp_id: string;
      name: string;
      work_date: string;
      clock_in_utc: Date;
      clock_out_utc: Date | null;
      total_minutes: number | null;
      banked_minutes: number | null;
    }>(
      `SELECT a.id, a.employee_id, e.emp_id, e.name,
              DATE_FORMAT(a.work_date, '%Y-%m-%d') AS work_date,
              a.clock_in_utc, a.clock_out_utc, a.total_minutes,
              ${sessionCols ? 'a.banked_minutes' : '0 AS banked_minutes'}
       FROM attendance a
       JOIN employees e ON e.id = a.employee_id
       WHERE a.id IN (${touched.map(() => '?').join(',')})`,
      touched,
    );

    for (const r of rows) {
      await insertAuditLog({
        action: 'session_auto_closed',
        entity: 'attendance',
        entity_id: r.id,
        performed_by: null,
        details: {
          employee_id: r.employee_id,
          emp_id: r.emp_id,
          employee_name: r.name,
          work_date: r.work_date,
          reason: 'never_clocked_out',
          // WHICH evidence produced this figure: a real tracked position, a
          // normal day's length, the boundary, or a configured ceiling. Without
          // it a credited total can only be argued about.
          basis: basisById.get(r.id) ?? 'unchanged',
          day_ended_at_utc: workDayEndUtc(r.work_date).toISOString(),
          clock_in_utc: r.clock_in_utc,
          clock_out_utc: r.clock_out_utc,
          credited_minutes: r.total_minutes,
          banked_minutes: Number(r.banked_minutes ?? 0),
        },
        ip_address: null,
      });
    }
  }

  await reopenAtBoundary(pending, sessionCols);

  if (closed > 0) {
    await insertAuditLog({
      action: 'sessions_auto_closed',
      entity: 'attendance',
      performed_by: null,
      details: {
        count: closed,
        settled_actual_time: closed,
        closed_before: today,
        include_today: includeToday,
        employee_id: employeeId,
        attendance_ids: touched,
      },
      ip_address: null,
    });
  }

  // Garbage-collect tracking sessions whose owner is no longer clocked in
  // ANYWHERE. Staleness no longer ends a session (a quiet phone is a condition
  // to report, not a session to execute), so this sweep is what reaps the
  // leftovers: a day settled above, an admin edit, a repair by hand. Guarded on
  // open attendance rather than on the day being settled, so someone reopened
  // at the boundary — or already clocked in on the new day — keeps tracking
  // uninterrupted.
  await query(
    `UPDATE live_tracking_sessions s
     LEFT JOIN attendance a ON a.employee_id = s.employee_id
       AND a.clock_in_utc IS NOT NULL
       AND a.clock_out_utc IS NULL
     SET s.is_active = FALSE, s.ended_at_utc = UTC_TIMESTAMP()
     WHERE s.is_active = TRUE AND a.id IS NULL`,
  ).catch(() => {}); // tracking tables absent in a legacy DB — nothing to reap

  return closed;
}

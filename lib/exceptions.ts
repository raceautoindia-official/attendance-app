import { query } from '@/lib/db';
import { toYmd } from '@/lib/date';
import { OVERTIME_AFTER_MINUTES } from '@/lib/constants';
import { dayRequiredMinutesOrNullSelect } from '@/lib/shifts';

/**
 * lib/exceptions.ts — what needs a decision before this month can be closed.
 *
 * WHY
 * ---
 * Every other view in this app answers a question you already thought to ask.
 * This one is the opposite: it is the list of things that would have been worth
 * noticing, surfaced without anybody having to go looking.
 *
 * Addakatta Akash worked 24 days in September averaging 4h 48m against a 9h
 * roster. Nothing was broken, no report was wrong, and nobody found out until
 * an audit in October. A monthly total hid it, and a day-by-day table showed it
 * only to someone already reading his page. That is the gap this closes.
 *
 * WHAT IT IS NOT
 * --------------
 * It is not a judgement. Every entry here has an innocent explanation as well
 * as a worrying one — a 15-hour day is a forgotten clock-out or a genuine
 * double shift, and the app cannot tell which. So each exception states what
 * was observed and what to check, and none of them is called a problem.
 *
 * Nothing here writes. It reads the same tables every report reads, so an
 * exception and the report it came from can never disagree.
 */

export type Severity = 'critical' | 'warning' | 'info';

export interface Exception {
  /** Stable within a period, so the UI can key and dismiss by it. */
  id: string;
  type: string;
  severity: Severity;
  employee: { id: number; name: string; emp_id: string } | null;
  /** The day it concerns, when it concerns one. */
  date: string | null;
  title: string;
  detail: string;
  /** What to do about it, in the imperative. */
  action: string;
}

export interface ExceptionReport {
  period: { from_date: string; to_date: string };
  counts: { critical: number; warning: number; info: number; total: number };
  exceptions: Exception[];
  /** True when nothing needs attention — worth saying out loud. */
  clear: boolean;
}

/** A day shorter than this fraction of its requirement is worth a look. */
const SHORT_DAY_RATIO = 0.6;
/** Averaging below this fraction across a period is a pattern, not a bad day. */
const LOW_AVERAGE_RATIO = 0.75;
/** Fewer worked days than this and an average means nothing. */
const MIN_DAYS_FOR_AVERAGE = 5;
/** Longer than this on the clock is usually a clock-out nobody made. */
const IMPLAUSIBLE_DAY_MINUTES = 14 * 60;
/** Consecutive absences worth asking about. */
const ABSENCE_STREAK = 5;

const emp = (r: { employee_id: number; name: string; emp_id: string }) =>
  ({ id: r.employee_id, name: r.name, emp_id: r.emp_id });

const hm = (m: number) => {
  const v = Math.max(0, Math.round(m));
  const h = Math.floor(v / 60);
  return h ? `${h}h ${v % 60}m` : `${v % 60}m`;
};

/**
 * Everything worth a second look in a period.
 *
 * Each block is a separate query rather than one clever join: they are easier
 * to read, easier to change one at a time, and the cost is trivial at this size.
 */
export async function findExceptions(
  fromDate: string,
  toDate: string,
): Promise<ExceptionReport> {
  const out: Exception[] = [];

  // --- Still clocked in ---------------------------------------------------
  // Their hours are not final, so closing the month would freeze a figure that
  // was never settled.
  const open = await query<{ employee_id: number; name: string; emp_id: string; work_date: Date | string }>(
    `SELECT a.employee_id, e.name, e.emp_id, a.work_date
       FROM attendance a JOIN employees e ON e.id = a.employee_id
      WHERE a.work_date BETWEEN ? AND ?
        AND a.clock_in_utc IS NOT NULL AND a.clock_out_utc IS NULL
      ORDER BY a.work_date`,
    [fromDate, toDate],
  );
  for (const r of open) {
    const d = toYmd(r.work_date);
    out.push({
      id: `open:${r.employee_id}:${d}`,
      type: 'open_session',
      severity: 'critical',
      employee: emp(r),
      date: d,
      title: 'Still clocked in',
      detail: `${r.name} clocked in on ${d} and never clocked out, so the hours for that day are not final.`,
      action: 'Set the clock-out time on the attendance record before closing the month.',
    });
  }

  // --- Implausibly long days ---------------------------------------------
  const long = await query<{
    employee_id: number; name: string; emp_id: string; work_date: Date | string; total_minutes: number;
  }>(
    `SELECT a.employee_id, e.name, e.emp_id, a.work_date, a.total_minutes
       FROM attendance a JOIN employees e ON e.id = a.employee_id
      WHERE a.work_date BETWEEN ? AND ?
        AND a.total_minutes > ?
      ORDER BY a.total_minutes DESC`,
    [fromDate, toDate, IMPLAUSIBLE_DAY_MINUTES],
  );
  for (const r of long) {
    const d = toYmd(r.work_date);
    out.push({
      id: `long:${r.employee_id}:${d}`,
      type: 'implausible_day',
      severity: 'warning',
      employee: emp(r),
      date: d,
      title: `${hm(Number(r.total_minutes))} in one day`,
      detail: `${r.name} is recorded as working ${hm(Number(r.total_minutes))} on ${d}.`,
      action: 'Check whether this was a genuine long shift or a clock-out that was never made.',
    });
  }

  // --- Days far below what the roster asked -------------------------------
  const short = await query<{
    employee_id: number; name: string; emp_id: string; work_date: Date | string;
    total_minutes: number; required: number | null;
  }>(
    `SELECT a.employee_id, e.name, e.emp_id, a.work_date, a.total_minutes,
            ${dayRequiredMinutesOrNullSelect('a.employee_id', 'a.work_date')} AS required
       FROM attendance a JOIN employees e ON e.id = a.employee_id
      WHERE a.work_date BETWEEN ? AND ?
        AND a.total_minutes IS NOT NULL
        AND a.total_minutes > 0
        AND a.clock_out_utc IS NOT NULL
      HAVING required IS NOT NULL
         AND required > 0
         AND a.total_minutes < required * ?
      ORDER BY a.work_date`,
    [fromDate, toDate, SHORT_DAY_RATIO],
  );
  for (const r of short) {
    const d = toYmd(r.work_date);
    const worked = Number(r.total_minutes);
    const req = Number(r.required);
    out.push({
      id: `short:${r.employee_id}:${d}`,
      type: 'short_day',
      severity: 'info',
      employee: emp(r),
      date: d,
      title: `Half a day or less`,
      detail: `${r.name} worked ${hm(worked)} on ${d} against ${hm(req)} required.`,
      action: 'Confirm whether this was half-day leave, a permission, or an early finish.',
    });
  }

  // --- A low average across the whole period ------------------------------
  // This is the one that would have caught Akash.
  const lowAvg = await query<{
    employee_id: number; name: string; emp_id: string;
    days: number; worked: number; required: number;
  }>(
    `SELECT a.employee_id, e.name, e.emp_id,
            COUNT(*) AS days,
            SUM(a.total_minutes) AS worked,
            SUM(${dayRequiredMinutesOrNullSelect('a.employee_id', 'a.work_date')}) AS required
       FROM attendance a JOIN employees e ON e.id = a.employee_id
      WHERE a.work_date BETWEEN ? AND ?
        AND a.total_minutes > 0
        AND a.clock_out_utc IS NOT NULL
      GROUP BY a.employee_id, e.name, e.emp_id
     HAVING days >= ? AND required > 0 AND worked < required * ?`,
    [fromDate, toDate, MIN_DAYS_FOR_AVERAGE, LOW_AVERAGE_RATIO],
  );
  for (const r of lowAvg) {
    const days = Number(r.days);
    const avg = Number(r.worked) / days;
    const reqAvg = Number(r.required) / days;
    out.push({
      id: `lowavg:${r.employee_id}`,
      type: 'low_average',
      severity: 'warning',
      employee: emp(r),
      date: null,
      title: `Averaging ${hm(avg)} a day`,
      detail:
        `${r.name} worked ${days} days in this period averaging ${hm(avg)}, against `
        + `${hm(reqAvg)} required. That is a pattern across the period, not one short day.`,
      action:
        'Check whether this is a part-time arrangement the roster does not record, '
        + 'or something to raise with them.',
    });
  }

  // --- Rostered but nothing recorded --------------------------------------
  const dormant = await query<{ employee_id: number; name: string; emp_id: string; last_seen: Date | string | null }>(
    `SELECT e.id AS employee_id, e.name, e.emp_id,
            (SELECT MAX(a2.work_date) FROM attendance a2
              WHERE a2.employee_id = e.id AND a2.clock_in_utc IS NOT NULL) AS last_seen
       FROM employees e
      WHERE e.is_active = TRUE
        AND e.role = 'employee'
        AND EXISTS (SELECT 1 FROM employee_schedules es WHERE es.employee_id = e.id)
        -- A clock-in with no clock-out has NULL minutes, so testing only
        -- total_minutes would report somebody mid-shift as having recorded
        -- nothing all month. They are already flagged as an open session; this
        -- list is for people who never turned up at all.
        AND NOT EXISTS (
          SELECT 1 FROM attendance a
           WHERE a.employee_id = e.id
             AND a.work_date BETWEEN ? AND ?
             AND (a.total_minutes > 0 OR a.clock_in_utc IS NOT NULL))
      ORDER BY e.name`,
    [fromDate, toDate],
  );
  for (const r of dormant) {
    const last = r.last_seen ? toYmd(r.last_seen) : null;
    out.push({
      id: `dormant:${r.employee_id}`,
      type: 'no_activity',
      severity: 'warning',
      employee: emp(r),
      date: null,
      title: 'No hours at all this period',
      detail: `${r.name} is active and rostered but recorded nothing. `
        + (last ? `Last clocked in on ${last}.` : 'Has never clocked in.'),
      action: 'If they have left, deactivate them — they distort every average until you do.',
    });
  }

  // --- Active but never rostered ------------------------------------------
  const unrostered = await query<{ employee_id: number; name: string; emp_id: string }>(
    `SELECT e.id AS employee_id, e.name, e.emp_id
       FROM employees e
      WHERE e.is_active = TRUE
        AND e.role = 'employee'
        AND NOT EXISTS (SELECT 1 FROM employee_schedules es WHERE es.employee_id = e.id)
      ORDER BY e.name`,
  );
  for (const r of unrostered) {
    out.push({
      id: `noroster:${r.employee_id}`,
      type: 'no_roster',
      severity: 'warning',
      employee: emp(r),
      date: null,
      title: 'No shift assigned',
      detail: `${r.name} has no shift, so the app cannot say what hours are expected of them. `
        + 'They are left out of every hours comparison.',
      action: 'Assign a shift, or deactivate them if they have left.',
    });
  }

  // --- Long runs of absence -----------------------------------------------
  const absences = await query<{ employee_id: number; name: string; emp_id: string; work_date: Date | string }>(
    `SELECT a.employee_id, e.name, e.emp_id, a.work_date
       FROM attendance a JOIN employees e ON e.id = a.employee_id
      WHERE a.work_date BETWEEN ? AND ?
        AND a.status = 'absent'
        AND e.is_active = TRUE
      ORDER BY a.employee_id, a.work_date`,
    [fromDate, toDate],
  );
  const byEmployee = new Map<number, { r: typeof absences[number]; dates: string[] }>();
  for (const r of absences) {
    const entry = byEmployee.get(r.employee_id) ?? { r, dates: [] };
    entry.dates.push(toYmd(r.work_date));
    byEmployee.set(r.employee_id, entry);
  }
  for (const [id, { r, dates }] of byEmployee) {
    // Longest run of consecutive calendar days.
    let best = 1;
    let run = 1;
    for (let i = 1; i < dates.length; i++) {
      const gap = (Date.parse(`${dates[i]}T00:00:00Z`) - Date.parse(`${dates[i - 1]}T00:00:00Z`)) / 86_400_000;
      run = gap === 1 ? run + 1 : 1;
      if (run > best) best = run;
    }
    // Somebody already flagged as recording nothing all period does not also
    // need "absent six days running" — it is the same fact told twice, and a
    // review list that repeats itself trains people to skim it.
    const alreadyDormant = out.some(e => e.type === 'no_activity' && e.employee?.id === id);
    if (best >= ABSENCE_STREAK && !alreadyDormant) {
      out.push({
        id: `streak:${id}`,
        type: 'absence_streak',
        severity: 'info',
        employee: emp(r),
        date: null,
        title: `${best} days absent in a row`,
        detail: `${r.name} has a run of ${best} consecutive absences in this period, `
          + `out of ${dates.length} absent days.`,
        action: 'Check whether this should have been recorded as leave.',
      });
    }
  }

  // --- Geofence ------------------------------------------------------------
  const fence = await query<{ employee_id: number; name: string; emp_id: string; n: number }>(
    `SELECT a.employee_id, e.name, e.emp_id, COUNT(*) AS n
       FROM attendance a JOIN employees e ON e.id = a.employee_id
      WHERE a.work_date BETWEEN ? AND ?
        AND a.geofence_status = 'outside'
      GROUP BY a.employee_id, e.name, e.emp_id
      ORDER BY n DESC`,
    [fromDate, toDate],
  );
  for (const r of fence) {
    out.push({
      id: `fence:${r.employee_id}`,
      type: 'geofence',
      severity: 'info',
      employee: emp(r),
      date: null,
      title: `${r.n} clock-in${Number(r.n) === 1 ? '' : 's'} outside the site`,
      detail: `${r.name} clocked in from outside their geofence ${r.n} time(s) in this period.`,
      action: 'Expected for field work; worth a look otherwise.',
    });
  }

  // --- Schedules with an impossible validity window ------------------------
  const inverted = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM employee_schedules
      WHERE effective_to IS NOT NULL AND effective_to < effective_from`,
  );
  if (Number(inverted[0]?.n ?? 0) > 0) {
    out.push({
      id: 'inverted-schedules',
      type: 'data_integrity',
      severity: 'info',
      employee: null,
      date: null,
      title: 'Shift assignments with an impossible date range',
      detail: `${inverted[0].n} roster row(s) end before they begin. The app treats them as `
        + 'not current, so no figure is wrong — but the roster history cannot be trusted.',
      action: 'Tidy them up so the assignment history can be audited.',
    });
  }

  const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  out.sort((a, b) => order[a.severity] - order[b.severity]
    || a.type.localeCompare(b.type)
    || (a.employee?.name ?? '').localeCompare(b.employee?.name ?? ''));

  const counts = {
    critical: out.filter(e => e.severity === 'critical').length,
    warning: out.filter(e => e.severity === 'warning').length,
    info: out.filter(e => e.severity === 'info').length,
    total: out.length,
  };

  return {
    period: { from_date: fromDate, to_date: toDate },
    counts,
    exceptions: out,
    clear: counts.total === 0,
  };
}

/** Exported for the tests — thresholds are policy, so they are visible. */
export const THRESHOLDS = {
  SHORT_DAY_RATIO,
  LOW_AVERAGE_RATIO,
  MIN_DAYS_FOR_AVERAGE,
  IMPLAUSIBLE_DAY_MINUTES,
  ABSENCE_STREAK,
  OVERTIME_AFTER_MINUTES,
};

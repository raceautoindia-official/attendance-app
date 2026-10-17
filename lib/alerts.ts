import { query, queryOne, insertAuditLog } from '@/lib/db';
import { toYmd } from '@/lib/date';
import { getWorkDateIST } from '@/lib/attendance';
import { expectedButMissing } from '@/lib/markAbsent';
import { buildHoursLedger } from '@/lib/hoursLedger';
import { getClosure } from '@/lib/monthClose';
import { hasPermissionTable } from '@/lib/permissions';

/**
 * lib/alerts.ts — what the database already knows, said out loud.
 *
 * WHY
 * ---
 * Repeated lateness, heavy leave and a person who has simply not clocked in
 * are facts this database holds by nine in the morning. Nothing said them.
 * Month review says some of them, once a month, and only to somebody who
 * opens it.
 *
 * FOUR RULES OF ENGAGEMENT, AND THEY ARE THE WHOLE DESIGN
 * -------------------------------------------------------
 * 1. NOTHING FIRES UNTIL SOMEBODY MEANS IT. The pattern rules read their
 *    threshold from the employee's POLICY, and a NULL threshold is off. A
 *    deployment therefore changes nobody's morning.
 *
 * 2. ONE ROW PER EMPLOYEE PER RULE PER PERIOD, updated in place. A week of
 *    lateness is one alert with a rising count. Seven rows is how a queue gets
 *    abandoned.
 *
 * 3. THEY RESOLVE THEMSELVES. Every run recomputes, and an alert whose fact has
 *    gone - leave approved retrospectively, attendance corrected - is resolved
 *    rather than left for somebody to tidy. A stale alert nobody can clear is
 *    the same failure as no alert at all.
 *
 * 4. THEY AGREE WITH THE REPORTS. Lateness and hours come from
 *    `buildHoursLedger`, the same function the Reports page and the payroll
 *    pack read. An alert that disagreed with the report it came from would be
 *    worse than silence, because somebody would have to work out which to
 *    believe.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * Nothing that lib/inbox.ts already carries. Pending permission requests,
 * correction requests and unreviewed off-site clock-ins are read from their own
 * tables and shown in the same queue; a rule restating them would double every
 * count and the badge would stop meaning anything.
 */

export type AlertSeverity = 'critical' | 'warning' | 'info';
export type AlertFamily = 'live' | 'pattern' | 'lifecycle';
export type AlertState = 'open' | 'acknowledged' | 'resolved';

/** One thing a rule found. */
export interface Finding {
  /** Null for a fact about the company rather than a person. */
  employeeId: number | null;
  /** '2026-10', '2026-10-12', or 'standing'. */
  periodKey: string;
  title: string;
  body: string;
  severity?: AlertSeverity;
  detail?: Record<string, unknown>;
}

export interface RuleResult {
  findings: Finding[];
  /**
   * The periods this run actually looked at.
   *
   * Resolution is scoped to these. Without it, evaluating October would resolve
   * every September alert as "no longer true" - which is correct about October
   * and a lie about September.
   */
  periods: string[];
}

export interface AlertRule {
  key: string;
  family: AlertFamily;
  severity: AlertSeverity;
  /** The policy column that switches it on, when it has one. */
  threshold: string | null;
  evaluate(now: Date): Promise<RuleResult>;
}

export interface AlertRow {
  id: number;
  rule_key: string;
  employee_id: number | null;
  employee_name: string | null;
  emp_id: string | null;
  period_key: string;
  severity: AlertSeverity;
  state: AlertState;
  title: string;
  body: string;
  detail: Record<string, unknown> | null;
  first_seen_at: string;
  last_seen_at: string;
  acknowledged_by_name: string | null;
  acknowledged_at: string | null;
  acknowledge_note: string | null;
  snoozed_until: string | null;
  rule_label: string;
}

export class AlertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlertError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const monthOf = (date: string) => date.slice(0, 7);

function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  return { from: `${month}-01`, to: toYmd(new Date(Date.UTC(y, m, 0))) };
}

const hm = (minutes: number) => {
  const v = Math.max(0, Math.round(minutes));
  return `${Math.floor(v / 60)}h ${String(v % 60).padStart(2, '0')}m`;
};

/**
 * Everybody active, with the alert thresholds from the policy in force today.
 *
 * A LEFT JOIN, so an employee with no policy comes back with NULLs rather than
 * vanishing - the caller then skips them, which is the same as "off". Sixteen
 * people currently have no policy, and silently dropping them would make the
 * absence of alerts look like good news.
 */
async function employeesWithThresholds(onDate: string) {
  return query<{
    id: number; name: string; emp_id: string;
    late_alert_days_per_month: number | null;
    leave_alert_days_per_month: number | null;
    missing_clockin_alert_minutes: number | null;
    low_hours_alert_ratio: string | null;
  }>(
    `SELECT e.id, e.name, e.emp_id,
            p.late_alert_days_per_month,
            p.leave_alert_days_per_month,
            p.missing_clockin_alert_minutes,
            p.low_hours_alert_ratio
       FROM employees e
       LEFT JOIN employee_policies ep
         ON ep.employee_id = e.id
        AND ep.effective_from <= ?
        AND (ep.effective_to IS NULL OR ep.effective_to >= ?)
       LEFT JOIN policies p ON p.id = ep.policy_id AND p.is_active = TRUE
      WHERE e.is_active = TRUE
      ORDER BY e.name`,
    [onDate, onDate],
  );
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * Rostered to work today, grace period gone, still nothing clocked.
 *
 * The population comes from `expectedButMissing`, which is the same function
 * the nightly absence job and the Overview page use - so "expected to work
 * today" has exactly one definition in this codebase. This rule adds only the
 * clock: shift start, plus the shift's grace, plus the policy's allowance.
 *
 * Flexible shifts are skipped, and that is not a nicety. Twelve of eighteen
 * active people are on flexible hours and have no start time to be late
 * against; a rule that named them every morning would get the whole feature
 * muted in week one.
 */
const notClockedIn: AlertRule = {
  key: 'not_clocked_in',
  family: 'live',
  severity: 'warning',
  threshold: 'missing_clockin_alert_minutes',
  async evaluate(now) {
    const workDate = getWorkDateIST(now);
    const missing = await expectedButMissing(workDate);
    if (missing.length === 0) return { findings: [], periods: [workDate] };

    const thresholds = new Map(
      (await employeesWithThresholds(workDate)).map(e => [e.id, e]),
    );

    // The shift each of them is on today, with its start and grace. Only fixed
    // and rotating shifts have a start; flexible ones are excluded here, in SQL,
    // rather than filtered later - there is nothing to compute for them.
    const ids = missing.map(m => m.id);
    const shifts = await query<{
      employee_id: number; start_time: string | null;
      grace_minutes: number | null; type: string;
    }>(
      `SELECT es.employee_id, s.start_time, s.grace_minutes, s.type
         FROM employee_schedules es
         JOIN shifts s ON s.id = es.shift_id
        WHERE es.employee_id IN (${ids.map(() => '?').join(',')})
          AND es.effective_from <= ?
          AND (es.effective_to IS NULL OR es.effective_to >= ?)
          AND s.type <> 'flexible'
          AND s.start_time IS NOT NULL
        ORDER BY s.start_time`,
      [...ids, workDate, workDate],
    );
    // Earliest shift wins for anybody on two: the first one they were due at is
    // the one they are late for.
    const shiftOf = new Map<number, typeof shifts[number]>();
    for (const s of shifts) if (!shiftOf.has(s.employee_id)) shiftOf.set(s.employee_id, s);

    // An approved permission covering the start of the day is permission to
    // arrive late. Asking about it afterwards is the fastest way to teach
    // somebody that the alerts are not worth reading.
    const excused = new Set<number>();
    if (await hasPermissionTable()) {
      const rows = await query<{ employee_id: number }>(
        `SELECT DISTINCT employee_id FROM permission_requests
          WHERE permission_date = ? AND status = 'approved'`,
        [workDate],
      );
      for (const r of rows) excused.add(r.employee_id);
    }

    const findings: Finding[] = [];
    for (const person of missing) {
      const limits = thresholds.get(person.id);
      const allowance = limits?.missing_clockin_alert_minutes;
      if (allowance === null || allowance === undefined) continue;  // off
      if (excused.has(person.id)) continue;

      const shift = shiftOf.get(person.id);
      if (!shift?.start_time) continue;  // flexible, or no roster: nothing to measure

      const [h, m] = shift.start_time.split(':').map(Number);
      // IST, because that is the timezone every shift in this deployment is
      // written in and the work date is already an IST date.
      const dueUtc = Date.parse(`${workDate}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`);
      const cutoff = dueUtc + ((shift.grace_minutes ?? 0) + Number(allowance)) * 60_000;
      if (now.getTime() < cutoff) continue;  // still inside their allowance

      const lateBy = Math.round((now.getTime() - dueUtc) / 60_000);
      findings.push({
        employeeId: person.id,
        periodKey: workDate,
        title: `${person.name} has not clocked in`,
        body: `Due at ${shift.start_time.slice(0, 5)} and nothing recorded `
          + `${hm(lateBy)} later. No leave, no holiday and no approved permission for today.`,
        detail: {
          work_date: workDate,
          due_at: shift.start_time.slice(0, 5),
          grace_minutes: shift.grace_minutes ?? 0,
          allowance_minutes: Number(allowance),
          minutes_past_due: lateBy,
        },
      });
    }
    return { findings, periods: [workDate] };
  },
};

/**
 * Late on more days this month than the policy allows.
 *
 * Counts `days_late` from the hours ledger - the same number the Reports page
 * and every export show - and refuses to fire when `late_measured_days` is
 * zero, because zero late days out of nothing measured is not a good record,
 * it is no record.
 */
const latePattern: AlertRule = {
  key: 'late_pattern',
  family: 'pattern',
  severity: 'warning',
  threshold: 'late_alert_days_per_month',
  async evaluate(now) {
    const today = getWorkDateIST(now);
    const month = monthOf(today);
    const { from } = monthBounds(month);
    const findings: Finding[] = [];

    for (const person of await employeesWithThresholds(today)) {
      const limit = person.late_alert_days_per_month;
      if (limit === null || limit === undefined) continue;

      const ledger = await buildHoursLedger({
        employeeId: person.id, fromDate: from, toDate: today,
      });
      if (!ledger) continue;
      const { days_late, late_measured_days } = ledger.totals;
      if (late_measured_days === 0) continue;  // nothing to measure against
      if (days_late < Number(limit)) continue;

      findings.push({
        employeeId: person.id,
        periodKey: month,
        title: `${person.name} has been late ${days_late} times this month`,
        body: `${days_late} late days out of ${late_measured_days} where arrival `
          + `could be measured. The policy flags this at ${limit}.`,
        severity: days_late >= Number(limit) * 2 ? 'critical' : 'warning',
        detail: {
          month, days_late, late_measured_days,
          threshold: Number(limit),
          late_minutes: ledger.totals.late_minutes,
        },
      });
    }
    return { findings, periods: [month] };
  },
};

/** Leave this month has reached the number the policy says is worth a word. */
const leavePattern: AlertRule = {
  key: 'leave_pattern',
  family: 'pattern',
  severity: 'info',
  threshold: 'leave_alert_days_per_month',
  async evaluate(now) {
    const today = getWorkDateIST(now);
    const month = monthOf(today);
    const { from, to } = monthBounds(month);
    const findings: Finding[] = [];

    const people = (await employeesWithThresholds(today))
      .filter(p => p.leave_alert_days_per_month !== null);
    if (people.length === 0) return { findings, periods: [month] };

    // One query for everybody, grouped. 'holiday' is excluded: a company
    // holiday is not leave somebody took, and counting it would alert on
    // Diwali.
    const counts = await query<{ employee_id: number; days: number; types: string }>(
      `SELECT lr.employee_id, COUNT(*) AS days,
              GROUP_CONCAT(DISTINCT lr.leave_type ORDER BY lr.leave_type) AS types
         FROM leave_records lr
        WHERE lr.leave_date BETWEEN ? AND ?
          AND lr.employee_id IS NOT NULL
          AND lr.leave_type <> 'holiday'
          AND lr.employee_id IN (${people.map(() => '?').join(',')})
        GROUP BY lr.employee_id`,
      [from, to, ...people.map(p => p.id)],
    );
    const byId = new Map(counts.map(c => [c.employee_id, c]));

    for (const person of people) {
      const limit = Number(person.leave_alert_days_per_month);
      const row = byId.get(person.id);
      const days = Number(row?.days ?? 0);
      if (days < limit) continue;
      findings.push({
        employeeId: person.id,
        periodKey: month,
        title: `${person.name} has taken ${days} days of leave this month`,
        body: `${row?.types ?? 'leave'} - the policy flags this at ${limit} days. `
          + `Company holidays are not counted.`,
        detail: { month, leave_days: days, types: row?.types ?? null, threshold: limit },
      });
    }
    return { findings, periods: [month] };
  },
};

/** Credited hours well below what the roster asked for. */
const lowHoursPattern: AlertRule = {
  key: 'low_hours_pattern',
  family: 'pattern',
  severity: 'warning',
  threshold: 'low_hours_alert_ratio',
  async evaluate(now) {
    const today = getWorkDateIST(now);
    const month = monthOf(today);
    const { from } = monthBounds(month);
    const findings: Finding[] = [];

    for (const person of await employeesWithThresholds(today)) {
      const ratioSetting = person.low_hours_alert_ratio;
      if (ratioSetting === null || ratioSetting === undefined) continue;
      const limit = Number(ratioSetting);
      if (!Number.isFinite(limit) || limit <= 0) continue;

      const ledger = await buildHoursLedger({
        employeeId: person.id, fromDate: from, toDate: today,
      });
      if (!ledger) continue;
      const { required_minutes, credited_minutes, days_worked } = ledger.totals;
      // A ratio over one or two days is noise: somebody who joined on the 28th
      // is not a performance concern.
      if (days_worked < 5 || required_minutes <= 0) continue;

      const ratio = credited_minutes / required_minutes;
      if (ratio >= limit) continue;

      findings.push({
        employeeId: person.id,
        periodKey: month,
        title: `${person.name} is well below the roster this month`,
        body: `${hm(credited_minutes)} credited against ${hm(required_minutes)} required `
          + `across ${days_worked} days - ${Math.round(ratio * 100)}%, where the policy `
          + `expects at least ${Math.round(limit * 100)}%.`,
        severity: ratio < limit * 0.75 ? 'critical' : 'warning',
        detail: {
          month, required_minutes, credited_minutes, days_worked,
          ratio: Number(ratio.toFixed(3)), threshold: limit,
        },
      });
    }
    return { findings, periods: [month] };
  },
};

/** A probation period ending, while there is still time to decide. */
const probationEnding: AlertRule = {
  key: 'probation_ending',
  family: 'lifecycle',
  severity: 'info',
  threshold: null,
  async evaluate(now) {
    const today = getWorkDateIST(now);
    const rows = await query<{
      id: number; name: string; emp_id: string;
      probation_ends_on: Date | string; days_left: number;
    }>(
      `SELECT id, name, emp_id, probation_ends_on,
              DATEDIFF(probation_ends_on, ?) AS days_left
         FROM employees
        WHERE is_active = TRUE
          AND probation_ends_on IS NOT NULL
          AND probation_ends_on BETWEEN ? AND DATE_ADD(?, INTERVAL 14 DAY)
        ORDER BY probation_ends_on`,
      [today, today, today],
    );
    return {
      findings: rows.map(r => ({
        employeeId: r.id,
        // Keyed to the end date, not the month: an alert about a date should
        // not reappear as a second row when that date crosses a month.
        periodKey: toYmd(r.probation_ends_on),
        title: `${r.name}'s probation ends in ${Number(r.days_left)} days`,
        body: `Probation ends ${toYmd(r.probation_ends_on)}. Confirm, extend or end it `
          + `before that date rather than after.`,
        detail: {
          ends_on: toYmd(r.probation_ends_on),
          days_left: Number(r.days_left),
        },
      })),
      periods: rows.map(r => toYmd(r.probation_ends_on)),
    };
  },
};

/** A joining or leaving task past its date. */
const onboardingOverdue: AlertRule = {
  key: 'onboarding_overdue',
  family: 'lifecycle',
  severity: 'warning',
  threshold: null,
  async evaluate(now) {
    const today = getWorkDateIST(now);
    const rows = await query<{
      employee_id: number; name: string; emp_id: string;
      direction: string; overdue: number; blocking: number; oldest: Date | string;
    }>(
      `SELECT j.employee_id, e.name, e.emp_id, j.direction,
              COUNT(*) AS overdue,
              SUM(t.is_blocking) AS blocking,
              MIN(t.due_on) AS oldest
         FROM employee_onboarding_tasks t
         JOIN employee_onboarding j ON j.id = t.journey_id
         JOIN employees e ON e.id = j.employee_id
        WHERE t.status = 'pending'
          AND t.due_on IS NOT NULL
          AND t.due_on < ?
          AND j.status = 'in_progress'
        GROUP BY j.employee_id, e.name, e.emp_id, j.direction`,
      [today],
    );
    return {
      findings: rows.map(r => ({
        employeeId: r.employee_id,
        periodKey: 'standing',
        title: `${r.name} has ${Number(r.overdue)} overdue ${r.direction} task${Number(r.overdue) === 1 ? '' : 's'}`,
        body: `Oldest was due ${toYmd(r.oldest)}.`
          + (Number(r.blocking) > 0
            ? ` ${Number(r.blocking)} of them block the checklist from completing.`
            : ''),
        severity: Number(r.blocking) > 0 ? 'critical' : 'warning',
        detail: {
          overdue: Number(r.overdue),
          blocking: Number(r.blocking),
          oldest_due: toYmd(r.oldest),
          direction: r.direction,
        },
      })),
      periods: ['standing'],
    };
  },
};

/**
 * Last month is still open.
 *
 * A company-level fact, so it has no employee - which is the reason the alerts
 * table carries a generated `employee_key`.
 */
const monthNotClosed: AlertRule = {
  key: 'month_not_closed',
  family: 'lifecycle',
  severity: 'info',
  threshold: null,
  async evaluate(now) {
    const today = getWorkDateIST(now);
    const day = Number(today.slice(8, 10));
    const d = new Date(`${today}T00:00:00Z`);
    const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
    const month = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;

    // Not before the 7th: a month that ended on Saturday is not overdue on
    // Monday, and an alert that appears every 1st and clears itself by the 5th
    // teaches people to ignore it.
    if (day < 7) return { findings: [], periods: [month] };

    const closure = await getClosure(month);
    if (closure?.is_closed) return { findings: [], periods: [month] };

    return {
      findings: [{
        employeeId: null,
        periodKey: month,
        title: `${month} has not been closed`,
        body: 'Its attendance can still be edited, so a figure already used to pay '
          + 'somebody can still change. Close it from Month review.',
        detail: { month, day_of_month: day },
      }],
      periods: [month],
    };
  },
};

export const RULES: readonly AlertRule[] = [
  notClockedIn, latePattern, leavePattern, lowHoursPattern,
  probationEnding, onboardingOverdue, monthNotClosed,
];

// ---------------------------------------------------------------------------
// Running them
// ---------------------------------------------------------------------------

export interface RunSummary {
  ran: string[];
  skipped: string[];
  opened: number;
  updated: number;
  resolved: number;
}

/**
 * Evaluate the rules of a family and reconcile the table against what they
 * found.
 *
 * Reconcile, not append: anything open for a period this run covered and not
 * found again is resolved. That is what makes the queue self-cleaning, and it
 * is why each rule reports the periods it looked at.
 */
export async function runAlerts(opts: {
  family?: AlertFamily;
  only?: string[];
  now?: Date;
} = {}): Promise<RunSummary> {
  const now = opts.now ?? new Date();
  const enabled = new Set(
    (await query<{ rule_key: string }>(
      `SELECT rule_key FROM alert_rules WHERE is_enabled = TRUE`,
    )).map(r => r.rule_key),
  );

  const summary: RunSummary = { ran: [], skipped: [], opened: 0, updated: 0, resolved: 0 };

  for (const rule of RULES) {
    if (opts.family && rule.family !== opts.family) continue;
    if (opts.only && !opts.only.includes(rule.key)) continue;
    if (!enabled.has(rule.key)) { summary.skipped.push(rule.key); continue; }

    const { findings, periods } = await rule.evaluate(now);
    summary.ran.push(rule.key);

    for (const f of findings) {
      const before = await queryOne<{ id: number }>(
        `SELECT id FROM alerts
          WHERE rule_key = ? AND employee_key = COALESCE(?, 0) AND period_key = ?`,
        [rule.key, f.employeeId, f.periodKey],
      );
      await query(
        `INSERT INTO alerts
           (rule_key, employee_id, period_key, severity, state, title, body, detail,
            first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?, CAST(? AS JSON), ?, ?)
         ON DUPLICATE KEY UPDATE
           severity = VALUES(severity),
           title = VALUES(title),
           body = VALUES(body),
           detail = VALUES(detail),
           last_seen_at = VALUES(last_seen_at),
           -- A fact that comes back after being resolved is open again. An
           -- acknowledged one stays acknowledged: somebody has already dealt
           -- with it and saying it again is nagging.
           state = IF(state = 'resolved', 'open', state),
           resolved_at = IF(state = 'resolved', NULL, resolved_at)`,
        [
          rule.key, f.employeeId, f.periodKey, f.severity ?? rule.severity,
          f.title, f.body, JSON.stringify(f.detail ?? {}), now, now,
        ],
      );
      if (before) summary.updated += 1; else summary.opened += 1;
    }

    if (periods.length > 0) {
      const found = findings.map(f => `${f.employeeId ?? 0}:${f.periodKey}`);
      const result = await query<never>(
        `UPDATE alerts
            SET state = 'resolved', resolved_at = ?
          WHERE rule_key = ?
            AND period_key IN (${periods.map(() => '?').join(',')})
            AND state <> 'resolved'
            ${found.length > 0
              ? `AND CONCAT(employee_key, ':', period_key) NOT IN (${found.map(() => '?').join(',')})`
              : ''}`,
        [now, rule.key, ...periods, ...found],
      ) as unknown as { affectedRows?: number };
      summary.resolved += Number(result?.affectedRows ?? 0);
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Reading and clearing
// ---------------------------------------------------------------------------

/**
 * Open alerts, narrowed to what the caller may see.
 *
 * Snoozed alerts are left out by default. They are not resolved - the fact is
 * still true and the row still says so - they are just not today's problem.
 */
export async function listAlerts(opts: {
  scopeSql?: string;
  scopeParams?: number[];
  states?: AlertState[];
  includeSnoozed?: boolean;
  employeeId?: number;
  limit?: number;
} = {}): Promise<AlertRow[]> {
  const states = opts.states ?? ['open', 'acknowledged'];
  const params: unknown[] = [];
  const where: string[] = [];

  where.push(`a.state IN (${states.map(() => '?').join(',')})`);
  params.push(...states);

  if (!opts.includeSnoozed) where.push(`(a.snoozed_until IS NULL OR a.snoozed_until < CURDATE())`);

  if (opts.employeeId !== undefined) {
    where.push(`a.employee_id = ?`);
    params.push(opts.employeeId);
  } else if (opts.scopeSql && opts.scopeSql !== '1 = 1') {
    // A company-level alert has no employee, so it cannot be scoped to a
    // department. It belongs to whoever can see everybody.
    where.push(`(a.employee_id IS NOT NULL AND ${opts.scopeSql})`);
    params.push(...(opts.scopeParams ?? []));
  }

  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);

  return query<AlertRow>(
    `SELECT a.id, a.rule_key, a.employee_id, e.name AS employee_name, e.emp_id,
            a.period_key, a.severity, a.state, a.title, a.body, a.detail,
            a.first_seen_at, a.last_seen_at, a.acknowledged_at, a.acknowledge_note,
            a.snoozed_until, ack.name AS acknowledged_by_name,
            r.label AS rule_label
       FROM alerts a
       LEFT JOIN employees e ON e.id = a.employee_id
       LEFT JOIN employees ack ON ack.id = a.acknowledged_by
       LEFT JOIN alert_rules r ON r.rule_key = a.rule_key
      WHERE ${where.join(' AND ')}
      ORDER BY FIELD(a.severity, 'critical', 'warning', 'info'), a.first_seen_at
      LIMIT ${limit}`,
    params,
  );
}

/** Acknowledge, with the note that is usually the whole outcome. */
export async function acknowledgeAlert(params: {
  id: number; by: number; note?: string | null; ip?: string | null;
}): Promise<void> {
  const alert = await queryOne<{ id: number; rule_key: string; employee_id: number | null }>(
    `SELECT id, rule_key, employee_id FROM alerts WHERE id = ?`, [params.id],
  );
  if (!alert) throw new AlertError('That alert no longer exists.');

  await query(
    `UPDATE alerts
        SET state = 'acknowledged', acknowledged_by = ?, acknowledged_at = UTC_TIMESTAMP(),
            acknowledge_note = ?
      WHERE id = ?`,
    [params.by, params.note?.trim() || null, params.id],
  );
  await insertAuditLog({
    action: 'alert_acknowledged',
    entity: 'alert',
    entity_id: params.id,
    performed_by: params.by,
    details: { rule_key: alert.rule_key, employee_id: alert.employee_id, note: params.note ?? null },
    ip_address: params.ip ?? null,
  });
}

/** Hide it until a date. The fact stays true and the row stays open. */
export async function snoozeAlert(params: {
  id: number; until: string; by: number; ip?: string | null;
}): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.until)) {
    throw new AlertError('Snooze until a date in YYYY-MM-DD form.');
  }
  const today = getWorkDateIST();
  if (params.until <= today) throw new AlertError('Snooze until a date in the future.');

  const updated = await query(
    `UPDATE alerts SET snoozed_until = ? WHERE id = ?`, [params.until, params.id],
  ) as unknown as { affectedRows?: number };
  if (!updated?.affectedRows) throw new AlertError('That alert no longer exists.');

  await insertAuditLog({
    action: 'alert_snoozed',
    entity: 'alert',
    entity_id: params.id,
    performed_by: params.by,
    details: { until: params.until },
    ip_address: params.ip ?? null,
  });
}

/** The catalogue, with its on/off state, for the settings screen. */
export async function listRules() {
  return query<{
    rule_key: string; label: string; description: string;
    family: AlertFamily; is_enabled: number; open_count: number;
  }>(
    `SELECT r.rule_key, r.label, r.description, r.family, r.is_enabled,
            COALESCE(c.n, 0) AS open_count
       FROM alert_rules r
       LEFT JOIN (
            SELECT rule_key, COUNT(*) AS n FROM alerts
             WHERE state = 'open' GROUP BY rule_key
       ) c ON c.rule_key = r.rule_key
      ORDER BY FIELD(r.family, 'live', 'pattern', 'lifecycle'), r.rule_key`,
  );
}

export async function setRuleEnabled(params: {
  ruleKey: string; enabled: boolean; by: number; ip?: string | null;
}): Promise<void> {
  const known = RULES.some(r => r.key === params.ruleKey);
  if (!known) throw new AlertError('No such alert rule.');

  await query(
    `UPDATE alert_rules SET is_enabled = ? WHERE rule_key = ?`,
    [params.enabled, params.ruleKey],
  );
  // Switching a rule off resolves what it had open, rather than leaving rows
  // nobody can act on behind a rule that no longer runs.
  if (!params.enabled) {
    await query(
      `UPDATE alerts SET state = 'resolved', resolved_at = UTC_TIMESTAMP()
        WHERE rule_key = ? AND state <> 'resolved'`,
      [params.ruleKey],
    );
  }
  await insertAuditLog({
    action: params.enabled ? 'alert_rule_enabled' : 'alert_rule_disabled',
    entity: 'alert_rule',
    entity_id: null,
    performed_by: params.by,
    details: { rule_key: params.ruleKey },
    ip_address: params.ip ?? null,
  });
}

/**
 * How an alert reads to the person it is about.
 *
 * The stored wording is written for an administrator - "Arun has been late
 * four times" - and showing that to Arun is both jarring and oddly accusatory.
 * The same fact told in the second person is something somebody can act on
 * themselves, which is the point of showing it to them at all.
 *
 * Only the patterns are worth telling them about. "You have not clocked in"
 * read at four in the afternoon is not news to the person who did not.
 */
export function selfPhrasing(row: AlertRow): { title: string; body: string } | null {
  const d = (row.detail ?? {}) as Record<string, number | string | null>;
  switch (row.rule_key) {
    case 'late_pattern':
      return {
        title: `You have arrived late ${d.days_late} times this month`,
        body: `Out of ${d.late_measured_days} days where arrival was measured. `
          + `Your policy flags this at ${d.threshold}.`,
      };
    case 'leave_pattern':
      return {
        title: `You have taken ${d.leave_days} days of leave this month`,
        body: 'Company holidays are not counted towards this.',
      };
    case 'low_hours_pattern':
      return {
        title: 'Your hours are below your roster this month',
        body: `${d.ratio !== null && d.ratio !== undefined ? Math.round(Number(d.ratio) * 100) : '--'}% `
          + `of the hours your shift asked for so far. There is still time in the month.`,
      };
    case 'probation_ending':
      return {
        title: `Your probation ends on ${d.ends_on}`,
        body: 'Your manager has been told as well.',
      };
    default:
      return null;
  }
}

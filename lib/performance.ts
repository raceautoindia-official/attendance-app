import { query } from '@/lib/db';
import { buildHoursLedger } from '@/lib/hoursLedger';
import { resolvePolicyFor } from '@/lib/policy';

/**
 * lib/performance.ts — scoring, and what it refuses to score.
 *
 * Three components, each out of 100, weighted by the employee's policy:
 *
 *   Attendance   turned up on the days that asked for them
 *   Punctuality  arrived on time, where that can be measured at all
 *   Hours        delivered the hours the roster asked for
 *
 * WHAT IS DELIBERATELY NOT SCORED
 * -------------------------------
 * Approved leave. The brief described a top performer as somebody with "no
 * leave", and leave days ARE reported beside every score so that is visible and
 * comparable — but they are not folded into the number.
 *
 * Leave is an entitlement the company grants and an administrator approves.
 * Scoring it down would mean an employee who took approved sick leave ranks
 * below one who came in ill, and the figure would be used in conversations
 * about pay and promotion. If it should count, that belongs in the policy as a
 * deliberate, visible weight rather than buried in an average.
 *
 * Absence is scored, because an absence is a day somebody was expected and did
 * not come. That is a different fact from leave, and the app already
 * distinguishes them.
 *
 * WHEN A COMPONENT CANNOT BE MEASURED
 * -----------------------------------
 * Punctuality does not exist on a flexible shift — lateMinutes() returns null,
 * which is the bug that had the assistant reporting somebody as never late. So
 * when it cannot be measured, its weight is REDISTRIBUTED across the components
 * that can, and the score says so. Scoring somebody out of 70 because of how
 * their shift is typed, then ranking them against people scored out of 100,
 * would be indefensible — and nobody reading a leaderboard would spot it.
 */

export interface ScoreComponent {
  /** 0–100, or null when it cannot be measured for this person. */
  value: number | null;
  /** The weight actually applied, after any redistribution. */
  weight: number;
  measurable: boolean;
  detail: string;
}

export interface PerformanceScore {
  employee: { id: number; name: string; emp_id: string; department: string | null };
  policy: { id: number; name: string; code: string } | null;
  standing: 'counted' | 'dormant' | 'excluded';
  components: {
    attendance: ScoreComponent;
    punctuality: ScoreComponent;
    hours: ScoreComponent;
  };
  /** 0–100, or null when nothing about this person can be scored. */
  total: number | null;
  /** Reported beside the score, not folded into it. */
  facts: {
    working_days: number;
    days_attended: number;
    days_absent: number;
    leave_days: number;
  /**
   * Days arriving after the deadline, or null when lateness could not be
   * measured on any day in the period. Zero would read as 'never late',
   * which is the opposite of 'we never checked'.
   */
  late_days: number | null;
    worked_minutes: number;
    required_minutes: number;
    net_minutes: number;
  };
  notes: string[];
}

export interface PerformanceReport {
  period: { from_date: string; to_date: string };
  scores: PerformanceScore[];
  /** Scored, ranked, and comparable with each other. */
  ranked: PerformanceScore[];
  /** Listed but not ranked — nothing to score, or not held to hours. */
  unranked: PerformanceScore[];
  /** Null when fewer than three people could be scored. */
  median: number | null;
  notes: string[];
}

const pct = (n: number, d: number) => (d <= 0 ? null : Math.max(0, Math.min(100, (n / d) * 100)));
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Score one employee over a period. */
export async function scoreEmployee(
  employeeId: number,
  fromDate: string,
  toDate: string,
): Promise<PerformanceScore | null> {
  const ledger = await buildHoursLedger({ employeeId, fromDate, toDate });
  if (!ledger) return null;

  const policy = await resolvePolicyFor(employeeId, toDate);
  const t = ledger.totals;
  const notes: string[] = [];

  // ---- attendance -------------------------------------------------------
  // The denominator is working days only. A holiday, a week off or approved
  // leave never asked for anybody, so none of them can cost a mark.
  const attended = ledger.days.filter(d => d.kind === 'working' && (d.worked_minutes ?? 0) > 0).length;
  const attendanceValue = pct(attended, t.working_days);

  // ---- punctuality ------------------------------------------------------
  // Only days where lateness is measurable at all. A flexible shift is not
  // held to its start time even though it has one, so those days are not in
  // the denominator either - counting them would score somebody against a
  // deadline nobody asked them to meet.
  const measurable = ledger.days.filter(d => d.late_minutes !== null);
  const onTime = measurable.filter(d => (d.late_minutes ?? 0) === 0).length;
  const punctualityValue = measurable.length > 0 ? pct(onTime, measurable.length) : null;

  // ---- hours ------------------------------------------------------------
  const hoursValue = t.required_minutes > 0
    ? pct(t.credited_minutes, t.required_minutes)
    : null;

  const wanted = {
    attendance: policy?.score_weight_attendance ?? 40,
    punctuality: policy?.score_weight_punctuality ?? 30,
    hours: policy?.score_weight_hours ?? 30,
  };

  // Redistribute the weight of anything unmeasurable across what remains, in
  // proportion. Everybody is then scored out of 100 and the ranking compares
  // like with like.
  const measurableKeys = (['attendance', 'punctuality', 'hours'] as const).filter(k => {
    const v = k === 'attendance' ? attendanceValue : k === 'punctuality' ? punctualityValue : hoursValue;
    return v !== null && wanted[k] > 0;
  });
  const wantedTotal = measurableKeys.reduce((s, k) => s + wanted[k], 0);
  const effective = {
    attendance: 0,
    punctuality: 0,
    hours: 0,
  } as Record<'attendance' | 'punctuality' | 'hours', number>;
  for (const k of measurableKeys) {
    effective[k] = wantedTotal > 0 ? round1((wanted[k] / wantedTotal) * 100) : 0;
  }

  if (punctualityValue === null && wanted.punctuality > 0) {
    notes.push(
      'Punctuality could not be measured — this employee is on a flexible shift, which is '
      + 'not judged against a start time even where one is set on the shift. Late days are '
      + 'shown as not measured rather than zero. Its weight has been shared across the other '
      + 'components so the score is still out of 100 and still comparable. To hold this '
      + 'person to a start time, move them to a fixed shift in Schedules.',
    );
  }

  const components = {
    attendance: {
      value: attendanceValue === null ? null : round1(attendanceValue),
      weight: effective.attendance,
      measurable: attendanceValue !== null,
      detail: `Attended ${attended} of ${t.working_days} working day(s)`,
    },
    punctuality: {
      value: punctualityValue === null ? null : round1(punctualityValue),
      weight: effective.punctuality,
      measurable: punctualityValue !== null,
      detail: punctualityValue === null
        ? 'Not measured on a flexible shift'
        : `On time on ${onTime} of ${measurable.length} day(s) where arrival is judged`,
    },
    hours: {
      value: hoursValue === null ? null : round1(hoursValue),
      weight: effective.hours,
      measurable: hoursValue !== null,
      detail: t.required_minutes > 0
        ? `Credited ${Math.round(t.credited_minutes / 60)}h of ${Math.round(t.required_minutes / 60)}h required`
        : 'No hours were required in this period',
    },
  };

  const total = measurableKeys.length === 0
    ? null
    : round1(measurableKeys.reduce(
        (sum, k) => sum + (components[k].value ?? 0) * (effective[k] / 100), 0,
      ));

  if (ledger.standing === 'excluded') {
    notes.push(ledger.standing_reason ?? 'Not held to rostered hours.');
  } else if (ledger.standing === 'dormant') {
    notes.push('No clock-in at all in this period, so the score reflects absence rather than performance.');
  }
  if (t.has_open_days) {
    notes.push('A day is still clocked in, so the hours component is provisional.');
  }

  return {
    employee: {
      id: ledger.employee.id,
      name: ledger.employee.name,
      emp_id: ledger.employee.emp_id,
      department: ledger.employee.department,
    },
    policy: policy ? { id: policy.id, name: policy.name, code: policy.code } : null,
    standing: ledger.standing,
    components,
    total,
    facts: {
      working_days: t.working_days,
      days_attended: attended,
      days_absent: t.days_absent,
      leave_days: t.leave_days,
      // Derived from the SAME days punctuality is scored on, not from the
      // stored attendance status. The status column is set at clock-in and
      // can say 'present' on a day lateMinutes() computes as late, so reading
      // it here let the card show '0 late days' directly beside a punctuality
      // score of 0 - two numbers from two sources, disagreeing in public.
      late_days: measurable.length > 0 ? measurable.length - onTime : null,
      worked_minutes: t.worked_minutes,
      required_minutes: t.required_minutes,
      net_minutes: t.net_minutes,
    },
    notes,
  };
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return round1(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
};

/**
 * Score and rank everybody, optionally within one policy.
 *
 * Comparing ACROSS policies is allowed but noted: two policies may weight the
 * components differently, so a cross-policy ranking compares results from
 * different exams. Within a policy everybody was marked the same way.
 */
export async function rankPerformance(params: {
  fromDate: string;
  toDate: string;
  policyId?: number | null;
  /** Non-null narrows to a manager's own reports. */
  managerId?: number | null;
}): Promise<PerformanceReport> {
  const { fromDate, toDate, policyId = null, managerId = null } = params;

  const where: string[] = ['e.is_active = TRUE', "e.role = 'employee'"];
  const args: unknown[] = [];
  if (managerId != null) { where.push('e.manager_id = ?'); args.push(managerId); }
  if (policyId != null) {
    where.push(`EXISTS (
      SELECT 1 FROM employee_policies ep
       WHERE ep.employee_id = e.id AND ep.policy_id = ?
         AND ep.effective_from <= ? AND (ep.effective_to IS NULL OR ep.effective_to >= ?))`);
    args.push(policyId, toDate, toDate);
  }

  const employees = await query<{ id: number }>(
    `SELECT e.id FROM employees e WHERE ${where.join(' AND ')} ORDER BY e.name`,
    args,
  );

  const scores: PerformanceScore[] = [];
  for (const e of employees) {
    const s = await scoreEmployee(e.id, fromDate, toDate);
    if (s) scores.push(s);
  }

  // Only people actually held to hours are ranked. Including an administrator
  // or somebody with no roster would put a meaningless number in a league table.
  const ranked = scores
    .filter(s => s.standing === 'counted' && s.total !== null)
    .sort((a, b) => (b.total ?? 0) - (a.total ?? 0));
  const unranked = scores.filter(s => !ranked.includes(s));

  const notes: string[] = [];
  if (policyId == null) {
    const distinctPolicies = new Set(ranked.map(s => s.policy?.code ?? 'none'));
    if (distinctPolicies.size > 1) {
      notes.push(
        'These people are on different policies, which may weight the components differently. '
        + 'Filter to one policy to compare like with like.',
      );
    }
  }
  if (ranked.length < 3) {
    notes.push('Too few people could be scored for a median to mean anything.');
  }
  if (unranked.length > 0) {
    notes.push(
      `${unranked.length} person(s) are listed but not ranked: an administrator, somebody with `
      + 'no roster, or nobody to score.',
    );
  }

  return {
    period: { from_date: fromDate, to_date: toDate },
    scores,
    ranked,
    unranked,
    median: ranked.length >= 3 ? median(ranked.map(s => s.total ?? 0)) : null,
    notes,
  };
}

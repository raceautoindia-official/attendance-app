import { query, queryOne, insertAuditLog } from '@/lib/db';
import { toYmd } from '@/lib/date';
import { assertDateWritable } from '@/lib/monthClose';

/**
 * lib/policy.ts — the rule set an employee is held to.
 *
 * A policy is a named bundle of rules an administrator creates once and assigns
 * to many people: monthly hours, what counts as a day, leave entitlement, which
 * statutory deductions apply, and how performance is weighted.
 *
 * THE INVARIANT EVERYTHING ELSE DEPENDS ON
 * ----------------------------------------
 * `resolvePolicyFor()` returns null when an employee has no policy in force,
 * and every caller then falls back to exactly the behaviour the app had before
 * policies existed — the global standard, the shift-derived requirement, the
 * global overtime line. Nothing moves for anybody until somebody deliberately
 * assigns a policy.
 *
 * That is not a nicety. This is a live payroll input with eighteen months of
 * history; a rules engine that changed everyone's figures the day it shipped
 * would be unusable regardless of how correct it was.
 *
 * WHAT A POLICY IS NOT
 * --------------------
 * It does not carry salary, CTC or pay rates — the brief excluded them, and
 * keeping money out keeps this an attendance system whose output supports
 * payroll rather than a payroll system with weaker controls than a real one.
 *
 * It does not copy shift fields. `default_shift_id` is a reference. Two places
 * defining what hours a shift runs is how they start disagreeing.
 */

export interface Policy {
  id: number;
  name: string;
  code: string;
  description: string | null;
  is_active: boolean;

  hours_basis: 'roster' | 'fixed_monthly';
  monthly_hours: number | null;
  week_offs_per_month: number | null;
  default_shift_id: number | null;
  default_shift_name: string | null;

  min_hours_full_day: number | null;
  min_hours_half_day: number | null;
  late_grace_minutes: number | null;
  overtime_after_minutes: number | null;
  overtime_multiplier: number | null;

  casual_leave_days: number | null;
  sick_leave_days: number | null;
  earned_leave_days: number | null;
  carry_forward_days: number | null;
  permission_hours_per_month: number | null;

  pf_applicable: boolean;
  esi_applicable: boolean;
  professional_tax_applicable: boolean;
  income_tax_tds_applicable: boolean;
  gratuity_applicable: boolean;
  lwf_applicable: boolean;
  bonus_applicable: boolean;

  probation_months: number | null;
  notice_period_days: number | null;

  score_weight_attendance: number;
  score_weight_punctuality: number;
  score_weight_hours: number;

  created_at: string;
  /** How many employees it is in force for today. */
  assigned_count?: number;
}

export interface PolicyAssignment {
  id: number;
  employee_id: number;
  employee_name: string;
  emp_id: string;
  policy_id: number;
  policy_name: string;
  policy_code: string;
  effective_from: string;
  effective_to: string | null;
  assigned_by_name: string | null;
  notes: string | null;
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const bool = (v: unknown): boolean => Boolean(Number(v));

function toPolicy(r: Record<string, unknown>): Policy {
  return {
    id: Number(r.id),
    name: String(r.name),
    code: String(r.code),
    description: (r.description as string) ?? null,
    is_active: bool(r.is_active),

    hours_basis: r.hours_basis as Policy['hours_basis'],
    monthly_hours: num(r.monthly_hours),
    week_offs_per_month: num(r.week_offs_per_month),
    default_shift_id: num(r.default_shift_id),
    default_shift_name: (r.default_shift_name as string) ?? null,

    min_hours_full_day: num(r.min_hours_full_day),
    min_hours_half_day: num(r.min_hours_half_day),
    late_grace_minutes: num(r.late_grace_minutes),
    overtime_after_minutes: num(r.overtime_after_minutes),
    overtime_multiplier: num(r.overtime_multiplier),

    casual_leave_days: num(r.casual_leave_days),
    sick_leave_days: num(r.sick_leave_days),
    earned_leave_days: num(r.earned_leave_days),
    carry_forward_days: num(r.carry_forward_days),
    permission_hours_per_month: num(r.permission_hours_per_month),

    pf_applicable: bool(r.pf_applicable),
    esi_applicable: bool(r.esi_applicable),
    professional_tax_applicable: bool(r.professional_tax_applicable),
    income_tax_tds_applicable: bool(r.income_tax_tds_applicable),
    gratuity_applicable: bool(r.gratuity_applicable),
    lwf_applicable: bool(r.lwf_applicable),
    bonus_applicable: bool(r.bonus_applicable),

    probation_months: num(r.probation_months),
    notice_period_days: num(r.notice_period_days),

    score_weight_attendance: Number(r.score_weight_attendance),
    score_weight_punctuality: Number(r.score_weight_punctuality),
    score_weight_hours: Number(r.score_weight_hours),

    created_at: r.created_at ? new Date(r.created_at as string).toISOString() : '',
    assigned_count: r.assigned_count == null ? undefined : Number(r.assigned_count),
  };
}

const SELECT = `
  SELECT p.*, s.name AS default_shift_name,
         (SELECT COUNT(*) FROM employee_policies ep
           WHERE ep.policy_id = p.id AND ep.effective_to IS NULL) AS assigned_count
    FROM policies p
    LEFT JOIN shifts s ON s.id = p.default_shift_id`;

export async function listPolicies(includeInactive = false): Promise<Policy[]> {
  const rows = await query<Record<string, unknown>>(
    `${SELECT} ${includeInactive ? '' : 'WHERE p.is_active = TRUE'} ORDER BY p.name`,
  );
  return rows.map(toPolicy);
}

export async function getPolicy(id: number): Promise<Policy | null> {
  const row = await queryOne<Record<string, unknown>>(`${SELECT} WHERE p.id = ?`, [id]);
  return row ? toPolicy(row) : null;
}

/**
 * The policy in force for an employee on a date, or null.
 *
 * Null is the important case: it means "no policy", and every caller must then
 * behave exactly as it did before policies existed. See the header.
 *
 * Resolved BY DATE rather than "their current policy", so a month already paid
 * for keeps the rules it was computed under when somebody is later moved to a
 * different policy.
 */
export async function resolvePolicyFor(
  employeeId: number,
  onDate: string,
): Promise<Policy | null> {
  const row = await queryOne<Record<string, unknown>>(
    `${SELECT}
      JOIN employee_policies ep ON ep.policy_id = p.id
     WHERE ep.employee_id = ?
       AND ep.effective_from <= ?
       AND (ep.effective_to IS NULL OR ep.effective_to >= ?)
       AND p.is_active = TRUE
     ORDER BY ep.effective_from DESC, ep.id DESC
     LIMIT 1`,
    [employeeId, onDate, onDate],
  );
  return row ? toPolicy(row) : null;
}

/** Policies in force for many employees at once, keyed by employee id. */
export async function resolvePoliciesFor(
  employeeIds: number[],
  onDate: string,
): Promise<Map<number, Policy>> {
  const out = new Map<number, Policy>();
  if (employeeIds.length === 0) return out;

  // ep.employee_id has to be selected explicitly: the shared SELECT is `p.*`,
  // which is policy columns only. Without it every row keys to NaN and the
  // whole map collapses to a single entry — which is exactly what it did.
  const rows = await query<Record<string, unknown>>(
    `SELECT p.*, ep.employee_id AS employee_id, s.name AS default_shift_name,
            (SELECT COUNT(*) FROM employee_policies ep2
              WHERE ep2.policy_id = p.id AND ep2.effective_to IS NULL) AS assigned_count
       FROM policies p
       LEFT JOIN shifts s ON s.id = p.default_shift_id
       JOIN employee_policies ep ON ep.policy_id = p.id
      WHERE ep.employee_id IN (${employeeIds.map(() => '?').join(',')})
        AND ep.effective_from <= ?
        AND (ep.effective_to IS NULL OR ep.effective_to >= ?)
        AND p.is_active = TRUE
      ORDER BY ep.effective_from ASC, ep.id ASC`,
    [...employeeIds, onDate, onDate],
  );
  // Ascending order then overwrite: the last write wins, which is the most
  // recent assignment — the same precedence resolvePolicyFor applies.
  for (const r of rows) out.set(Number(r.employee_id), toPolicy(r));
  return out;
}

/**
 * Every policy that applied to an employee at any point in a period, with the
 * dates each one covered.
 *
 * Fetched once so a caller walking thirty days does not issue thirty queries,
 * and resolved BY DATE so a reassignment part-way through a month leaves the
 * earlier days under the rules they were actually computed with.
 */
export async function policyTimelineFor(
  employeeId: number,
  fromDate: string,
  toDate: string,
): Promise<Array<{ from: string; to: string | null; policy: Policy }>> {
  const rows = await query<Record<string, unknown>>(
    `SELECT p.*, s.name AS default_shift_name,
            ep.effective_from, ep.effective_to,
            (SELECT COUNT(*) FROM employee_policies ep2
              WHERE ep2.policy_id = p.id AND ep2.effective_to IS NULL) AS assigned_count
       FROM employee_policies ep
       JOIN policies p ON p.id = ep.policy_id
       LEFT JOIN shifts s ON s.id = p.default_shift_id
      WHERE ep.employee_id = ?
        AND ep.effective_from <= ?
        AND (ep.effective_to IS NULL OR ep.effective_to >= ?)
        AND p.is_active = TRUE
      ORDER BY ep.effective_from ASC, ep.id ASC`,
    [employeeId, toDate, fromDate],
  );
  return rows.map(r => ({
    from: toYmd(r.effective_from),
    to: r.effective_to ? toYmd(r.effective_to) : null,
    policy: toPolicy(r),
  }));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Every column a caller may set, with the validation each one needs. */
export interface PolicyInput {
  name: string;
  code: string;
  description?: string | null;
  is_active?: boolean;
  hours_basis?: 'roster' | 'fixed_monthly';
  monthly_hours?: number | null;
  week_offs_per_month?: number | null;
  default_shift_id?: number | null;
  min_hours_full_day?: number | null;
  min_hours_half_day?: number | null;
  late_grace_minutes?: number | null;
  overtime_after_minutes?: number | null;
  overtime_multiplier?: number | null;
  casual_leave_days?: number | null;
  sick_leave_days?: number | null;
  earned_leave_days?: number | null;
  carry_forward_days?: number | null;
  permission_hours_per_month?: number | null;
  pf_applicable?: boolean;
  esi_applicable?: boolean;
  professional_tax_applicable?: boolean;
  income_tax_tds_applicable?: boolean;
  gratuity_applicable?: boolean;
  lwf_applicable?: boolean;
  bonus_applicable?: boolean;
  probation_months?: number | null;
  notice_period_days?: number | null;
  score_weight_attendance?: number;
  score_weight_punctuality?: number;
  score_weight_hours?: number;
}

const COLUMNS: Array<keyof PolicyInput> = [
  'name', 'code', 'description', 'is_active',
  'hours_basis', 'monthly_hours', 'week_offs_per_month', 'default_shift_id',
  'min_hours_full_day', 'min_hours_half_day', 'late_grace_minutes',
  'overtime_after_minutes', 'overtime_multiplier',
  'casual_leave_days', 'sick_leave_days', 'earned_leave_days',
  'carry_forward_days', 'permission_hours_per_month',
  'pf_applicable', 'esi_applicable', 'professional_tax_applicable',
  'income_tax_tds_applicable', 'gratuity_applicable', 'lwf_applicable',
  'bonus_applicable', 'probation_months', 'notice_period_days',
  'score_weight_attendance', 'score_weight_punctuality', 'score_weight_hours',
];

/** Checks that apply whether creating or updating. */
function validate(input: Partial<PolicyInput>, existing?: Policy): void {
  const basis = input.hours_basis ?? existing?.hours_basis ?? 'roster';
  const monthly = input.monthly_hours !== undefined ? input.monthly_hours : existing?.monthly_hours;

  // A fixed-monthly policy without a figure requires nothing at all, which is
  // never what somebody meant to configure.
  if (basis === 'fixed_monthly' && (monthly == null || monthly <= 0)) {
    throw new Error('A fixed-monthly policy needs monthly hours — that figure IS the requirement.');
  }

  const full = input.min_hours_full_day !== undefined ? input.min_hours_full_day : existing?.min_hours_full_day;
  const half = input.min_hours_half_day !== undefined ? input.min_hours_half_day : existing?.min_hours_half_day;
  if (full != null && half != null && half >= full) {
    throw new Error('The half-day threshold must be lower than the full-day one.');
  }

  const w = [
    input.score_weight_attendance ?? existing?.score_weight_attendance ?? 40,
    input.score_weight_punctuality ?? existing?.score_weight_punctuality ?? 30,
    input.score_weight_hours ?? existing?.score_weight_hours ?? 30,
  ];
  if (w.some(x => x < 0 || x > 100)) throw new Error('Each score weight must be between 0 and 100.');
  if (w.reduce((a, b) => a + b, 0) === 0) {
    throw new Error('At least one score weight must be above zero, or nothing can be scored.');
  }
}

export async function createPolicy(input: PolicyInput, by: number, ip?: string | null): Promise<Policy> {
  if (!input.name?.trim()) throw new Error('A policy needs a name.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/.test(input.code ?? '')) {
    throw new Error('The code must be 2–40 characters: letters, numbers, dot, dash or underscore.');
  }
  validate(input);

  const clash = await queryOne<{ id: number }>(`SELECT id FROM policies WHERE code = ?`, [input.code]);
  if (clash) throw new Error(`A policy with the code "${input.code}" already exists.`);

  const cols = COLUMNS.filter(c => input[c] !== undefined);
  const res = (await query(
    `INSERT INTO policies (${cols.join(', ')}, created_by)
     VALUES (${cols.map(() => '?').join(', ')}, ?)`,
    [...cols.map(c => input[c] ?? null), by],
  )) as unknown as { insertId: number };

  await insertAuditLog({
    action: 'policy_created', entity: 'policy', entity_id: res.insertId,
    performed_by: by, ip_address: ip ?? null,
    details: { name: input.name, code: input.code },
  });
  return (await getPolicy(res.insertId))!;
}

export async function updatePolicy(
  id: number, input: Partial<PolicyInput>, by: number, ip?: string | null,
): Promise<Policy> {
  const existing = await getPolicy(id);
  if (!existing) throw new Error('No such policy.');
  validate(input, existing);

  if (input.code && input.code !== existing.code) {
    const clash = await queryOne<{ id: number }>(
      `SELECT id FROM policies WHERE code = ? AND id <> ?`, [input.code, id],
    );
    if (clash) throw new Error(`A policy with the code "${input.code}" already exists.`);
  }

  const cols = COLUMNS.filter(c => input[c] !== undefined);
  if (cols.length === 0) return existing;

  await query(
    `UPDATE policies SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`,
    [...cols.map(c => input[c] ?? null), id],
  );

  await insertAuditLog({
    action: 'policy_updated', entity: 'policy', entity_id: id,
    performed_by: by, ip_address: ip ?? null,
    details: { changed: cols, code: existing.code },
  });
  return (await getPolicy(id))!;
}

/**
 * Assign a policy to an employee from a date.
 *
 * Closes any assignment still open on that date rather than leaving two in
 * force. Without that, resolvePolicyFor would pick one of them by sort order
 * and the other would sit there looking equally valid.
 */
/** One employee's move from the shift they are on to the one a policy names. */
export interface PolicyShiftMove {
  employee_id: number;
  employee_name: string;
  from_shift_id: number | null;
  from_shift_name: string | null;
  to_shift_id: number;
  to_shift_name: string;
  /** Non-null when the move cannot be made. The assignment still proceeds. */
  blocked: string | null;
  /**
   * Days this employee already worked in the same month, BEFORE the move takes
   * effect. Those days keep the old shift - which is right, but it means a
   * move dated today changes nothing about anything already recorded, and the
   * screen would otherwise look like it had.
   */
  earlier_days_this_month: number;
}

/**
 * Who a policy would move, and off what, without moving anybody.
 *
 * The policy's default shift is a statement of which shift the scheme assumes.
 * Acting on it writes a real dated row in `employee_schedules` rather than
 * deciding the shift while figures are calculated, for two reasons that both
 * bite immediately otherwise:
 *
 *  - clock-in, clock-out, today and day all read `employee_schedules`, and the
 *    mobile app calls them. A shift that exists only in the web ledger means
 *    the phone and the website disagree about the same person on the same day.
 *  - shift lookup is date-ranged, so a past month resolves the shift in force
 *    THEN. A policy that decided the shift at read time would rewrite what
 *    somebody worked in a month already closed and paid.
 *
 * So the policy causes the change; `employee_schedules` remains the only thing
 * that defines it.
 */
export async function previewPolicyShiftMoves(params: {
  employeeIds: number[];
  policyId: number;
  effectiveFrom: string;
}): Promise<PolicyShiftMove[]> {
  const { employeeIds, policyId, effectiveFrom } = params;
  if (employeeIds.length === 0) return [];

  const policy = await getPolicy(policyId);
  if (!policy?.default_shift_id) return [];

  const placeholders = employeeIds.map(() => '?').join(',');
  const rows = await query<{
    employee_id: number;
    employee_name: string;
    from_shift_id: number | null;
    from_shift_name: string | null;
  }>(
    `SELECT e.id AS employee_id, e.name AS employee_name,
            es.shift_id AS from_shift_id, s.name AS from_shift_name
       FROM employees e
       LEFT JOIN employee_schedules es
              ON es.employee_id = e.id
             AND es.effective_from <= ?
             AND (es.effective_to IS NULL OR es.effective_to >= ?)
       LEFT JOIN shifts s ON s.id = es.shift_id
      WHERE e.id IN (${placeholders})
      ORDER BY e.name`,
    [effectiveFrom, effectiveFrom, ...employeeIds],
  );

  // A month that is closed was signed off against the shift in force at the
  // time. Moving somebody inside it changes the required hours behind a figure
  // that has already been paid, so the move is reported as blocked instead.
  let blocked: string | null = null;
  try {
    await assertDateWritable(effectiveFrom);
  } catch (err) {
    blocked = (err as Error).message;
  }

  // How much of the current month is already behind the move. Asked once for
  // everybody rather than per employee.
  const monthStart = `${effectiveFrom.slice(0, 7)}-01`;
  const worked = await query<{ employee_id: number; n: number }>(
    `SELECT employee_id, COUNT(*) AS n FROM attendance
      WHERE employee_id IN (${placeholders})
        AND work_date >= ? AND work_date < ?
        AND first_clock_in_utc IS NOT NULL
      GROUP BY employee_id`,
    [...employeeIds, monthStart, effectiveFrom],
  );
  const earlier = new Map(worked.map(w => [w.employee_id, Number(w.n)]));

  const moves: PolicyShiftMove[] = [];
  for (const r of rows) {
    // Somebody already on the shift needs no row, and writing one would close
    // their current schedule only to recreate it - losing nothing but saying
    // something happened when it did not.
    if (r.from_shift_id === policy.default_shift_id) continue;
    moves.push({
      employee_id: r.employee_id,
      employee_name: r.employee_name,
      from_shift_id: r.from_shift_id,
      from_shift_name: r.from_shift_name,
      to_shift_id: policy.default_shift_id,
      to_shift_name: policy.default_shift_name ?? `Shift ${policy.default_shift_id}`,
      blocked,
      earlier_days_this_month: earlier.get(r.employee_id) ?? 0,
    });
  }
  return moves;
}

/**
 * Move one employee onto a shift from a date, keeping the history clean.
 *
 * Mirrors what the Schedules page does, including the part that is easy to
 * miss: `location_id` and `geofencing_enabled` live on the schedule row, not
 * on the employee. Writing a new row without carrying them across would
 * silently switch somebody's geofence off while appearing to change only
 * their hours.
 */
async function moveToShift(params: {
  employeeId: number;
  shiftId: number;
  effectiveFrom: string;
  by: number;
}): Promise<void> {
  const { employeeId, shiftId, effectiveFrom, by } = params;

  const current = await queryOne<{ location_id: number | null; geofencing_enabled: number }>(
    `SELECT location_id, geofencing_enabled
       FROM employee_schedules
      WHERE employee_id = ?
        AND effective_from <= ?
        AND (effective_to IS NULL OR effective_to >= ?)
      ORDER BY effective_from DESC LIMIT 1`,
    [employeeId, effectiveFrom, effectiveFrom],
  );

  // Close what was in force the day before this starts.
  await query(
    `UPDATE employee_schedules
        SET effective_to = DATE_SUB(?, INTERVAL 1 DAY)
      WHERE employee_id = ?
        AND effective_from < ?
        AND (effective_to IS NULL OR effective_to >= ?)`,
    [effectiveFrom, employeeId, effectiveFrom, effectiveFrom],
  );
  // A row starting on the same day is the one this replaces.
  await query(
    `DELETE FROM employee_schedules WHERE employee_id = ? AND effective_from = ?`,
    [employeeId, effectiveFrom],
  );

  // If a later schedule already exists, this one has to stop where that begins,
  // or both are in force from that date and the employee reads as holding two
  // shifts at once.
  const next = await queryOne<{ next_from: Date | string | null }>(
    `SELECT MIN(effective_from) AS next_from FROM employee_schedules
      WHERE employee_id = ? AND effective_from > ?`,
    [employeeId, effectiveFrom],
  );
  const nextFrom = next?.next_from ?? null;

  await query(
    `INSERT INTO employee_schedules
       (employee_id, shift_id, location_id, geofencing_enabled, effective_from, effective_to, assigned_by)
     VALUES (?, ?, ?, ?, ?, ${nextFrom ? 'DATE_SUB(?, INTERVAL 1 DAY)' : 'NULL'}, ?)`,
    nextFrom
      ? [employeeId, shiftId, current?.location_id ?? null, current?.geofencing_enabled ?? 0,
         effectiveFrom, nextFrom, by]
      : [employeeId, shiftId, current?.location_id ?? null, current?.geofencing_enabled ?? 0,
         effectiveFrom, by],
  );
}

export async function assignPolicy(params: {
  employeeId: number;
  policyId: number;
  effectiveFrom: string;
  notes?: string | null;
  by: number;
  ip?: string | null;
  /**
   * Also move the employee onto the policy's default shift, by writing a real
   * dated schedule row. Defaults to false so assigning a policy on its own
   * still changes nothing about what anybody works.
   */
  applyDefaultShift?: boolean;
}): Promise<PolicyAssignment[]> {
  const {
    employeeId, policyId, effectiveFrom, notes = null, by, ip = null,
    applyDefaultShift = false,
  } = params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    throw new Error('effective_from must be YYYY-MM-DD.');
  }
  const policy = await getPolicy(policyId);
  if (!policy) throw new Error('No such policy.');
  if (!policy.is_active) throw new Error(`"${policy.name}" is inactive — reactivate it before assigning.`);

  const employee = await queryOne<{ id: number }>(`SELECT id FROM employees WHERE id = ?`, [employeeId]);
  if (!employee) throw new Error('No such employee.');

  const already = await queryOne<{ id: number; policy_id: number }>(
    `SELECT id, policy_id FROM employee_policies
      WHERE employee_id = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
      ORDER BY effective_from DESC LIMIT 1`,
    [employeeId, effectiveFrom, effectiveFrom],
  );
  if (already?.policy_id === policyId) {
    throw new Error('That employee is already on this policy for that date.');
  }

  const dayBefore = new Date(Date.parse(`${effectiveFrom}T00:00:00Z`) - 86_400_000)
    .toISOString().slice(0, 10);

  // An assignment that began BEFORE this one ends the day before it, so the
  // history reads as a clean handover with no overlap and no gap.
  await query(
    `UPDATE employee_policies
        SET effective_to = ?
      WHERE employee_id = ?
        AND (effective_to IS NULL OR effective_to >= ?)
        AND effective_from < ?`,
    [dayBefore, employeeId, effectiveFrom, effectiveFrom],
  );

  // An assignment that begins ON or AFTER this one is superseded before it ever
  // applied, so it is removed rather than closed.
  //
  // Closing it would set effective_to earlier than effective_from — an inverted
  // range, which is precisely the data fault check-status.sql already reports
  // against employee_schedules. And the earlier version of this clause tested
  // `effective_from <= dayBefore`, which silently missed a same-day
  // reassignment and left TWO assignments open at once: resolvePolicyFor then
  // returned the newest while the hours ledger returned the oldest, so the same
  // employee was on two different policies depending on which code asked.
  //
  // Nothing is lost: both the original assignment and this one are in the audit
  // log, so a correction made on the day is still traceable.
  await query(
    `DELETE FROM employee_policies
      WHERE employee_id = ? AND effective_from >= ?`,
    [employeeId, effectiveFrom],
  );

  await query(
    `INSERT INTO employee_policies (employee_id, policy_id, effective_from, assigned_by, notes)
     VALUES (?, ?, ?, ?, ?)`,
    [employeeId, policyId, effectiveFrom, by, notes],
  );

  // The shift move is a separate, visible act. It is recorded in its own audit
  // entry because 'why is this person suddenly on a different shift' is asked
  // later and far from here.
  let movedToShift: number | null = null;
  if (applyDefaultShift && policy.default_shift_id) {
    const [move] = await previewPolicyShiftMoves({
      employeeIds: [employeeId], policyId, effectiveFrom,
    });
    if (move && !move.blocked) {
      await moveToShift({
        employeeId, shiftId: policy.default_shift_id, effectiveFrom, by,
      });
      movedToShift = policy.default_shift_id;
      await insertAuditLog({
        action: 'schedule_assigned', entity: 'employee_schedule', entity_id: employeeId,
        performed_by: by, ip_address: ip,
        details: {
          employee_id: employeeId, shift_id: policy.default_shift_id,
          effective_from: effectiveFrom, reason: 'policy default shift',
          policy_code: policy.code,
          from_shift_id: move.from_shift_id,
        },
      });
    }
  }

  await insertAuditLog({
    action: 'policy_assigned', entity: 'employee_policy', entity_id: employeeId,
    performed_by: by, ip_address: ip,
    details: {
      employee_id: employeeId, policy_id: policyId, policy_code: policy.code,
      effective_from: effectiveFrom, moved_to_shift_id: movedToShift,
    },
  });

  return listAssignments({ employeeId });
}

/**
 * Move employees onto the default shift of the policy they are ALREADY on.
 *
 * Assignment refuses to put somebody on a policy they already hold, which is
 * right - but it left no way to act on a mismatch noticed afterwards. That is
 * the common case, not the rare one: the policy gets assigned, the shift
 * disagreement is noticed on the Working Hours page days later, and by then the
 * only route to fixing it is through an assignment that will be rejected as a
 * duplicate.
 *
 * Returns what it did, per employee, so a bulk sync can report partial success
 * rather than one opaque error.
 */
export async function syncPolicyDefaultShift(params: {
  employeeIds: number[];
  effectiveFrom: string;
  by: number;
  ip?: string | null;
}): Promise<Array<{ employee_id: number; moved: boolean; reason: string | null }>> {
  const { employeeIds, effectiveFrom, by, ip = null } = params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    throw new Error('effective_from must be YYYY-MM-DD.');
  }

  const out: Array<{ employee_id: number; moved: boolean; reason: string | null }> = [];
  for (const employeeId of employeeIds) {
    const policy = await resolvePolicyFor(employeeId, effectiveFrom);
    if (!policy) {
      out.push({ employee_id: employeeId, moved: false, reason: 'No policy on that date.' });
      continue;
    }
    if (!policy.default_shift_id) {
      out.push({ employee_id: employeeId, moved: false, reason: `"${policy.name}" names no default shift.` });
      continue;
    }
    const [move] = await previewPolicyShiftMoves({
      employeeIds: [employeeId], policyId: policy.id, effectiveFrom,
    });
    if (!move) {
      out.push({ employee_id: employeeId, moved: false, reason: 'Already on that shift.' });
      continue;
    }
    if (move.blocked) {
      out.push({ employee_id: employeeId, moved: false, reason: move.blocked });
      continue;
    }
    await moveToShift({ employeeId, shiftId: policy.default_shift_id, effectiveFrom, by });
    await insertAuditLog({
      action: 'schedule_assigned', entity: 'employee_schedule', entity_id: employeeId,
      performed_by: by, ip_address: ip,
      details: {
        employee_id: employeeId, shift_id: policy.default_shift_id,
        effective_from: effectiveFrom, reason: 'synced to policy default shift',
        policy_code: policy.code, from_shift_id: move.from_shift_id,
      },
    });
    out.push({ employee_id: employeeId, moved: true, reason: null });
  }
  return out;
}

/** End an employee's current policy without putting them on another. */
export async function endAssignment(params: {
  employeeId: number;
  effectiveTo: string;
  by: number;
  ip?: string | null;
}): Promise<void> {
  const { employeeId, effectiveTo, by, ip = null } = params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveTo)) throw new Error('effective_to must be YYYY-MM-DD.');

  const open = await queryOne<{ id: number }>(
    `SELECT id FROM employee_policies WHERE employee_id = ? AND effective_to IS NULL`,
    [employeeId],
  );
  if (!open) throw new Error('That employee has no policy in force.');

  await query(`UPDATE employee_policies SET effective_to = ? WHERE id = ?`, [effectiveTo, open.id]);
  await insertAuditLog({
    action: 'policy_unassigned', entity: 'employee_policy', entity_id: employeeId,
    performed_by: by, ip_address: ip,
    details: { employee_id: employeeId, effective_to: effectiveTo },
  });
}

export async function listAssignments(params: {
  employeeId?: number;
  policyId?: number;
  currentOnly?: boolean;
} = {}): Promise<PolicyAssignment[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (params.employeeId) { where.push('ep.employee_id = ?'); args.push(params.employeeId); }
  if (params.policyId) { where.push('ep.policy_id = ?'); args.push(params.policyId); }
  if (params.currentOnly) where.push('ep.effective_to IS NULL');

  const rows = await query<Record<string, unknown>>(
    `SELECT ep.*, e.name AS employee_name, e.emp_id,
            p.name AS policy_name, p.code AS policy_code,
            a.name AS assigned_by_name
       FROM employee_policies ep
       JOIN employees e ON e.id = ep.employee_id
       JOIN policies  p ON p.id = ep.policy_id
       LEFT JOIN employees a ON a.id = ep.assigned_by
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY e.name, ep.effective_from DESC`,
    args,
  );
  return rows.map(r => ({
    id: Number(r.id),
    employee_id: Number(r.employee_id),
    employee_name: String(r.employee_name),
    emp_id: String(r.emp_id),
    policy_id: Number(r.policy_id),
    policy_name: String(r.policy_name),
    policy_code: String(r.policy_code),
    effective_from: toYmd(r.effective_from),
    effective_to: r.effective_to ? toYmd(r.effective_to) : null,
    assigned_by_name: (r.assigned_by_name as string) ?? null,
    notes: (r.notes as string) ?? null,
  }));
}

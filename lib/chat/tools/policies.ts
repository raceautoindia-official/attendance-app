/**
 * lib/chat/tools/policies.ts — policies, performance and document compliance.
 *
 * Without these the assistant cannot see three whole features. Asked "which
 * policy is Arun on" it had no data source, and a model with no tool for a
 * question does not say so — it answers from the nearest thing it does have,
 * which is how a confident wrong answer gets made.
 *
 * Two rules carried over from the rest of the chat layer:
 *
 *  - A figure that could not be MEASURED is never reported as zero. Punctuality
 *    on a flexible shift is the standing example: `null` means nobody checked,
 *    and saying "0 late days" turns a missing measurement into a clean record.
 *  - A field that is recorded but drives no calculation says so. Most of a
 *    policy is reference data; answering "this policy sets 12 casual leave
 *    days" without adding that it changes no balance would be false in effect.
 */

import { query } from '@/lib/db';
import { listPolicies as listPolicyRows, listAssignments, policyTimelineFor } from '@/lib/policy';
import { rankPerformance } from '@/lib/performance';
import { buildComplianceReport } from '@/lib/documentCompliance';
import { POLICY_FIELDS_THAT_CHANGE_FIGURES } from '@/lib/policyFields';
import { resolveRange, type RangeInput } from '../dates';
import { requireSuperAdmin, type ChatContext, type ToolResult } from '../types';

/** Said on every policy answer, because most of a policy is reference data. */
const RECORDED_ONLY_NOTE =
  'Only these policy fields change a calculation: '
  + POLICY_FIELDS_THAT_CHANGE_FIGURES.join(', ')
  + '. Everything else on a policy (default shift, overtime, leave days, '
  + 'permission hours, probation, notice period, statutory flags) is recorded '
  + 'for reference and carried onto reports, but changes no figure. Leave '
  + 'balances come from Leave Quotas, per employee per year — never from the policy.';

export interface PolicyRow {
  id: number;
  name: string;
  code: string;
  is_active: boolean;
  hours_basis: string;
  monthly_hours: number | null;
  week_offs_per_month: number | null;
  default_shift_name: string | null;
  late_grace_minutes: number | null;
  statutory: string[];
  employees_assigned: number;
}

/** Every policy, with how many people are on it. */
export async function listPoliciesTool(ctx: ChatContext): Promise<ToolResult<PolicyRow>> {
  requireSuperAdmin(ctx);

  const policies = await listPolicyRows(true);
  const counts = await query<{ policy_id: number; n: number }>(
    `SELECT policy_id, COUNT(DISTINCT employee_id) AS n
       FROM employee_policies WHERE effective_to IS NULL GROUP BY policy_id`,
  );
  const byId = new Map(counts.map(c => [Number(c.policy_id), Number(c.n)]));

  const rows: PolicyRow[] = policies.map(p => ({
    id: p.id,
    name: p.name,
    code: p.code,
    is_active: Boolean(p.is_active),
    hours_basis: p.hours_basis,
    monthly_hours: p.monthly_hours,
    week_offs_per_month: p.week_offs_per_month,
    default_shift_name: p.default_shift_name,
    late_grace_minutes: p.late_grace_minutes,
    statutory: [
      p.pf_applicable && 'PF', p.esi_applicable && 'ESI',
      p.professional_tax_applicable && 'Professional Tax',
      p.income_tax_tds_applicable && 'TDS', p.gratuity_applicable && 'Gratuity',
      p.lwf_applicable && 'LWF', p.bonus_applicable && 'Bonus',
    ].filter(Boolean) as string[],
    employees_assigned: byId.get(p.id) ?? 0,
  }));

  const unassigned = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM employees e
      WHERE e.is_active = TRUE AND e.role = 'employee'
        AND NOT EXISTS (SELECT 1 FROM employee_policies ep
                         WHERE ep.employee_id = e.id AND ep.effective_to IS NULL)`,
  );

  const notes = [RECORDED_ONLY_NOTE];
  const n = Number(unassigned[0]?.n ?? 0);
  if (n > 0) {
    notes.push(
      `${n} active employee(s) are on NO policy. They fall back to the global `
      + 'standard, exactly as before policies existed.',
    );
  }

  return { count: rows.length, rows, notes };
}

export interface EmployeePolicyRow {
  employee_id: number;
  policy_name: string | null;
  policy_code: string | null;
  effective_from: string | null;
  effective_to: string | null;
  is_current: boolean;
  hours_basis: string | null;
  monthly_hours: number | null;
  default_shift_name: string | null;
  actual_shift_name: string | null;
  shift_matches_policy: boolean | null;
}

/**
 * Which policy one employee is on, with history.
 *
 * Also reports the shift they are ACTUALLY rostered on beside the one the
 * policy names, because the two disagreeing is the single most common
 * misunderstanding about this feature: the policy's default shift is a
 * reference, and the schedule is what decides.
 */
export async function getEmployeePolicyTool(
  ctx: ChatContext,
  args: { employee_id: number },
): Promise<ToolResult<EmployeePolicyRow>> {
  requireSuperAdmin(ctx);

  // The timeline needs a window. A wide one is deliberate: the question is
  // usually 'what are they on', but 'what were they on in March' is asked
  // often enough that the whole history is cheaper to return than a follow-up.
  const today = new Date().toISOString().slice(0, 10);
  const timeline = await policyTimelineFor(args.employee_id, '2000-01-01', today);

  const actual = await query<{ shift_name: string | null }>(
    `SELECT s.name AS shift_name FROM employee_schedules es
       JOIN shifts s ON s.id = es.shift_id
      WHERE es.employee_id = ?
        AND es.effective_from <= ?
        AND (es.effective_to IS NULL OR es.effective_to >= ?)
      LIMIT 1`,
    [args.employee_id, today, today],
  );
  const actualShift = actual[0]?.shift_name ?? null;

  const rows: EmployeePolicyRow[] = timeline.map(t => {
    const current = !t.to || t.to >= today;
    return {
      employee_id: args.employee_id,
      policy_name: t.policy.name,
      policy_code: t.policy.code,
      effective_from: t.from,
      effective_to: t.to,
      is_current: current,
      hours_basis: t.policy.hours_basis,
      monthly_hours: t.policy.monthly_hours,
      default_shift_name: t.policy.default_shift_name,
      actual_shift_name: current ? actualShift : null,
      shift_matches_policy: current && t.policy.default_shift_name
        ? t.policy.default_shift_name === actualShift
        : null,
    };
  });
  const notes = [RECORDED_ONLY_NOTE];
  if (rows.length === 0) {
    notes.push(
      'This employee is on no policy, now or previously. Their hours are worked '
      + 'out from the global standard and their shift, exactly as before policies existed.',
    );
  }
  const mismatch = rows.find(r => r.is_current && r.shift_matches_policy === false);
  if (mismatch) {
    notes.push(
      `Their policy names "${mismatch.default_shift_name}" as its default shift, but they are `
      + `actually rostered on "${mismatch.actual_shift_name}". The schedule decides what is `
      + 'worked and judged; the policy default changes nothing on its own.',
    );
  }

  return { count: rows.length, rows, notes };
}

export interface PerformanceRow {
  rank: number | null;
  employee_id: number;
  name: string;
  emp_id: string;
  policy_code: string | null;
  score: number | null;
  attendance: number | null;
  punctuality: number | null;
  hours: number | null;
  late_days: number | null;
  days_attended: number;
  working_days: number;
  note: string | null;
}

/** Performance scores for a period, ranked. */
export async function getPerformanceTool(
  ctx: ChatContext,
  args: { policy_id?: number } & RangeInput = {},
): Promise<ToolResult<PerformanceRow>> {
  requireSuperAdmin(ctx);

  const range = resolveRange(args);
  const report = await rankPerformance({
    fromDate: range.from, toDate: range.to,
    policyId: args.policy_id ?? null,
  });

  const rows: PerformanceRow[] = report.scores.map((s, i) => ({
    rank: report.ranked.findIndex(r => r.employee.id === s.employee.id) >= 0
      ? report.ranked.findIndex(r => r.employee.id === s.employee.id) + 1
      : null,
    employee_id: s.employee.id,
    name: s.employee.name,
    emp_id: s.employee.emp_id,
    policy_code: s.policy?.code ?? null,
    score: s.total,
    attendance: s.components.attendance.value,
    punctuality: s.components.punctuality.value,
    hours: s.components.hours.value,
    // null here means lateness could not be measured at all — not zero late days.
    late_days: s.facts.late_days,
    days_attended: s.facts.days_attended,
    working_days: s.facts.working_days,
    note: s.notes[0] ?? null,
    _i: i,
  } as PerformanceRow));

  const notes = [...report.notes];
  const unmeasured = rows.filter(r => r.punctuality === null).length;
  if (unmeasured > 0) {
    notes.push(
      `Punctuality could not be measured for ${unmeasured} of ${rows.length} people — they are `
      + 'on a flexible shift, which is not judged against a start time. Their late_days is null, '
      + 'meaning NOT MEASURED. Never report that as zero late days or as a clean record. Their '
      + 'punctuality weight is shared across the other components so scores stay comparable.',
    );
  }
  if (report.median !== null) {
    notes.push(`The median score is ${report.median}.`);
  }

  return { range, count: rows.length, rows, notes };
}

export interface ComplianceRow {
  employee_id: number;
  name: string;
  emp_id: string;
  policy_code: string | null;
  required: number;
  held: number;
  missing: string[];
  complete: boolean;
}

/** Who is missing which required documents. */
export async function getDocumentComplianceTool(
  ctx: ChatContext,
  args: { only_incomplete?: boolean } = {},
): Promise<ToolResult<ComplianceRow>> {
  requireSuperAdmin(ctx);

  const report = await buildComplianceReport({});
  let rows: ComplianceRow[] = report.employees.map(e => ({
    employee_id: e.employee.id,
    name: e.employee.name,
    emp_id: e.employee.emp_id,
    policy_code: e.policy?.code ?? null,
    required: e.satisfied.length + e.missing.length,
    held: e.satisfied.length,
    // Only the genuinely required ones: a recommendation that is absent is
    // not a compliance failure, and listing it as one makes the real gaps
    // harder to see.
    missing: e.missing.filter(r => r.required).map(r => r.label),
    complete: e.complete,
  }));
  if (args.only_incomplete) rows = rows.filter(r => !r.complete);

  const notes = [
    'What each employee must hold is derived from their policy\'s statutory flags — '
    + 'PF requires a PAN card, ESI requires Aadhaar, and so on. An employee on no policy '
    + 'has only the baseline requirements.',
  ];

  return { count: rows.length, rows, notes };
}

/**
 * lib/policyFields.ts — what every policy field is called, and what it does.
 *
 * One list, imported by both the form and the API, so the label you see beside
 * a box is the label you get back in an error about it. They drifted apart
 * once already: the form turned an empty required field into null and the API
 * answered "expected string, received null", naming neither the field nor the
 * real problem.
 *
 * This module is deliberately pure — no database, no server-only imports — so
 * the client bundle can use it.
 *
 * HELP is written to be honest about a distinction the form cannot otherwise
 * show: some of these fields change what the app calculates, and most do not.
 * A field that is merely recorded is marked "Recorded only". Saying so is the
 * difference between a policy that is understood and one that is trusted to do
 * something it never did.
 */

export const POLICY_FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  code: 'Code',
  description: 'Description',
  is_active: 'Active',
  hours_basis: 'How the monthly requirement is decided',
  monthly_hours: 'Monthly hours',
  week_offs_per_month: 'Week offs per month',
  default_shift_id: 'Default shift',
  late_grace_minutes: 'Late grace (minutes)',
  overtime_after_minutes: 'Overtime after (minutes)',
  overtime_multiplier: 'Overtime multiplier',
  casual_leave_days: 'Casual leave',
  sick_leave_days: 'Sick leave',
  earned_leave_days: 'Earned leave',
  carry_forward_days: 'Carry forward (days)',
  permission_hours_per_month: 'Permission hours per month',
  pf_applicable: 'PF',
  esi_applicable: 'ESI',
  professional_tax_applicable: 'Professional Tax',
  income_tax_tds_applicable: 'Income tax / TDS',
  gratuity_applicable: 'Gratuity',
  lwf_applicable: 'Labour Welfare Fund',
  bonus_applicable: 'Bonus',
  probation_months: 'Probation (months)',
  notice_period_days: 'Notice period (days)',
  score_weight_attendance: 'Attendance weight',
  score_weight_punctuality: 'Punctuality weight',
  score_weight_hours: 'Hours delivered weight',
  effective_from: 'Effective from',
  employee_ids: 'Employees',
};

/** Short, plain help shown under each field. */
export const POLICY_FIELD_HELP: Record<string, string> = {
  name: 'What this policy is called in lists, e.g. Staff — 225 hours. Required.',
  code: 'Short unique handle used in exports and reports, e.g. STAFF-225. Required.',
  description: 'Optional note explaining who this policy is for.',

  monthly_hours:
    'The stated monthly norm, e.g. 225. Under roster it is shown beside the figure the calendar actually produces, so a disagreement is visible instead of silently resolved. Under fixed monthly it becomes the requirement itself.',
  week_offs_per_month:
    'How many week offs a month should contain, e.g. 4. This is only a check — the shift working days decide the actual week offs, and two things defining them is how they start disagreeing.',
  default_shift_id:
    'Which shift this policy assumes. Recorded only: the employee schedule still decides the real shift, and changing this moves nobody.',

  late_grace_minutes:
    'Minutes after the start time before an arrival counts as late, replacing the shift grace for these employees. Leave empty to keep the shift own grace. Has no effect on a flexible shift, where lateness cannot be measured at all.',
  overtime_after_minutes:
    'Recorded only. Minutes beyond the day requirement before overtime would begin. Nothing in the app pays or flags overtime yet.',
  overtime_multiplier:
    'Recorded only, e.g. 1.5. Kept so the rate that applied in a past month can be answered later.',

  casual_leave_days:
    'Recorded only. This does NOT set anybody balance — balances live in Leave Quotas, per employee per year, and that is what every leave figure in the app reads.',
  sick_leave_days:
    'Recorded only. Set the real balance in Leave Quotas, which is per employee per year.',
  earned_leave_days:
    'Recorded only. Set the real balance in Leave Quotas, which is per employee per year.',
  carry_forward_days:
    'Recorded only. How many unused days would carry into next year. Nothing carries anything forward automatically.',
  permission_hours_per_month:
    'Recorded only. Short time-off permission already has its own monthly entitlement, which this does not change.',

  pf_applicable: 'Whether PF applies. Recorded and carried onto the payroll pack.',
  esi_applicable: 'Whether ESI applies. Recorded and carried onto the payroll pack.',
  professional_tax_applicable: 'State-level professional tax. Tamil Nadu levies one.',
  income_tax_tds_applicable: 'Income tax deducted at source. Separate from professional tax.',
  gratuity_applicable: 'Gratuity eligibility, normally after five years.',
  lwf_applicable: 'Labour Welfare Fund. Tamil Nadu has one.',
  bonus_applicable: 'Eligibility under the Payment of Bonus Act.',

  probation_months: 'Recorded only. Months of probation for people on this policy.',
  notice_period_days: 'Recorded only. Days of notice required.',

  score_weight_attendance: 'How much of the performance score comes from days present. Weights are relative, so 40/30/30 and 4/3/3 score identically.',
  score_weight_punctuality: 'How much comes from arriving on time. On a flexible shift this cannot be measured, and the weight is shared across the other two rather than scoring somebody out of less than everybody else.',
  score_weight_hours: 'How much comes from hours delivered against hours required.',
};

/** Which fields change a calculation today. Everything else is recorded only. */
export const POLICY_FIELDS_THAT_CHANGE_FIGURES = [
  'hours_basis',
  'monthly_hours',
  'week_offs_per_month',
  'late_grace_minutes',
  'score_weight_attendance',
  'score_weight_punctuality',
  'score_weight_hours',
] as const;

/** "monthly_hours" -> "Monthly hours". Falls back to the raw path. */
export function policyFieldLabel(path: PropertyKey | undefined): string {
  if (path === undefined) return 'This policy';
  const key = String(path);
  return POLICY_FIELD_LABELS[key] ?? key;
}

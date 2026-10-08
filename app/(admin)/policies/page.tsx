'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Modal from '@/components/ui/Modal';
import Spinner from '@/components/ui/Spinner';
import type { ApiResponse, Employee, Shift } from '@/lib/types';
import { POLICY_FIELD_HELP } from '@/lib/policyFields';

/**
 * Policies — the rule sets employees are held to.
 *
 * A policy is a named bundle an administrator creates once and assigns to many
 * people. The form is long because the rules genuinely are, so it is grouped by
 * what each group decides rather than presented as one wall of inputs.
 *
 * Every rule field may be left empty, and empty means "fall back to how the app
 * behaves without a policy". The form says so rather than implying a blank is a
 * zero — the difference between "no overtime line set" and "overtime after
 * 0 minutes" is somebody's pay.
 */

interface Policy {
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
  assigned_count?: number;
}

interface Assignment {
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
}

const STATUTORY: Array<[keyof Policy, string, string]> = [
  ['pf_applicable', 'Provident Fund (PF)', 'Employer and employee contribution'],
  ['esi_applicable', 'ESI', 'Employees’ State Insurance'],
  ['professional_tax_applicable', 'Professional Tax', 'State levy — Tamil Nadu has one'],
  ['income_tax_tds_applicable', 'Income Tax (TDS)', 'Deducted at source'],
  ['gratuity_applicable', 'Gratuity', 'Usually after five years’ service'],
  ['lwf_applicable', 'Labour Welfare Fund', 'State fund'],
  ['bonus_applicable', 'Bonus', 'Payment of Bonus Act'],
];

const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

type Draft = Record<string, unknown>;

const blank = (): Draft => ({
  name: '', code: '', description: '',
  hours_basis: 'roster', monthly_hours: '', week_offs_per_month: '', default_shift_id: '', min_hours_half_day: '', late_grace_minutes: '',
  overtime_after_minutes: '', overtime_multiplier: '',
  casual_leave_days: '', sick_leave_days: '', earned_leave_days: '',
  carry_forward_days: '', permission_hours_per_month: '',
  pf_applicable: false, esi_applicable: false, professional_tax_applicable: false,
  income_tax_tds_applicable: false, gratuity_applicable: false,
  lwf_applicable: false, bonus_applicable: false,
  probation_months: '', notice_period_days: '',
  score_weight_attendance: 40, score_weight_punctuality: 30, score_weight_hours: 30,
});

interface ShiftMove {
  employee_id: number;
  employee_name: string;
  from_shift_name: string | null;
  to_shift_name: string;
  blocked: string | null;
  earlier_days_this_month: number;
}

/** Required text: empty must stay an empty string, never become null. */
const REQUIRED_TEXT = new Set(['name', 'code']);
export default function PoliciesPage() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Policy | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(blank());
  const [error, setError] = useState<string | null>(null);
  const [assignTarget, setAssignTarget] = useState<Policy | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [effectiveFrom, setEffectiveFrom] = useState(today());
  // Default ON: a policy that names a shift almost always means it. The list
  // below says exactly who moves, so this is visible rather than implicit.
  const [applyShift, setApplyShift] = useState(true);
  const [result, setResult] = useState<string | null>(null);

  const { data: policies, isLoading } = useQuery({
    queryKey: ['policies'],
    queryFn: async () => {
      const res = await fetch('/api/policies?include_inactive=1');
      const json: ApiResponse<{ policies: Policy[] }> = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Could not load policies');
      return json.data?.policies ?? [];
    },
  });

  const { data: employees } = useQuery({
    queryKey: ['employees', 'for-policies'],
    queryFn: async () => {
      const res = await fetch('/api/employees?limit=200');
      const json: ApiResponse<{ employees: Employee[] }> = await res.json();
      return json.data?.employees ?? [];
    },
  });

  const { data: shifts } = useQuery({
    queryKey: ['shifts', 'for-policies'],
    queryFn: async () => {
      const res = await fetch('/api/schedules');
      const json: ApiResponse<{ shifts?: Shift[] } | Shift[]> = await res.json();
      const d = json.data as { shifts?: Shift[] } | Shift[] | undefined;
      return Array.isArray(d) ? d : (d?.shifts ?? []);
    },
  });

  const { data: assignments } = useQuery({
    queryKey: ['policy-assignments'],
    queryFn: async () => {
      const res = await fetch('/api/policies/assign?current_only=1');
      const json: ApiResponse<{ assignments: Assignment[] }> = await res.json();
      return json.data?.assignments ?? [];
    },
  });

  const byEmployee = useMemo(() => {
    const m = new Map<number, Assignment>();
    for (const a of assignments ?? []) m.set(a.employee_id, a);
    return m;
  }, [assignments]);

  const save = useMutation({
    mutationFn: async () => {
      const payload: Draft = {};
      for (const [k, v] of Object.entries(draft)) {
        // An empty optional rule means 'no rule', which the API reads as null.
        // But name and code are REQUIRED text, and sending null for them makes
        // the API complain about the type ('expected string, received null')
        // instead of the emptiness - hiding the plain message the schema
        // already carries. Leave them as the empty strings they are.
        payload[k] = v === '' && !REQUIRED_TEXT.has(k) ? null : v;
      }
      const url = editing ? `/api/policies/${editing.id}` : '/api/policies';
      const res = await fetch(url, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json: ApiResponse<unknown> = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Could not save');
      return json.data;
    },
    onSuccess: () => {
      setError(null); setCreating(false); setEditing(null); setDraft(blank());
      qc.invalidateQueries({ queryKey: ['policies'] });
    },
    onError: (e: Error) => setError(e.message),
  });

  // What the shift box would actually do, asked of the server rather than
  // guessed in the browser: only the server knows each employee's schedule on
  // that date, and whether the month is closed.
  const { data: shiftMoves } = useQuery<ShiftMove[]>({
    queryKey: ['policy-shift-moves', assignTarget?.id, effectiveFrom, [...selected].sort().join(',')],
    enabled: Boolean(assignTarget) && selected.size > 0,
    queryFn: async () => {
      const qs = new URLSearchParams({
        preview: 'shift_moves',
        policy_id: String(assignTarget!.id),
        effective_from: effectiveFrom,
        employee_ids: [...selected].join(','),
      });
      const res = await fetch(`/api/policies/assign?${qs}`);
      const json: ApiResponse<{ shift_moves: ShiftMove[] }> = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Could not preview');
      return json.data?.shift_moves ?? [];
    },
  });

  const assign = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/policies/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employee_ids: [...selected], policy_id: assignTarget!.id, effective_from: effectiveFrom,
          apply_default_shift: applyShift,
        }),
      });
      const json: ApiResponse<{
        assigned: number[];
        skipped: Array<{ reason: string }>;
        shift_moves: ShiftMove[];
        shift_synced: number[];
      }> = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Could not assign');
      return json.data!;
    },
    onSuccess: d => {
      setError(null);
      setResult(
        `Assigned ${d.assigned.length}.`
        + (d.shift_moves?.length
          ? ` Moved ${d.shift_moves.length} onto ${d.shift_moves[0].to_shift_name}`
            // Somebody already on the policy is not newly assigned, but their
            // shift still moved - saying only 'skipped' would read as nothing
            // having happened to them at all.
            + (d.shift_synced?.length
              ? ` (${d.shift_synced.length} of them already on this policy — shift synced).`
              : '.')
          : '')
        + (d.skipped.length ? ` Skipped ${d.skipped.length}: ${d.skipped[0].reason}` : ''),
      );
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['policy-assignments'] });
      qc.invalidateQueries({ queryKey: ['policies'] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const deactivate = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/policies/${id}`, { method: 'DELETE' });
      const json: ApiResponse<unknown> = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Could not deactivate');
      return json.data;
    },
    onSuccess: () => { setError(null); qc.invalidateQueries({ queryKey: ['policies'] }); },
    onError: (e: Error) => setError(e.message),
  });

  const set = (k: string, v: unknown) => setDraft(d => ({ ...d, [k]: v }));

  function openEdit(p: Policy) {
    const d: Draft = { ...blank() };
    for (const k of Object.keys(d)) {
      const v = (p as unknown as Record<string, unknown>)[k];
      d[k] = v === null || v === undefined ? (typeof d[k] === 'boolean' ? false : '') : v;
    }
    setDraft(d); setEditing(p); setCreating(false); setError(null);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Policies</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Rule sets — hours, leave, statutory deductions — created once and assigned to
            many employees. An employee with no policy keeps the app&apos;s default behaviour.
          </p>
        </div>
        <Button onClick={() => { setDraft(blank()); setCreating(true); setEditing(null); setError(null); }}>
          New Policy
        </Button>
      </div>

      {error && <Card><p className="text-sm text-red-600 dark:text-red-400">{error}</p></Card>}
      {result && (
        <Card>
          <p className="flex items-center justify-between text-sm text-slate-700 dark:text-slate-200">
            {result}
            <button type="button" onClick={() => setResult(null)} className="text-xs text-slate-400">dismiss</button>
          </p>
        </Card>
      )}

      {isLoading && <Card><div className="flex justify-center py-10"><Spinner /></div></Card>}

      {policies && policies.length === 0 && (
        <Card>
          <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
            No policies yet. Everybody is on the app&apos;s default rules — the global
            monthly standard and their shift&apos;s hours.
          </p>
        </Card>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        {(policies ?? []).map(p => (
          <Card key={p.id} className={p.is_active ? '' : 'opacity-60'}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{p.name}</h2>
                  <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                    {p.code}
                  </code>
                  {!p.is_active && <Badge variant="neutral">inactive</Badge>}
                  <Badge variant="info">{p.assigned_count ?? 0} assigned</Badge>
                </div>
                {p.description && (
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{p.description}</p>
                )}
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-600 dark:text-slate-300">
                  <span>
                    Hours:{' '}
                    <strong>
                      {p.hours_basis === 'fixed_monthly'
                        ? `${p.monthly_hours ?? '—'}h fixed each month`
                        : `roster-derived${p.monthly_hours ? `, norm ${p.monthly_hours}h` : ''}`}
                    </strong>
                  </span>
                  <span>Week offs: <strong>{p.week_offs_per_month ?? '—'}</strong></span>
                  <span>Shift: <strong>{p.default_shift_name ?? 'not set'}</strong></span>
                  <span>
                    Leave: <strong>
                      {[p.casual_leave_days && `${p.casual_leave_days} CL`,
                        p.sick_leave_days && `${p.sick_leave_days} SL`,
                        p.earned_leave_days && `${p.earned_leave_days} EL`]
                        .filter(Boolean).join(' · ') || '—'}
                    </strong>
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {STATUTORY.filter(([k]) => p[k]).map(([k, label]) => (
                    <span key={String(k)} className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                      {label.replace(/ \(.*\)/, '')}
                    </span>
                  ))}
                  {STATUTORY.every(([k]) => !p[k]) && (
                    <span className="text-[10px] text-slate-400">No statutory deductions flagged</span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 flex-col gap-1">
                <Button size="sm" variant="ghost" onClick={() => openEdit(p)}>Edit</Button>
                <Button size="sm" variant="secondary"
                  onClick={() => { setAssignTarget(p); setSelected(new Set()); setResult(null); setError(null); }}>
                  Assign
                </Button>
                {p.is_active && (
                  <Button size="sm" variant="ghost"
                    onClick={() => { if (confirm(`Deactivate "${p.name}"?`)) deactivate.mutate(p.id); }}>
                    Retire
                  </Button>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Who is on what */}
      {assignments && assignments.length > 0 && (
        <Card padding={false}>
          <h2 className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-800 dark:border-slate-700 dark:text-slate-100">
            Who is on which policy
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800/60">
                <tr className="text-left text-slate-600 dark:text-slate-300">
                  <th className="px-3 py-2 font-semibold">Employee</th>
                  <th className="px-3 py-2 font-semibold">Policy</th>
                  <th className="px-3 py-2 font-semibold">Since</th>
                  <th className="px-3 py-2 font-semibold">Assigned by</th>
                </tr>
              </thead>
              <tbody>
                {assignments.map(a => (
                  <tr key={a.id} className="border-t border-slate-100 dark:border-slate-700/60">
                    <td className="px-3 py-1.5 text-slate-700 dark:text-slate-200">
                      {a.employee_name} <span className="text-slate-400">{a.emp_id}</span>
                    </td>
                    <td className="px-3 py-1.5">{a.policy_name}</td>
                    <td className="px-3 py-1.5 tabular-nums text-slate-500">{a.effective_from}</td>
                    <td className="px-3 py-1.5 text-slate-500">{a.assigned_by_name ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ---- Create / edit ---------------------------------------------- */}
      <Modal
        open={creating || !!editing}
        onClose={() => { setCreating(false); setEditing(null); setError(null); }}
        title={editing ? `Edit ${editing.name}` : 'New Policy'}
        size="lg"
      >
        <div className="max-h-[70vh] space-y-5 overflow-y-auto pr-1">
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            Leave any rule <strong>empty</strong> to fall back to how the app behaves without a
            policy. Empty is not zero — &ldquo;no overtime line set&rdquo; and &ldquo;overtime
            after 0 minutes&rdquo; are different answers.
          </p>

          <Section title="Identity">
            <Input label="Name" required value={String(draft.name ?? '')}
              onChange={e => set('name', e.target.value)} helper={POLICY_FIELD_HELP.name} />
            <Input label="Code" required value={String(draft.code ?? '')}
              onChange={e => set('code', e.target.value)} helper={POLICY_FIELD_HELP.code} />
            <Input label="Description" value={String(draft.description ?? '')}
              onChange={e => set('description', e.target.value)} className="sm:col-span-2"
              helper={POLICY_FIELD_HELP.description} />
          </Section>

          <Section title="Hours">
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
                How the monthly requirement is decided
              </span>
              <select
                value={String(draft.hours_basis)}
                onChange={e => set('hours_basis', e.target.value)}
                className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
              >
                <option value="roster">Roster-derived — recommended</option>
                <option value="fixed_monthly">Fixed monthly hours</option>
              </select>
              <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
                {draft.hours_basis === 'fixed_monthly'
                  ? 'Every month requires exactly the hours below, whatever the calendar says. '
                    + 'Predictable, but wrong for part-months and for joiners and leavers.'
                  : 'The requirement is worked out day by day from the shift and the calendar — '
                    + 'September 2026 is 225h, October is 243h. The figure below is shown beside '
                    + 'it as the stated norm so a mismatch is visible.'}
              </span>
            </label>
            <Input label="Monthly hours" type="number" step="0.5" value={String(draft.monthly_hours ?? '')}
              onChange={e => set('monthly_hours', e.target.value)} helper={POLICY_FIELD_HELP.monthly_hours} />
            <Input label="Week offs per month" type="number" value={String(draft.week_offs_per_month ?? '')}
              onChange={e => set('week_offs_per_month', e.target.value)}
              helper={POLICY_FIELD_HELP.week_offs_per_month} />
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Default shift</span>
              <select
                value={String(draft.default_shift_id ?? '')}
                onChange={e => set('default_shift_id', e.target.value)}
                className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
              >
                <option value="">Not set</option>
                {(shifts ?? []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
                A reference for guidance. The shift actually in force still comes from Schedules,
                so the two can never disagree.
              </span>
            </label>
          </Section>

          {/* No half-day thresholds: the business has no half-day flow, and a
              field that configures a concept the app does not implement is a
              trap. The columns stay in the schema, unused, in case one is
              introduced later. */}
          <Section title="What counts as a day">
            <Input label="Late grace (minutes)" type="number" value={String(draft.late_grace_minutes ?? '')}
              onChange={e => set('late_grace_minutes', e.target.value)} helper={POLICY_FIELD_HELP.late_grace_minutes} />
            <Input label="Overtime after (minutes)" type="number" value={String(draft.overtime_after_minutes ?? '')}
              onChange={e => set('overtime_after_minutes', e.target.value)}
              helper={POLICY_FIELD_HELP.overtime_after_minutes} />
            <Input label="Overtime multiplier" type="number" step="0.25"
              value={String(draft.overtime_multiplier ?? '')} onChange={e => set('overtime_multiplier', e.target.value)}
              helper={POLICY_FIELD_HELP.overtime_multiplier} />
          </Section>

          <Section title="Leave and permission — recorded, not applied">
            <p className="sm:col-span-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
              Nothing here changes a balance. Every leave figure in the app is read from
              <strong> Leave Quotas</strong>, which is held per employee per year and edited
              there (or imported by CSV). These boxes record what this policy is meant to
              grant, so the intent is written down beside the rest of the scheme — they are
              annual because the quota they describe is annual.
            </p>
            <Input label="Casual leave" type="number" step="0.5" value={String(draft.casual_leave_days ?? '')}
              onChange={e => set('casual_leave_days', e.target.value)}
              helper={POLICY_FIELD_HELP.casual_leave_days} />
            <Input label="Sick leave" type="number" step="0.5" value={String(draft.sick_leave_days ?? '')}
              onChange={e => set('sick_leave_days', e.target.value)}
              helper={POLICY_FIELD_HELP.sick_leave_days} />
            <Input label="Earned leave" type="number" step="0.5" value={String(draft.earned_leave_days ?? '')}
              onChange={e => set('earned_leave_days', e.target.value)}
              helper={POLICY_FIELD_HELP.earned_leave_days} />
            <Input label="Carry forward (days)" type="number" step="0.5" value={String(draft.carry_forward_days ?? '')}
              onChange={e => set('carry_forward_days', e.target.value)}
              helper={POLICY_FIELD_HELP.carry_forward_days} />
            <Input label="Permission hours per month" type="number" step="0.5"
              value={String(draft.permission_hours_per_month ?? '')}
              onChange={e => set('permission_hours_per_month', e.target.value)}
              helper={POLICY_FIELD_HELP.permission_hours_per_month} />
          </Section>

          <Section title="Statutory">
            <div className="sm:col-span-2 space-y-1.5">
              {STATUTORY.map(([k, label, hint]) => (
                <label key={String(k)} className="flex items-start gap-2.5">
                  <input
                    type="checkbox"
                    checked={Boolean(draft[k as string])}
                    onChange={e => set(k as string, e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-slate-300"
                  />
                  <span>
                    <span className="text-sm text-slate-700 dark:text-slate-200">{label}</span>
                    <span className="block text-[11px] text-slate-500 dark:text-slate-400">{hint}</span>
                  </span>
                </label>
              ))}
              <p className="pt-1 text-[11px] text-slate-500 dark:text-slate-400">
                These record whether a deduction <em>applies</em>. No rates or amounts are held
                here — this stays an attendance system whose output supports payroll.
              </p>
            </div>
          </Section>

          <Section title="Employment terms">
            <Input label="Probation (months)" type="number" value={String(draft.probation_months ?? '')}
              onChange={e => set('probation_months', e.target.value)}
              helper={POLICY_FIELD_HELP.probation_months} />
            <Input label="Notice period (days)" type="number" value={String(draft.notice_period_days ?? '')}
              onChange={e => set('notice_period_days', e.target.value)}
              helper={POLICY_FIELD_HELP.notice_period_days} />
          </Section>

          <Section title="Performance weights">
            <Input label="Attendance" type="number" value={String(draft.score_weight_attendance ?? 40)}
              onChange={e => set('score_weight_attendance', e.target.value)}
              helper={POLICY_FIELD_HELP.score_weight_attendance} />
            <Input label="Punctuality" type="number" value={String(draft.score_weight_punctuality ?? 30)}
              onChange={e => set('score_weight_punctuality', e.target.value)}
              helper={POLICY_FIELD_HELP.score_weight_punctuality} />
            <Input label="Hours delivered" type="number" value={String(draft.score_weight_hours ?? 30)}
              onChange={e => set('score_weight_hours', e.target.value)}
              helper={POLICY_FIELD_HELP.score_weight_hours} />
            <p className="text-xs text-slate-500 dark:text-slate-400 sm:col-span-2">
              Punctuality cannot be measured on a flexible shift. When it cannot, its weight is
              shared across the other two rather than scoring somebody out of less than everyone else.
            </p>
          </Section>

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

          <div className="flex justify-end gap-2 border-t border-slate-200 pt-3 dark:border-slate-700">
            <Button variant="secondary" onClick={() => { setCreating(false); setEditing(null); }}>Cancel</Button>
            <Button onClick={() => save.mutate()} loading={save.isPending}>
              {editing ? 'Save changes' : 'Create policy'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ---- Assign ------------------------------------------------------ */}
      <Modal
        open={!!assignTarget}
        onClose={() => setAssignTarget(null)}
        title={assignTarget ? `Assign "${assignTarget.name}"` : ''}
        size="lg"
      >
        <div className="space-y-3">
          <Input label="Effective from" type="date" value={effectiveFrom}
            onChange={e => setEffectiveFrom(e.target.value)} className="w-44" />
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Anyone already on another policy has that assignment closed the day before this
            date, so their history stays a clean handover. Months before it keep the rules they
            were computed under.
          </p>

          <div className="max-h-72 space-y-0.5 overflow-y-auto rounded-lg border border-slate-200 p-2 dark:border-slate-700">
            {(employees ?? []).map(e => {
              const current = byEmployee.get(e.id);
              return (
                <label key={e.id} className="flex items-center gap-2.5 rounded px-2 py-1 hover:bg-slate-50 dark:hover:bg-slate-800">
                  <input
                    type="checkbox"
                    checked={selected.has(e.id)}
                    onChange={ev => setSelected(s => {
                      const n = new Set(s);
                      if (ev.target.checked) n.add(e.id); else n.delete(e.id);
                      return n;
                    })}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  <span className="flex-1 text-sm text-slate-700 dark:text-slate-200">
                    {e.name} <span className="text-xs text-slate-400">{e.emp_id}</span>
                  </span>
                  {current && (
                    <span className="text-[11px] text-slate-400">
                      {current.policy_id === assignTarget?.id ? 'already on this' : `on ${current.policy_name}`}
                    </span>
                  )}
                </label>
              );
            })}
          </div>

          {/* The shift move. Shown only when the policy names a shift AND
              somebody selected is actually on a different one, so it never
              appears as an option that would do nothing. */}
          {assignTarget?.default_shift_id != null && (shiftMoves?.length ?? 0) > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/50 dark:bg-amber-950/40">
              <label className="flex items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={applyShift}
                  onChange={e => setApplyShift(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300"
                  disabled={Boolean(shiftMoves?.[0]?.blocked)}
                />
                <span className="text-sm text-amber-900 dark:text-amber-200">
                  Also move them onto{' '}
                  <strong>{shiftMoves?.[0]?.to_shift_name}</strong>, the shift this policy names
                </span>
              </label>
              {shiftMoves?.[0]?.blocked ? (
                <p className="mt-2 text-xs text-red-700 dark:text-red-300">
                  Cannot move anybody from this date: {shiftMoves[0].blocked} The policy can
                  still be assigned; change the date to move shifts too.
                </p>
              ) : (
                <>
                  <ul className="mt-2 space-y-0.5 text-xs text-amber-900 dark:text-amber-200">
                    {shiftMoves?.slice(0, 8).map(m => (
                      <li key={m.employee_id}>
                        {m.employee_name}: {m.from_shift_name ?? 'no shift'} &rarr; {m.to_shift_name}
                      </li>
                    ))}
                    {(shiftMoves?.length ?? 0) > 8 && (
                      <li>and {(shiftMoves?.length ?? 0) - 8} more</li>
                    )}
                  </ul>
                  <p className="mt-2 text-[11px] text-amber-800 dark:text-amber-300">
                    This writes a real schedule entry from {effectiveFrom}, so the mobile app
                    sees it too and earlier months keep the shift they were worked under.
                    Removing the policy later does not move anybody back.
                  </p>
                  {/* The quiet one. A move dated today leaves every day already
                      worked this month on the OLD shift, so nothing visible
                      changes and the screen still reports success. */}
                  {(shiftMoves?.some(m => m.earlier_days_this_month > 0) ?? false) && (
                    <p className="mt-2 rounded border border-amber-300 bg-amber-100 px-2 py-1.5 text-[11px] text-amber-900 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-100">
                      <strong>Days already worked this month keep the old shift.</strong>{' '}
                      {shiftMoves?.filter(m => m.earlier_days_this_month > 0)
                        .slice(0, 3)
                        .map(m => `${m.employee_name} (${m.earlier_days_this_month})`)
                        .join(', ')}
                      {' '}— so lateness on those days stays unmeasured. Set the date to the
                      start of the month if they should have been on{' '}
                      {shiftMoves?.[0]?.to_shift_name} all along.
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500 dark:text-slate-400">{selected.size} selected</span>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setAssignTarget(null)}>Close</Button>
              <Button onClick={() => assign.mutate()} loading={assign.isPending} disabled={selected.size === 0}>
                Assign {selected.size || ''}
              </Button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {title}
      </h3>
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </div>
  );
}

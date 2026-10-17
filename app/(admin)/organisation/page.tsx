'use client';

/**
 * /organisation — the company, its structure, and who sits where.
 *
 * Four views behind one set of tabs, because they are four answers to one
 * question and splitting them across four sidebar entries is what made the
 * old navigation need searching.
 *
 * Every create and edit opens a DRAWER, not a modal. The tree or list you were
 * reading stays visible beside it, which matters most here: placing somebody
 * means looking at the structure while you do it.
 *
 * The unplaced queue leads the People tab rather than hiding at the bottom.
 * Seventeen people are currently in no department, and an employee nobody has
 * placed is invisible to department-scoped permissions later - so this is not
 * a tidiness warning, it is the thing that has to be cleared before access
 * control can mean anything.
 */

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import NumberField from '@/components/ui/NumberField';
import Badge from '@/components/ui/Badge';
import Spinner from '@/components/ui/Spinner';
import Drawer from '@/components/ui/Drawer';
import FilterBar from '@/components/ui/FilterBar';
import MultiSelectList from '@/components/ui/MultiSelectList';
import type { ApiResponse, Employee } from '@/lib/types';
import { codeFromName } from '@/lib/suggest';
import Suggest from '@/components/ui/Suggest';

type Tab = 'structure' | 'people' | 'grades' | 'company';

interface Department {
  id: number; parent_id: number | null; name: string; code: string;
  /** Which company it belongs to. The column existed; nothing ever set it. */
  company_id: number | null;
  description: string | null; head_employee_id: number | null; head_name: string | null;
  depth: number; sort_order: number; is_active: boolean;
  employee_count: number; team_count: number;
}
interface DepartmentNode extends Department { children: DepartmentNode[] }
interface Grade {
  id: number; code: string; name: string; rank_order: number;
  description: string | null; is_active: boolean; employee_count: number;
}
interface Team {
  id: number; department_id: number; department_name: string | null;
  name: string; code: string; lead_employee_id: number | null; lead_name: string | null;
  is_active: boolean; employee_count: number;
}
interface Assignment {
  id: number; employee_id: number; employee_name: string; emp_id: string;
  department_name: string | null; team_name: string | null; grade_code: string | null;
  reports_to_name: string | null; designation: string | null;
  effective_from: string; effective_to: string | null;
}
interface Unplaced { id: number; name: string; emp_id: string; legacy_department: string | null }
interface ChainRow {
  company_id: number; legal_name: string;
  sites: number; departments: number;
  people_by_department: number; people_by_site: number;
}

interface ChainGaps {
  sites_without_company: Array<{ id: number; name: string }>;
  departments_without_company: Array<{ id: number; name: string }>;
  people_in_two_companies: Array<{
    id: number; name: string; emp_id: string; site: string; department: string;
  }>;
}

interface CompanyLocation {
  id: number; name: string; company_id: number | null; address: string | null;
  city: string | null; state_code: string | null; country_code: string | null;
}

interface Company {
  id: number; legal_name: string; trading_name: string | null; registration_no: string | null;
  pan: string | null; gstin: string | null; city: string | null; country_code: string;
  email: string | null; phone: string | null; fy_start_month: number; timezone: string;
  is_active: boolean;
  /** The work site that is the registered office, when one has been chosen. */
  registered_location_id: number | null;
  registered_location_name: string | null;
}

const today = () => new Date().toISOString().slice(0, 10);

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json: ApiResponse<T> = await res.json();
  if (!json.success) throw new Error(json.error ?? 'Could not load');
  return json.data as T;
}
async function postJson<T = unknown>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json: ApiResponse<T> = await res.json();
  if (!json.success) throw new Error(json.error ?? 'Could not save');
  return json.data as T;
}

/**
 * The active switch, on everything the structure is made of.
 *
 * A department, team, grade or company could be created and renamed but never
 * taken out of use. Every form sent is_active: true and nothing ever sent
 * false, so a team made by mistake stayed in every dropdown for good - and
 * `include_inactive=1` existed on all four endpoints with nothing asking for
 * it, so even a row retired in the database could not be found again.
 *
 * Retiring, not deleting, on purpose: people were placed in these, and the
 * placements are dated history. Dropping the row would leave a figure nobody
 * can explain; retiring takes it out of the lists and leaves the record.
 */
/** Says a row is out of use, wherever one can now be shown. */
function RetiredMark({ when }: { when: boolean }) {
  if (!when) return null;
  return (
    <span className="rounded bg-slate-200 px-1.5 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-700 dark:text-slate-300">
      Retired
    </span>
  );
}

function ActiveSwitch({ value, onChange, noun }: {
  value: boolean;
  onChange: (v: boolean) => void;
  noun: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
      <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
        <input
          type="checkbox"
          checked={value}
          onChange={e => onChange(e.target.checked)}
        />
        In use
      </label>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Untick to retire this {noun}. It stops being offered anywhere new, and
          stays on the record for everything already counted against it. Tick
          &ldquo;Show retired&rdquo; above to find it again.
      </p>
    </div>
  );
}

/**
 * The tab is addressable.
 *
 * It was state and nothing else, so there was no way to send somebody to the
 * Company tab - not from a link, not from the setup guide, not from another
 * screen saying 'set the company on each'. `?tab=company` now opens it, and
 * the four names are the same ones the strip uses.
 */
export default function OrganisationPage() {
  return (
    <Suspense fallback={<Card><div className="py-10 text-center text-sm text-slate-400">Loading\u2026</div></Card>}>
      <OrganisationPageInner />
    </Suspense>
  );
}

const TAB_NAMES: Tab[] = ['structure', 'people', 'grades', 'company'];

function OrganisationPageInner() {
  const qc = useQueryClient();
  const searchParams = useSearchParams();
  const asked = searchParams.get('tab') as Tab | null;
  const wanted: Tab | null = asked && TAB_NAMES.includes(asked) ? asked : null;
  const [tab, setTab] = useState<Tab>(wanted ?? 'structure');

  // The URL may change while this page stays mounted - the setup guide moves
  // between the Company and Structure steps without leaving /organisation - so
  // the tab has to FOLLOW the parameter, not merely start from it. Tracking
  // the last value seen keeps a click on the strip from being yanked back.
  const [lastAsked, setLastAsked] = useState<Tab | null>(wanted);
  if (wanted !== lastAsked) {
    setLastAsked(wanted);
    if (wanted) setTab(wanted);
  }
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [deptDraft, setDeptDraft] = useState<Partial<Department> | null>(null);
  const [teamDraft, setTeamDraft] = useState<Partial<Team> | null>(null);
  const [gradeDraft, setGradeDraft] = useState<Partial<Grade> | null>(null);
  const [placing, setPlacing] = useState<{ id: number; name: string } | null>(null);
  const [showRetired, setShowRetired] = useState(false);

  /** '?include_inactive=1' when retired rows are being shown. */
  const inactiveQs = showRetired ? '?include_inactive=1' : '';

  const { data: deptData, isLoading: deptLoading } = useQuery({
    queryKey: ['org', 'departments', showRetired],
    queryFn: () => getJson<{ departments: Department[]; tree: DepartmentNode[] }>(`/api/org/departments${inactiveQs}`),
  });
  const { data: gradeData } = useQuery({
    queryKey: ['org', 'grades', showRetired],
    queryFn: () => getJson<{ grades: Grade[] }>(`/api/org/grades${inactiveQs}`),
  });
  const { data: teamData } = useQuery({
    queryKey: ['org', 'teams', showRetired],
    queryFn: () => getJson<{ teams: Team[] }>(`/api/org/teams${inactiveQs}`),
  });
  const { data: peopleData, isLoading: peopleLoading } = useQuery({
    queryKey: ['org', 'assignments'],
    queryFn: () => getJson<{ assignments: Assignment[]; unplaced: Unplaced[] }>(
      '/api/org/assignments?with_unplaced=1'),
  });
  const { data: companyData } = useQuery({
    queryKey: ['org', 'companies', showRetired],
    queryFn: () => getJson<{
      companies: Company[]; locations: CompanyLocation[];
      chain: ChainRow[]; gaps: ChainGaps;
    }>(`/api/org/companies${inactiveQs}`),
  });
  const { data: employees } = useQuery({
    queryKey: ['employees', 'for-org'],
    queryFn: () => getJson<{ employees: Employee[] }>('/api/employees?limit=300')
      .then(d => d.employees),
  });

  const departments = deptData?.departments ?? [];
  const tree = deptData?.tree ?? [];
  const grades = gradeData?.grades ?? [];
  const teams = teamData?.teams ?? [];
  const unplaced = peopleData?.unplaced ?? [];
  const allAssignments = peopleData?.assignments ?? [];
  const [peopleSearch, setPeopleSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const assignments = allAssignments.filter(a => {
    if (deptFilter && String(a.department_name ?? '') !== deptFilter) return false;
    const q = peopleSearch.trim().toLowerCase();
    if (!q) return true;
    return a.employee_name.toLowerCase().includes(q)
      || a.emp_id.toLowerCase().includes(q);
  });

  // Job titles already in use. Typed fresh each time, 'Plant Supervisor'
  // becomes 'plant supervisor' and then 'Plant Suprvisor', and no report can
  // group by it afterwards. A datalist keeps the field free text - job titles
  // genuinely are open-ended - while making the existing spelling the easiest
  // thing to pick.
  const designationsInUse = Array.from(new Set(
    allAssignments.map(a => a.designation).filter((d): d is string => Boolean(d)),
  )).sort((a, b) => a.localeCompare(b));

  function afterSave(message: string) {
    setError(null);
    setNotice(message);
    qc.invalidateQueries({ queryKey: ['org'] });
  }

  const saveDept = useMutation({
    mutationFn: (d: Partial<Department>) => postJson('/api/org/departments', d),
    onSuccess: () => { setDeptDraft(null); afterSave('Department saved.'); },
    onError: (e: Error) => setError(e.message),
  });
  const saveTeam = useMutation({
    mutationFn: (t: Partial<Team>) => postJson('/api/org/teams', t),
    onSuccess: () => { setTeamDraft(null); afterSave('Team saved.'); },
    onError: (e: Error) => setError(e.message),
  });
  const saveGrade = useMutation({
    mutationFn: (g: Partial<Grade>) => postJson('/api/org/grades', g),
    onSuccess: () => { setGradeDraft(null); afterSave('Grade saved.'); },
    onError: (e: Error) => setError(e.message),
  });
  const place = useMutation({
    mutationFn: (body: Record<string, unknown>) => postJson('/api/org/assignments', body),
    onSuccess: () => { setPlacing(null); afterSave('Placement saved.'); },
    onError: (e: Error) => setError(e.message),
  });

  const TABS: Array<[Tab, string, number | null]> = [
    ['structure', 'Structure', departments.length],
    ['people', 'People', unplaced.length || null],
    ['grades', 'Grades', grades.length],
    ['company', 'Company', companyData?.companies.length ?? null],
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Organisation</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Your departments and teams, the grades people hold, and who reports to whom.
          Placements are dated, so moving somebody in June leaves May reported as it was.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}
      {notice && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200">
          {notice}
          <button onClick={() => setNotice(null)} className="text-xs underline">Dismiss</button>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
        {TABS.map(([key, label, count]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === key
                ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
                : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            {label}
            {count !== null && (
              <span className="ml-1.5 text-xs text-slate-400">{count}</span>
            )}
          </button>
        ))}
        </div>

        {/* Retired rows are hidden by default and were unreachable once
            retired. One tick brings them back into view. */}
        <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <input
            type="checkbox"
            checked={showRetired}
            onChange={e => setShowRetired(e.target.checked)}
          />
          Show retired
        </label>
      </div>

      {/* ---------------- Structure ---------------- */}
      {tab === 'structure' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              A department with no parent is level 1. Nest as deep as you need.
            </p>
            <div className="flex gap-2">
              <Button
                data-tour="department-new"
                onClick={() => setDeptDraft({ sort_order: 0, is_active: true })}
              >
                New department
              </Button>
              <Button
                variant="secondary"
                data-tour="team-new"
                disabled={departments.length === 0}
                onClick={() => setTeamDraft({ department_id: departments[0]?.id, is_active: true })}
              >
                New team
              </Button>
            </div>
          </div>

          {deptLoading ? (
            <Card><div className="flex justify-center py-10"><Spinner /></div></Card>
          ) : tree.length === 0 ? (
            <Card>
              <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
                No departments yet. Create your first one &mdash; everything else hangs off it.
              </p>
            </Card>
          ) : (
            <Card padding={false}>
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {tree.map(node => (
                  <DeptRow
                    key={node.id} node={node} teams={teams}
                    onEdit={d => setDeptDraft(d)}
                    onAddChild={parent => setDeptDraft({ parent_id: parent.id, is_active: true, sort_order: 0 })}
                    onAddTeam={d => setTeamDraft({ department_id: d.id, is_active: true })}
                    onEditTeam={t => setTeamDraft(t)}
                  />
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {/* ---------------- People ---------------- */}
      {tab === 'people' && (
        <div className="space-y-4">
          {/* Leads, deliberately. Anybody unplaced is invisible to
              department-scoped access later, so this is the queue that has to
              be cleared before permissions can mean anything. */}
          {unplaced.length > 0 && (
            <Card>
              <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                {unplaced.length} {unplaced.length === 1 ? 'person is' : 'people are'} not in any department
              </h2>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Until somebody is placed they fall outside every department-based rule.
                Where a legacy value survived it is shown as a hint &mdash; some of them are
                not departments at all, which is why none were mapped automatically.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {unplaced.map(u => (
                  <button
                    key={u.id}
                    onClick={() => setPlacing({ id: u.id, name: u.name })}
                    className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-sm text-amber-900 transition-colors hover:bg-amber-100 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-900/40"
                  >
                    {u.name}
                    <span className="text-xs text-amber-700/70 dark:text-amber-300/70">{u.emp_id}</span>
                    {u.legacy_department && (
                      <span className="rounded bg-amber-200 px-1.5 text-[11px] text-amber-900 dark:bg-amber-800 dark:text-amber-100">
                        was: {u.legacy_department}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </Card>
          )}

          <FilterBar
            search={peopleSearch}
            onSearchChange={setPeopleSearch}
            searchPlaceholder="Name or employee ID…"
            filters={[{ key: 'dept', label: 'Department', options:
              departments.map(d => ({ value: d.name, label: d.name })) }]}
            values={{ dept: deptFilter }}
            onChange={(_k, v) => setDeptFilter(v)}
            onClear={() => { setPeopleSearch(''); setDeptFilter(''); }}
            showing={{ shown: assignments.length, total: allAssignments.length, noun: 'placed' }}
          />

          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-500 dark:text-slate-400">Current placements</p>
            <Button
              variant="secondary"
              disabled={!employees?.length}
              onClick={() => setPlacing({ id: employees![0].id, name: employees![0].name })}
            >
              Place someone
            </Button>
          </div>

          {peopleLoading ? (
            <Card><div className="flex justify-center py-10"><Spinner /></div></Card>
          ) : (
            <Card padding={false}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-700 dark:text-slate-400">
                    <tr>
                      <th className="px-4 py-2 font-medium">Employee</th>
                      <th className="px-4 py-2 font-medium">Department</th>
                      <th className="px-4 py-2 font-medium">Team</th>
                      <th className="px-4 py-2 font-medium">Grade</th>
                      <th className="px-4 py-2 font-medium">Reports to</th>
                      <th className="px-4 py-2 font-medium">Since</th>
                      <th className="px-4 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {assignments.map(a => (
                      <tr key={a.id}>
                        <td className="px-4 py-2">
                          <p className="font-medium text-slate-800 dark:text-slate-200">{a.employee_name}</p>
                          <p className="text-xs text-slate-400">{a.emp_id}</p>
                        </td>
                        <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{a.department_name ?? '--'}</td>
                        <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{a.team_name ?? '--'}</td>
                        <td className="px-4 py-2">
                          {a.grade_code ? <Badge variant="info">{a.grade_code}</Badge> : <span className="text-slate-400">--</span>}
                        </td>
                        <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{a.reports_to_name ?? '--'}</td>
                        <td className="px-4 py-2 tabular-nums text-slate-500 dark:text-slate-400">{a.effective_from}</td>
                        <td className="px-4 py-2 text-right">
                          <button
                            onClick={() => setPlacing({ id: a.employee_id, name: a.employee_name })}
                            className="text-xs font-medium text-blue-600 underline decoration-dotted hover:decoration-solid dark:text-blue-400"
                          >
                            Move
                          </button>
                        </td>
                      </tr>
                    ))}
                    {assignments.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400">
                          {allAssignments.length > 0
                            ? 'Nobody matches those filters.'
                            : 'Nobody is placed yet.'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* ---------------- Grades ---------------- */}
      {tab === 'grades' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Seniority, carried by the person. A grade travels with somebody when they
              change department, which is why it is not part of the structure.
            </p>
            <Button onClick={() => setGradeDraft({ rank_order: (grades.at(-1)?.rank_order ?? 0) + 10, is_active: true })}>
              New grade
            </Button>
          </div>
          <Card padding={false}>
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {grades.map(g => (
                <div key={g.id} className="flex items-center gap-3 px-4 py-2.5">
                  <Badge variant="neutral">{g.code}</Badge>
                  <span className="flex-1 text-sm text-slate-800 dark:text-slate-200">
                    {g.name} <RetiredMark when={!g.is_active} />
                  </span>
                  <span className="text-xs text-slate-400">{g.employee_count} held</span>
                  <button
                    onClick={() => setGradeDraft(g)}
                    className="text-xs font-medium text-blue-600 underline decoration-dotted hover:decoration-solid dark:text-blue-400"
                  >
                    Edit
                  </button>
                </div>
              ))}
              {grades.length === 0 && (
                <p className="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400">No grades yet.</p>
              )}
            </div>
          </Card>
        </div>
      )}

      {/* ---------------- Company ---------------- */}
      {tab === 'company' && (
        <CompanyTab
          companies={companyData?.companies ?? []}
          locations={companyData?.locations ?? []}
          chain={companyData?.chain ?? []}
          gaps={companyData?.gaps}
          departments={departments}
          onPlacePeople={() => setTab('people')}
          onSaved={() => afterSave('Company saved.')}
          onError={setError}
        />
      )}

      {/* ---------------- Drawers ---------------- */}
      <Drawer
        open={deptDraft !== null}
        onClose={() => setDeptDraft(null)}
        title={deptDraft?.id ? 'Edit department' : 'New department'}
        description="A department with no parent sits at level 1."
        size="md"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeptDraft(null)}>Cancel</Button>
            <Button loading={saveDept.isPending} onClick={() => saveDept.mutate(deptDraft!)}>Save</Button>
          </div>
        }
      >
        {deptDraft && (
          <div className="space-y-3">
            <Input label="Name" required value={deptDraft.name ?? ''}
              onChange={e => setDeptDraft({ ...deptDraft, name: e.target.value })} />
            <div className="flex flex-col gap-1">
              <Input label="Code" required value={deptDraft.code ?? ''}
                onChange={e => setDeptDraft({ ...deptDraft, code: e.target.value })}
                helper="Short unique handle, e.g. OPS. Used in exports." />
              <Suggest suggestion={codeFromName(deptDraft.name)} current={deptDraft.code}
                onUse={v => setDeptDraft({ ...deptDraft, code: v })} />
            </div>
            {/* The column has existed since the org migration and nothing ever
                set it, so every department belonged to no company. */}
            <Select
              label="Company"
              value={deptDraft.company_id ?? ''}
              onChange={v => setDeptDraft({ ...deptDraft, company_id: v ? Number(v) : null })}
              options={[
                { value: '', label: 'Not set' },
                ...(companyData?.companies ?? []).map(c => ({
                  value: c.id, label: c.legal_name,
                })),
              ]}
              helper="Which company this department belongs to. A child department should
                normally match its parent."
            />
            <Select
              label="Sits under"
              value={deptDraft.parent_id ?? ''}
              onChange={v => setDeptDraft({ ...deptDraft, parent_id: v ? Number(v) : null })}
              options={[
                { value: '', label: 'Nothing - this is a level 1 department' },
                ...departments
                  .filter(d => d.id !== deptDraft.id)
                  .map(d => ({ value: d.id, label: `${'—'.repeat(d.depth)} ${d.name}`.trim() })),
              ]}
              helper="A department cannot sit under itself or under one of its own children."
            />
            <Select
              label="Head of department"
              value={deptDraft.head_employee_id ?? ''}
              onChange={v => setDeptDraft({ ...deptDraft, head_employee_id: v ? Number(v) : null })}
              options={[{ value: '', label: 'Not set' },
                ...(employees ?? []).map(e => ({ value: e.id, label: `${e.name} (${e.emp_id})` }))]}
            />
            <Input label="Description" value={deptDraft.description ?? ''}
              onChange={e => setDeptDraft({ ...deptDraft, description: e.target.value })} />
            {deptDraft.id && (
              <ActiveSwitch
                value={deptDraft.is_active !== false}
                onChange={v => setDeptDraft({ ...deptDraft, is_active: v })}
                noun="department"
              />
            )}
          </div>
        )}
      </Drawer>

      <Drawer
        open={teamDraft !== null}
        onClose={() => setTeamDraft(null)}
        title={teamDraft?.id ? 'Edit team' : 'New team'}
        description="A team belongs to exactly one department."
        size="md"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setTeamDraft(null)}>Cancel</Button>
            <Button loading={saveTeam.isPending} onClick={() => saveTeam.mutate(teamDraft!)}>Save</Button>
          </div>
        }
      >
        {teamDraft && (
          <div className="space-y-3">
            <Input label="Name" required value={teamDraft.name ?? ''}
              onChange={e => setTeamDraft({ ...teamDraft, name: e.target.value })} />
            <div className="flex flex-col gap-1">
              <Input label="Code" required value={teamDraft.code ?? ''}
                onChange={e => setTeamDraft({ ...teamDraft, code: e.target.value })}
                helper="Short unique handle. Used in exports." />
              <Suggest suggestion={codeFromName(teamDraft.name)} current={teamDraft.code}
                onUse={v => setTeamDraft({ ...teamDraft, code: v })} />
            </div>
            <Select
              label="Department"
              value={teamDraft.department_id ?? ''}
              onChange={v => setTeamDraft({ ...teamDraft, department_id: Number(v) })}
              options={departments.map(d => ({ value: d.id, label: d.name }))}
            />
            <Select
              label="Team lead"
              value={teamDraft.lead_employee_id ?? ''}
              onChange={v => setTeamDraft({ ...teamDraft, lead_employee_id: v ? Number(v) : null })}
              options={[{ value: '', label: 'Not set' },
                ...(employees ?? []).map(e => ({ value: e.id, label: `${e.name} (${e.emp_id})` }))]}
            />
            {teamDraft.id && (
              <ActiveSwitch
                value={teamDraft.is_active !== false}
                onChange={v => setTeamDraft({ ...teamDraft, is_active: v })}
                noun="team"
              />
            )}
          </div>
        )}
      </Drawer>

      <Drawer
        open={gradeDraft !== null}
        onClose={() => setGradeDraft(null)}
        title={gradeDraft?.id ? 'Edit grade' : 'New grade'}
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setGradeDraft(null)}>Cancel</Button>
            <Button loading={saveGrade.isPending} onClick={() => saveGrade.mutate(gradeDraft!)}>Save</Button>
          </div>
        }
      >
        {gradeDraft && (
          <div className="space-y-3">
            <div className="flex flex-col gap-1">
              <Input label="Code" required value={gradeDraft.code ?? ''}
                onChange={e => setGradeDraft({ ...gradeDraft, code: e.target.value })}
                helper="Short unique handle, e.g. M2." />
              <Suggest suggestion={codeFromName(gradeDraft.name, 8)} current={gradeDraft.code}
                onUse={v => setGradeDraft({ ...gradeDraft, code: v })} />
            </div>
            <Input label="Name" required value={gradeDraft.name ?? ''}
              onChange={e => setGradeDraft({ ...gradeDraft, name: e.target.value })} />
            <NumberField label="Rank" value={gradeDraft.rank_order ?? null}
              onChange={v => setGradeDraft({ ...gradeDraft, rank_order: v ?? undefined })}
              helper="Lower is more junior. Leave gaps (10, 20, 30) so a grade can be inserted between two later without renumbering." />
            {gradeDraft.id && (
              <ActiveSwitch
                value={gradeDraft.is_active !== false}
                onChange={v => setGradeDraft({ ...gradeDraft, is_active: v })}
                noun="grade"
              />
            )}
          </div>
        )}
      </Drawer>

      <PlaceDrawer
        placing={placing}
        onClose={() => setPlacing(null)}
        employees={employees ?? []}
        departments={departments}
        teams={teams}
        grades={grades}
        pending={place.isPending}
        designations={designationsInUse}
        onSubmit={body => place.mutate(body)}
      />
    </div>
  );
}

/** One department and everything under it. Recurses, because the data does. */
function DeptRow({
  node, teams, onEdit, onAddChild, onAddTeam, onEditTeam,
}: {
  node: DepartmentNode;
  teams: Team[];
  onEdit: (d: Department) => void;
  onAddChild: (d: Department) => void;
  onAddTeam: (d: Department) => void;
  onEditTeam: (t: Team) => void;
}) {
  const mine = teams.filter(t => t.department_id === node.id);
  return (
    <>
      <div
        className="group flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/50"
        style={{ paddingLeft: `${16 + node.depth * 24}px` }}
      >
        <Badge variant="neutral">{node.code}</Badge>
        <span className="font-medium text-slate-800 dark:text-slate-200">{node.name}</span>
        <RetiredMark when={!node.is_active} />
        {node.head_name && (
          <span className="text-xs text-slate-400">head: {node.head_name}</span>
        )}
        <span className="text-xs text-slate-400">
          {node.employee_count} {node.employee_count === 1 ? 'person' : 'people'}
        </span>
        <div className="ml-auto flex gap-3 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <button onClick={() => onAddChild(node)} className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400">
            Add sub-department
          </button>
          <button onClick={() => onAddTeam(node)} className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400">
            Add team
          </button>
          <button onClick={() => onEdit(node)} className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400">
            Edit
          </button>
        </div>
      </div>

      {mine.map(t => (
        <div
          key={t.id}
          className="group flex items-center gap-3 bg-slate-50/50 px-4 py-1.5 text-sm dark:bg-slate-800/30"
          style={{ paddingLeft: `${16 + (node.depth + 1) * 24}px` }}
        >
          <span className="text-xs text-slate-400">team</span>
          <span className="text-slate-700 dark:text-slate-300">{t.name}</span>
          <RetiredMark when={!t.is_active} />
          {t.lead_name && <span className="text-xs text-slate-400">lead: {t.lead_name}</span>}
          <span className="text-xs text-slate-400">{t.employee_count}</span>
          <button
            onClick={() => onEditTeam(t)}
            className="ml-auto text-xs font-medium text-blue-600 opacity-0 transition-opacity hover:underline group-hover:opacity-100 dark:text-blue-400"
          >
            Edit
          </button>
        </div>
      ))}

      {node.children.map(child => (
        <DeptRow
          key={child.id} node={child} teams={teams}
          onEdit={onEdit} onAddChild={onAddChild} onAddTeam={onAddTeam} onEditTeam={onEditTeam}
        />
      ))}
    </>
  );
}

function PlaceDrawer({
  placing, onClose, employees, departments, teams, grades, designations,
  pending, onSubmit,
}: {
  placing: { id: number; name: string } | null;
  onClose: () => void;
  employees: Employee[];
  departments: Department[];
  teams: Team[];
  grades: Grade[];
  designations: string[];
  pending: boolean;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [departmentId, setDepartmentId] = useState<string>('');
  const [teamId, setTeamId] = useState<string>('');
  const [gradeId, setGradeId] = useState<string>('');
  const [reportsTo, setReportsTo] = useState<string>('');
  const [designation, setDesignation] = useState('');
  const [from, setFrom] = useState(today());

  // Re-seed when a different person is opened, so the drawer never shows the
  // last person's details against this one's name.
  const current = placing?.id ?? null;
  if (current !== employeeId) {
    setEmployeeId(current);
    setDepartmentId(''); setTeamId(''); setGradeId('');
    setReportsTo(''); setDesignation(''); setFrom(today());
  }

  // A team belongs to one department, so offering teams from elsewhere would
  // only ever produce the mismatch the server refuses.
  const selectableTeams = departmentId
    ? teams.filter(t => t.department_id === Number(departmentId))
    : [];

  return (
    <Drawer
      open={placing !== null}
      onClose={onClose}
      title={placing ? `Place ${placing.name}` : ''}
      description="Dated, so earlier months keep the placement they were reported under."
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            loading={pending}
            onClick={() => onSubmit({
              employee_id: placing!.id,
              // Sent only when chosen. Omitting a field keeps what is already
              // there, so moving somebody's department does not wipe their
              // manager and grade.
              ...(departmentId ? { department_id: Number(departmentId) } : {}),
              ...(teamId ? { team_id: Number(teamId) } : {}),
              ...(gradeId ? { grade_id: Number(gradeId) } : {}),
              ...(reportsTo ? { reports_to: Number(reportsTo) } : {}),
              ...(designation ? { designation } : {}),
              effective_from: from,
            })}
          >
            Save placement
          </Button>
        </div>
      }
    >
      {placing && (
        <div className="space-y-3">
          <Select
            label="Department"
            value={departmentId}
            onChange={v => { setDepartmentId(String(v)); setTeamId(''); }}
            options={[{ value: '', label: 'Leave unchanged' },
              ...departments.map(d => ({ value: d.id, label: `${'—'.repeat(d.depth)} ${d.name}`.trim() }))]}
          />
          <Select
            label="Team"
            value={teamId}
            onChange={v => setTeamId(String(v))}
            options={[{ value: '', label: departmentId ? 'None' : 'Pick a department first' },
              ...selectableTeams.map(t => ({ value: t.id, label: t.name }))]}
          />
          <Select
            label="Grade"
            value={gradeId}
            onChange={v => setGradeId(String(v))}
            options={[{ value: '', label: 'Leave unchanged' },
              ...grades.map(g => ({ value: g.id, label: `${g.code} - ${g.name}` }))]}
          />
          <Select
            label="Reports to"
            value={reportsTo}
            onChange={v => setReportsTo(String(v))}
            options={[{ value: '', label: 'Leave unchanged' },
              ...employees.filter(e => e.id !== placing.id)
                .map(e => ({ value: e.id, label: `${e.name} (${e.emp_id})` }))]}
            helper="A reporting line cannot loop back on itself."
          />
          <Input label="Designation" value={designation} list="org-designations"
            onChange={e => setDesignation(e.target.value)}
            helper={designations.length > 0
              ? 'Their job title. Start typing to reuse one already in use - separate from their grade.'
              : 'Their job title, e.g. Plant Supervisor. Separate from their grade.'} />
          <datalist id="org-designations">
            {designations.map(d => <option key={d} value={d} />)}
          </datalist>
          <Input label="Effective from" type="date" required value={from}
            onChange={e => setFrom(e.target.value)}
            helper="Anything before this date keeps the placement it already had." />
        </div>
      )}
    </Drawer>
  );
}

/**
 * What belongs to a company, set from the company.
 *
 * The two links were only settable from the other end - a site's own form and
 * a department's own drawer - so a company said it had nothing and the fix was
 * somewhere else entirely. Five sites and three departments belonged to no
 * company for exactly that reason.
 *
 * People are NOT assigned here, deliberately. Somebody belongs to a company
 * through the department they are placed in and the site they are rostered at,
 * and a third way of saying it would be a third answer that can disagree with
 * the other two. The drawer links straight to the two screens that set those.
 */
function CompanyTab({
  companies, locations, chain, gaps, departments, onPlacePeople, onSaved, onError,
}: {
  companies: Company[];
  /** The work sites, so a registered office is chosen rather than retyped. */
  locations: CompanyLocation[];
  /** company -> sites -> departments -> people, counted. */
  chain: ChainRow[];
  gaps?: ChainGaps;
  /** Every department, so they can be attached from here. */
  departments: Department[];
  /** People are placed on another tab; this goes there rather than saying so. */
  onPlacePeople: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [draft, setDraft] = useState<Partial<Company> | null>(null);
  // What belongs to this company, edited WITH the company rather than in a
  // drawer of its own. Both links were only settable from the other end - a
  // site's own form, a department's own drawer - so a new company reported
  // zero of everything and the fix was on another screen.
  const [siteIds, setSiteIds] = useState<number[]>([]);
  const [deptIds, setDeptIds] = useState<number[]>([]);
  const [seededFor, setSeededFor] = useState<number | 'new' | null>(null);

  // The id of a company created by a save whose SECOND call then failed.
  // Saving does two writes - the company row, then what belongs to it - and
  // without this a retry after the second one failed would create the company
  // a second time, because the draft still has no id.
  // State, not a ref: it is read while rendering the next attempt, and a ref
  // read during render is both a lint error and a value that can be stale.
  const [createdId, setCreatedId] = useState<number | null>(null);

  // Seed from what is already attached whenever a different company opens.
  // Adjusting state during render, which React supports for exactly this.
  const draftKey = draft === null ? null : (draft.id ?? 'new');
  if (draftKey !== seededFor) {
    setSeededFor(draftKey);
    setCreatedId(null);
    setSiteIds(draft?.id
      ? locations.filter(l => l.company_id === draft.id).map(l => l.id) : []);
    setDeptIds(draft?.id
      ? departments.filter(d => d.company_id === draft.id).map(d => d.id) : []);
  }

  // The same 207 countries the holiday catalog is built from, so a company's
  // country and its holiday calendar can never disagree about what 'IN' is.
  // Static list, fetched once: staleTime Infinity, no refetch.
  const { data: catalog } = useQuery({
    queryKey: ['holiday-catalog', 'countries'],
    queryFn: async () => {
      const res = await fetch('/api/holidays/catalog?countries=1');
      return res.json() as Promise<ApiResponse<{
        countries: Array<{ code: string; name: string }>;
      }>>;
    },
    staleTime: Infinity,
  });
  const countryOptions = (catalog?.data?.countries ?? [])
    .map(c => ({ value: c.code, label: `${c.name} (${c.code})` }));

  const save = useMutation({
    mutationFn: async (c: Partial<Company>) => {
      // The company row first, because a new one has no id to attach to yet.
      // On a retry, `createdId` carries the id the last attempt created, so
      // this updates that row instead of adding another.
      const saved = await postJson<{ company: Company }>('/api/org/companies', {
        ...c, id: c.id ?? createdId ?? undefined,
      });
      const id = saved?.company?.id ?? c.id;
      if (!id) throw new Error('The company was saved but came back without an id.');
      setCreatedId(id);
      // Then what belongs to it. A separate call because it writes OTHER
      // tables, with its own audit entry and its own permission.
      await postJson('/api/org/companies/links', {
        company_id: id, location_ids: siteIds, department_ids: deptIds,
      });
    },
    onSuccess: () => { setSeededFor(null); setDraft(null); onSaved(); },
    onError: (e: Error) => onError(e.message),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Your registered details. More than one is allowed &mdash; group structures and
          subsidiaries each get their own profile.
        </p>
        <Button
          data-tour="company-new"
          onClick={() => setDraft({ country_code: 'IN', fy_start_month: 4, timezone: 'Asia/Kolkata', is_active: true })}
        >
          New company
        </Button>
      </div>

      {/* THE CHAIN. Every link below already existed in the database and none
          of it was visible, so nobody could tell whether a company, its sites,
          its departments and its people were actually joined up. People are
          counted twice on purpose - through the department (the org chart) and
          through the work site (the roster). When those two disagree,
          something is wrong, and the difference is the whole point. */}
      {chain.length > 0 && (
        <div className="space-y-2">
          {chain.map(row => (
            <Card key={row.company_id} className="border-l-4 border-l-blue-500">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="font-semibold text-slate-900 dark:text-slate-100">
                  {row.legal_name}
                </p>
                {/* Where the zeros are is where the fix has to be. */}
                <button
                  type="button"
                  onClick={() => setDraft(
                    companies.find(c => c.id === row.company_id) ?? null)}
                  className="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
                >
                  Assign sites &amp; departments
                </button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <ChainStep label="work sites" value={row.sites} />
                <span className="text-slate-300 dark:text-slate-600">&rarr;</span>
                <ChainStep label="departments" value={row.departments} />
                <span className="text-slate-300 dark:text-slate-600">&rarr;</span>
                <ChainStep label="people, by department" value={row.people_by_department} />
                <ChainStep label="people, by work site" value={row.people_by_site} />
              </div>
              {row.people_by_department !== row.people_by_site && (
                <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
                  Those two numbers should match. They do not, which means somebody is
                  rostered to a site here without being placed in a department here, or
                  the other way round.
                </p>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* What is attached to nothing - the useful half of a chain nobody could
          see. A screen that only shows what IS connected cannot tell you what
          is missing, and missing is the normal state here. */}
      {gaps && (gaps.sites_without_company.length > 0
        || gaps.departments_without_company.length > 0
        || gaps.people_in_two_companies.length > 0) && (
        <Card className="border-l-4 border-l-amber-500">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Not joined up yet
          </h3>
          <ul className="mt-1.5 space-y-1 text-sm text-slate-700 dark:text-slate-300">
            {gaps.sites_without_company.length > 0 && (
              <li>
                <strong>{gaps.sites_without_company.length} work site(s)</strong> belong to
                no company: {gaps.sites_without_company.map(x => x.name).join(', ')}.
                <button
                  type="button"
                  onClick={() => setDraft(companies[0] ?? null)}
                  className="font-medium text-blue-600 underline decoration-dotted hover:decoration-solid dark:text-blue-400"
                >
                  Assign them now
                </button>
              </li>
            )}
            {gaps.departments_without_company.length > 0 && (
              <li>
                <strong>{gaps.departments_without_company.length} department(s)</strong>{' '}
                belong to no company:{' '}
                {gaps.departments_without_company.map(x => x.name).join(', ')}. Set the
                <button
                  type="button"
                  onClick={() => setDraft(companies[0] ?? null)}
                  className="font-medium text-blue-600 underline decoration-dotted hover:decoration-solid dark:text-blue-400"
                >
                  Assign them now
                </button>
              </li>
            )}
            {gaps.people_in_two_companies.length > 0 && (
              <li>
                <strong>{gaps.people_in_two_companies.length} person(s)</strong> work at a
                site belonging to one company while placed in another company&rsquo;s
                department:{' '}
                {gaps.people_in_two_companies
                  .map(x => `${x.name} (${x.site} / ${x.department})`).join(', ')}.
              </li>
            )}
          </ul>
        </Card>
      )}

      {companies.length === 0 ? (
        <Card>
          <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
            No company profile yet. Add one so statutory identifiers live somewhere
            other than a spreadsheet.
          </p>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {companies.map(c => (
            <Card key={c.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate font-semibold text-slate-900 dark:text-slate-100">
                    {c.legal_name}
                    <span className="ml-2 align-middle">
                      <RetiredMark when={!c.is_active} />
                    </span>
                  </h3>
                  {c.trading_name && <p className="text-sm text-slate-500 dark:text-slate-400">trading as {c.trading_name}</p>}
                </div>
                <button onClick={() => setDraft(c)} className="shrink-0 text-xs font-medium text-blue-600 underline decoration-dotted hover:decoration-solid dark:text-blue-400">
                  Edit
                </button>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                {([['PAN', c.pan], ['GSTIN', c.gstin], ['Registration', c.registration_no],
                   ['City', c.city], ['Financial year starts', monthName(c.fy_start_month)],
                   ['Timezone', c.timezone],
                   ['Registered at', c.registered_location_name]] as const).map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-slate-400">{k}</dt>
                    <dd className="text-slate-700 dark:text-slate-300">{v || '--'}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          ))}
        </div>
      )}

      <Drawer
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.id ? 'Edit company' : 'New company'}
        description="Registered details and statutory identifiers."
        size="lg"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDraft(null)}>Cancel</Button>
            <Button loading={save.isPending} onClick={() => save.mutate(draft!)}>Save</Button>
          </div>
        }
      >
        {draft && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Registered legal name" required className="sm:col-span-2"
              value={draft.legal_name ?? ''} onChange={e => setDraft({ ...draft, legal_name: e.target.value })} />
            <Input label="Trading name" value={draft.trading_name ?? ''}
              onChange={e => setDraft({ ...draft, trading_name: e.target.value })} />
            <Input label="Registration number" value={draft.registration_no ?? ''}
              onChange={e => setDraft({ ...draft, registration_no: e.target.value })} />
            <Input label="PAN" value={draft.pan ?? ''}
              onChange={e => setDraft({ ...draft, pan: e.target.value.toUpperCase() })}
              helper="Ten characters, like ABCDE1234F." />
            <Input label="GSTIN" value={draft.gstin ?? ''}
              onChange={e => setDraft({ ...draft, gstin: e.target.value.toUpperCase() })}
              helper="Fifteen characters, like 33ABCDE1234F1Z5." />
            {/* The registered office is CHOSEN from the sites that already exist.
                Six locations were on record with an address, a city and a
                country while this form asked for all three again - so the
                statutory address and the site it is at could disagree and
                nobody would find out. The statutory columns stay editable,
                because a filing uses what was filed; what goes away is having
                to type it from memory. */}
            <div className="flex flex-col gap-1 sm:col-span-2">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Registered office
              </label>
              <select
                value={draft.registered_location_id ?? ''}
                onChange={e => setDraft({
                  ...draft,
                  registered_location_id: e.target.value ? Number(e.target.value) : null,
                })}
                className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
              >
                <option value="">Not linked to a work site</option>
                {locations.map(l => (
                  <option key={l.id} value={l.id}>
                    {l.name}{l.city ? ` - ${l.city}` : ''}
                    {l.company_id && l.company_id !== draft.id ? ' (another company)' : ''}
                  </option>
                ))}
              </select>
              {(() => {
                const site = locations.find(l => l.id === draft.registered_location_id);
                if (!site) {
                  return (
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      Link the site this company is registered at, and its address can be
                      copied in rather than typed. Work sites live under People.
                    </span>
                  );
                }
                const differs = (site.city ?? '') !== (draft.city ?? '')
                  || (site.country_code ?? '') !== (draft.country_code ?? '');
                return (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      {site.address ?? 'That site has no address recorded.'}
                    </span>
                    {differs && (site.city || site.country_code) && (
                      <button
                        type="button"
                        onClick={() => setDraft({
                          ...draft,
                          city: site.city ?? draft.city,
                          country_code: site.country_code ?? draft.country_code,
                        })}
                        className="text-xs font-medium text-blue-600 underline decoration-dotted hover:decoration-solid dark:text-blue-400"
                      >
                        Use this site&rsquo;s city and country
                      </button>
                    )}
                  </div>
                );
              })()}
            </div>
            <Input label="City" value={draft.city ?? ''} onChange={e => setDraft({ ...draft, city: e.target.value })} />
            <Select label="Country" value={draft.country_code ?? 'IN'}
              onChange={v => setDraft({ ...draft, country_code: v })}
              options={withCurrent(countryOptions, draft.country_code)}
              helper={countryOptions.length === 0
                ? 'Loading the country list...'
                : 'Sets the holiday calendar this company is measured against.'} />
            <Input label="Email" type="email" value={draft.email ?? ''}
              onChange={e => setDraft({ ...draft, email: e.target.value })} />
            <Input label="Phone" value={draft.phone ?? ''} onChange={e => setDraft({ ...draft, phone: e.target.value })} />
            {/* A month, not a number between 1 and 12 that a reader has to
                count out. A number field also accepts 0, 13 and 4.5. */}
            <Select label="Financial year starts" value={draft.fy_start_month ?? 4}
              onChange={v => setDraft({ ...draft, fy_start_month: Number(v) })}
              options={MONTH_OPTIONS}
              helper="April is the Indian financial year." />
            <Select label="Timezone" value={draft.timezone ?? 'Asia/Kolkata'}
              onChange={v => setDraft({ ...draft, timezone: v })}
              options={withCurrent(timezoneOptions(), draft.timezone)}
              helper="Used when a local working day is shown for this company." />

            <div className="border-t border-slate-200 pt-4 dark:border-slate-700">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Branches
              </h3>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                Every work site that belongs to this company &mdash; tick as many as
                apply. The head office is the single site chosen above as the
                registered office; this is the rest of them.
              </p>
              <div className="mt-2">
                <MultiSelectList
                  options={locations.map(l => ({
                    id: l.id,
                    label: l.name,
                    hint: l.city,
                    takenBy: l.company_id !== null && l.company_id !== draft.id
                      ? 'another company' : null,
                  }))}
                  selected={siteIds}
                  onChange={setSiteIds}
                  emptyMessage="No work sites yet. Add them under People, Work sites."
                />
              </div>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Departments
              </h3>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                The parts of the organisation that belong to this company.
              </p>
              <div className="mt-2">
                <MultiSelectList
                  options={departments.map(d => ({
                    id: d.id,
                    label: `${'\u2014'.repeat(d.depth)} ${d.name}`.trim(),
                    hint: d.code,
                    takenBy: d.company_id !== null && d.company_id !== draft.id
                      ? 'another company' : null,
                  }))}
                  selected={deptIds}
                  onChange={setDeptIds}
                  emptyMessage="No departments yet. Add them on the Structure tab."
                />
              </div>
            </div>

            <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              <p>
                <strong>People follow from these.</strong> Somebody counts towards this
                company once they are placed in one of its departments, or rostered at
                one of its sites &mdash; there is no third list of people to keep in
                step, which is why there is no list of people here.
              </p>
              <button
                type="button"
                onClick={() => { setDraft(null); onPlacePeople(); }}
                className="mt-1.5 font-medium text-blue-600 underline decoration-dotted hover:decoration-solid dark:text-blue-400"
              >
                Place people in a department now
              </button>
            </div>
            {draft.id && (
              <ActiveSwitch
                value={draft.is_active !== false}
                onChange={v => setDraft({ ...draft, is_active: v })}
                noun="company"
              />
            )}
          </div>
        )}
      </Drawer>


    </div>
  );
}

/**
 * The IANA timezone list, taken from the runtime's own copy.
 *
 * Typed, this field invites 'IST', 'GMT+5:30' and 'india' - none of which
 * MySQL, date-fns or the mobile app can read, and all of which look
 * perfectly reasonable to the person typing them. The browser already ships
 * the canonical list, so there is nothing here to hardcode and nothing to
 * update when a zone is renamed.
 */
let timezoneCache: Array<{ value: string; label: string }> | null = null;
function timezoneOptions(): Array<{ value: string; label: string }> {
  if (timezoneCache) return timezoneCache;
  const supported = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  // A runtime without supportedValuesOf gets the two zones this deployment
  // actually uses rather than a broken picker. The stored value is shown
  // either way - see withCurrent - so nothing is silently rewritten.
  const zones = typeof supported === 'function'
    ? supported.call(Intl, 'timeZone')
    : ['Asia/Kolkata', 'UTC'];
  timezoneCache = zones.map(z => ({ value: z, label: `${z} (${utcOffsetOf(z)})` }));
  return timezoneCache;
}

/** 'GMT+05:30', so a reader can tell Asia/Kolkata from Asia/Katmandu. */
function utcOffsetOf(zone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(new Date())
      .find(part => part.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

/**
 * Keep whatever is already stored selectable, even if it is not in the list.
 *
 * A select whose value is absent from its options renders the FIRST option
 * instead, and the next save writes that - so turning a text field into a
 * dropdown is exactly how a stored value gets quietly replaced by Afghanistan.
 * An unrecognised value is surfaced as unrecognised and left alone.
 */
function withCurrent(
  options: Array<{ value: string | number; label: string }>,
  current: string | number | null | undefined,
): Array<{ value: string | number; label: string }> {
  if (current === null || current === undefined || current === '') return options;
  if (options.some(o => String(o.value) === String(current))) return options;
  // An empty list is a list still loading, not a verdict on the value: calling
  // a perfectly good country code unrecognised for the first half-second is
  // how a form loses somebody's trust.
  if (options.length === 0) return [{ value: current, label: String(current) }];
  return [{ value: current, label: `${current} (not recognised)` }, ...options];
}

const MONTH_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  .map(m => ({ value: m, label: monthName(m) }));
function monthName(m: number): string {
  return ['', 'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'][m] ?? '--';
}

/** One hop of the chain: a number and what it counts. */
function ChainStep({ label, value }: { label: string; value: number }) {
  return (
    <span className="rounded-lg bg-slate-100 px-2 py-1 dark:bg-slate-800">
      <strong className="tabular-nums text-slate-900 dark:text-slate-100">{value}</strong>
      {' '}
      <span className="text-xs text-slate-500 dark:text-slate-400">{label}</span>
    </span>
  );
}

/** A labelled select, so every picker on this page looks and behaves alike. */
function Select({
  label, value, onChange, options, helper,
}: {
  label: string;
  value: string | number;
  onChange: (v: string) => void;
  options: Array<{ value: string | number; label: string }>;
  helper?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium text-slate-700 dark:text-slate-300">{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
      >
        {options.map(o => <option key={String(o.value)} value={o.value}>{o.label}</option>)}
      </select>
      {helper && <span className="text-xs text-slate-500 dark:text-slate-400">{helper}</span>}
    </label>
  );
}

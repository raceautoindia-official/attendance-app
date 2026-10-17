'use client';

/**
 * /onboarding — who is joining, who is leaving, and what is outstanding.
 *
 * The attention queue leads the page and the board follows. That order is the
 * whole design: a board of checklists tells you what exists, a queue tells you
 * what to do this morning, and only one of those is worth opening a page for.
 *
 * The queue is deliberately narrow — overdue tasks, people arriving or leaving
 * within thirty days, probation dates, expiring documents. A queue that lists
 * everything outstanding is a queue nobody reads, and the items that matter
 * become indistinguishable from the ones that do not.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Badge from '@/components/ui/Badge';
import Spinner from '@/components/ui/Spinner';
import Drawer from '@/components/ui/Drawer';
import FilterBar from '@/components/ui/FilterBar';
import type { ApiResponse, Employee } from '@/lib/types';

type Direction = 'onboarding' | 'offboarding';
type TaskStatus = 'pending' | 'done' | 'not_applicable';

interface JourneyTask {
  id: number; title: string; description: string | null; owner_role: string;
  category: string; due_on: string | null; is_blocking: boolean;
  status: TaskStatus; completed_by_name: string | null; notes: string | null;
  overdue: boolean;
}
interface Journey {
  id: number; employee_id: number; employee_name: string; emp_id: string;
  direction: Direction; anchor_date: string;
  status: 'in_progress' | 'completed' | 'cancelled';
  template_name: string | null; tasks: JourneyTask[];
  total: number; done: number; blocking_outstanding: number; overdue: number;
}
interface Queue {
  overdue: Array<{ journey_id: number; employee_name: string; emp_id: string;
                   direction: Direction; title: string; due_on: string; owner_role: string }>;
  starting_soon: Array<{ employee_name: string; emp_id: string; anchor_date: string; direction: Direction }>;
  probation_due: Array<{ id: number; name: string; emp_id: string; probation_ends_on: string }>;
  documents_expiring: Array<{ employee_name: string; title: string; expires_on: string }>;
}
interface Template { id: number; name: string; direction: Direction; is_default: boolean }

const OWNER_LABEL: Record<string, string> = {
  hr: 'HR', manager: 'Manager', it: 'IT', employee: 'Them', finance: 'Finance',
};

const today = () => new Date().toISOString().slice(0, 10);

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json: ApiResponse<T> = await res.json();
  if (!json.success) throw new Error(json.error ?? 'Could not load');
  return json.data as T;
}
async function send(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json: ApiResponse = await res.json();
  if (!json.success) throw new Error(json.error ?? 'Could not save');
}

export default function OnboardingPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState<Journey | null>(null);
  const [starting, setStarting] = useState<Direction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['onboarding', 'board'],
    queryFn: () => getJson<{ journeys: Journey[]; queue: Queue | null; templates: Template[] }>(
      '/api/onboarding/journeys?with_queue=1&with_templates=1'),
  });
  const { data: employees } = useQuery({
    queryKey: ['employees', 'for-onboarding'],
    queryFn: () => getJson<{ employees: Employee[] }>('/api/employees?limit=300').then(d => d.employees),
  });

  const journeys = data?.journeys ?? [];
  const queue = data?.queue;
  const templates = data?.templates ?? [];
  // Filtered here because the whole board is already loaded. The counts
  // in FilterBar report against the unfiltered total, so a narrowed list
  // cannot be mistaken for an empty one.
  const [search, setSearch] = useState('');
  const [dirFilter, setDirFilter] = useState('');
  const matches = (j: Journey) => {
    if (dirFilter && j.direction !== dirFilter) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return j.employee_name.toLowerCase().includes(q)
      || j.emp_id.toLowerCase().includes(q);
  };
  const allLive = journeys.filter(j => j.status === 'in_progress');
  const live = allLive.filter(matches);
  const closed = journeys.filter(j => j.status !== 'in_progress');

  const after = (m: string) => { setError(null); setNotice(m); qc.invalidateQueries({ queryKey: ['onboarding'] }); };

  const tick = useMutation({
    mutationFn: (b: { task_id: number; status: TaskStatus }) => send('/api/onboarding/tasks', b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['onboarding'] }),
    onError: (e: Error) => setError(e.message),
  });
  const act = useMutation({
    mutationFn: (b: Record<string, unknown>) => send('/api/onboarding/journeys', b),
    onSuccess: () => { setOpen(null); setStarting(null); after('Checklist updated.'); },
    onError: (e: Error) => setError(e.message),
  });

  // Re-read from the refreshed list so the drawer shows the tick immediately
  // rather than the snapshot it was opened with.
  const openJourney = open ? journeys.find(j => j.id === open.id) ?? open : null;

  const queueCount = (queue?.overdue.length ?? 0) + (queue?.starting_soon.length ?? 0)
    + (queue?.probation_due.length ?? 0) + (queue?.documents_expiring.length ?? 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Joining &amp; Leaving</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            What has to happen before somebody starts, and before they go.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => { setError(null); setStarting('onboarding'); }}>Start a joiner</Button>
          <Button variant="secondary" onClick={() => { setError(null); setStarting('offboarding'); }}>
            Start a leaver
          </Button>
        </div>
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

      {/* The queue, first. */}
      {queue && queueCount > 0 && (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-200">
            Needs attention
          </h2>
          <div className="space-y-3">
            {queue.overdue.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
                  Overdue ({queue.overdue.length})
                </p>
                <div className="space-y-1">
                  {queue.overdue.slice(0, 8).map((o, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        const j = journeys.find(x => x.id === o.journey_id);
                        if (j) setOpen(j);
                      }}
                      className="flex w-full flex-wrap items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      <span className="font-medium text-slate-800 dark:text-slate-200">{o.employee_name}</span>
                      <span className="text-slate-600 dark:text-slate-300">{o.title}</span>
                      <Badge variant="neutral">{OWNER_LABEL[o.owner_role] ?? o.owner_role}</Badge>
                      <span className="ml-auto text-xs tabular-nums text-amber-700 dark:text-amber-400">
                        due {o.due_on}
                      </span>
                    </button>
                  ))}
                  {queue.overdue.length > 8 && (
                    <p className="px-2 text-xs text-slate-400">and {queue.overdue.length - 8} more</p>
                  )}
                </div>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-3">
              <QueueBlock
                title="Arriving or leaving soon"
                items={queue.starting_soon.map(s =>
                  `${s.employee_name} — ${s.direction === 'onboarding' ? 'joins' : 'leaves'} ${s.anchor_date}`)}
              />
              <QueueBlock
                title="Probation ending"
                items={queue.probation_due.map(p => `${p.name} — ${p.probation_ends_on}`)}
                empty="Nothing in the next 30 days"
              />
              <QueueBlock
                title="Documents expiring"
                items={queue.documents_expiring.map(d => `${d.employee_name} — ${d.title} (${d.expires_on})`)}
                empty="Nothing expiring"
              />
            </div>
          </div>
        </Card>
      )}

      {allLive.length > 0 && (
        <FilterBar
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Name or employee ID…"
          filters={[{ key: 'direction', label: 'Direction', options: [
            { value: 'onboarding', label: 'Joining' },
            { value: 'offboarding', label: 'Leaving' },
          ] }]}
          values={{ direction: dirFilter }}
          onChange={(_k, v) => setDirFilter(v)}
          onClear={() => { setSearch(''); setDirFilter(''); }}
          showing={{ shown: live.length, total: allLive.length, noun: 'in progress' }}
        />
      )}

      {isLoading ? (
        <Card><div className="flex justify-center py-10"><Spinner /></div></Card>
      ) : live.length === 0 ? (
        <Card>
          <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
            {allLive.length > 0
              ? 'Nobody matches those filters.'
              : 'Nothing in progress. Start a checklist when somebody joins or hands in their notice.'}
          </p>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {live.map(j => <JourneyCard key={j.id} j={j} onOpen={() => setOpen(j)} />)}
        </div>
      )}

      {closed.length > 0 && (
        <div>
          <button
            onClick={() => setShowClosed(v => !v)}
            className="text-xs font-medium text-blue-600 underline decoration-dotted hover:decoration-solid dark:text-blue-400"
          >
            {showClosed ? 'Hide' : 'Show'} {closed.length} finished checklist{closed.length === 1 ? '' : 's'}
          </button>
          {showClosed && (
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {closed.map(j => <JourneyCard key={j.id} j={j} onOpen={() => setOpen(j)} />)}
            </div>
          )}
        </div>
      )}

      {/* ---- the checklist itself ---- */}
      <Drawer
        open={openJourney !== null}
        onClose={() => setOpen(null)}
        title={openJourney ? `${openJourney.employee_name}` : ''}
        description={openJourney
          ? `${openJourney.direction === 'onboarding' ? 'Joining' : 'Leaving'} ${openJourney.anchor_date}`
          + ` — ${openJourney.done} of ${openJourney.total} done`
          : ''}
        size="lg"
        footer={openJourney?.status === 'in_progress' ? (
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="secondary"
              onClick={() => act.mutate({ action: 'cancel', journey_id: openJourney.id })}
            >
              Cancel checklist
            </Button>
            <Button
              loading={act.isPending}
              onClick={() => act.mutate({
                action: 'complete', journey_id: openJourney.id,
                // Only after the server has already refused once and the
                // administrator has seen which tasks are open.
                force: openJourney.blocking_outstanding > 0 && error !== null,
              })}
            >
              {openJourney.blocking_outstanding > 0 && error !== null
                ? 'Finish anyway'
                : 'Mark finished'}
            </Button>
          </div>
        ) : undefined}
      >
        {openJourney && (
          <div className="space-y-2">
            {openJourney.blocking_outstanding > 0 && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
                {openJourney.blocking_outstanding} required task
                {openJourney.blocking_outstanding === 1 ? '' : 's'} still open. These are the ones
                where carrying on without them causes real harm.
              </p>
            )}
            {openJourney.tasks.map(t => (
              <div
                key={t.id}
                className={`flex items-start gap-3 rounded-lg border px-3 py-2 ${
                  t.overdue
                    ? 'border-amber-200 bg-amber-50/50 dark:border-amber-900/50 dark:bg-amber-950/20'
                    : 'border-slate-200 dark:border-slate-700'
                }`}
              >
                <input
                  type="checkbox"
                  checked={t.status === 'done'}
                  disabled={openJourney.status !== 'in_progress'}
                  onChange={e => tick.mutate({
                    task_id: t.id, status: e.target.checked ? 'done' : 'pending',
                  })}
                  className="mt-1 h-4 w-4 shrink-0 rounded border-slate-300"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-sm ${
                      t.status === 'done' ? 'text-slate-400 line-through'
                        : t.status === 'not_applicable' ? 'text-slate-400 italic'
                        : 'text-slate-800 dark:text-slate-200'
                    }`}>
                      {t.title}
                    </span>
                    {t.is_blocking && t.status === 'pending' && <Badge variant="warning">required</Badge>}
                    <Badge variant="neutral">{OWNER_LABEL[t.owner_role] ?? t.owner_role}</Badge>
                  </div>
                  {t.description && (
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{t.description}</p>
                  )}
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                    {t.due_on && (
                      <span className={t.overdue ? 'font-medium text-amber-700 dark:text-amber-400' : ''}>
                        due {t.due_on}{t.overdue ? ' — overdue' : ''}
                      </span>
                    )}
                    {t.completed_by_name && <span>done by {t.completed_by_name}</span>}
                  </div>
                </div>
                {openJourney.status === 'in_progress' && t.status !== 'done' && (
                  <button
                    onClick={() => tick.mutate({
                      task_id: t.id,
                      status: t.status === 'not_applicable' ? 'pending' : 'not_applicable',
                    })}
                    className="shrink-0 self-center text-[11px] text-slate-400 underline decoration-dotted hover:text-slate-600 dark:hover:text-slate-300"
                  >
                    {t.status === 'not_applicable' ? 'needed after all' : 'not needed'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </Drawer>

      {/* ---- starting one ---- */}
      <StartDrawer
        direction={starting}
        onClose={() => setStarting(null)}
        employees={employees ?? []}
        templates={templates}
        pending={act.isPending}
        onSubmit={b => act.mutate({ action: 'start', ...b })}
      />
    </div>
  );
}

function QueueBlock({ title, items, empty }: { title: string; items: string[]; empty?: string }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {title}
      </p>
      {items.length === 0 ? (
        <p className="text-xs text-slate-400">{empty ?? 'Nothing'}</p>
      ) : (
        <ul className="space-y-0.5">
          {items.slice(0, 5).map((t, i) => (
            <li key={i} className="text-xs text-slate-700 dark:text-slate-300">{t}</li>
          ))}
          {items.length > 5 && <li className="text-xs text-slate-400">and {items.length - 5} more</li>}
        </ul>
      )}
    </div>
  );
}

function JourneyCard({ j, onOpen }: { j: Journey; onOpen: () => void }) {
  const pct = j.total === 0 ? 0 : Math.round((j.done / j.total) * 100);
  return (
    <Card>
      <button onClick={onOpen} className="w-full text-left">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate font-semibold text-slate-900 dark:text-slate-100">{j.employee_name}</h3>
            <p className="text-xs text-slate-400">
              {j.emp_id} · {j.direction === 'onboarding' ? 'joins' : 'leaves'} {j.anchor_date}
            </p>
          </div>
          <Badge variant={j.direction === 'onboarding' ? 'success' : 'warning'}>
            {j.direction === 'onboarding' ? 'Joining' : 'Leaving'}
          </Badge>
        </div>

        <div className="mt-3">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
            <div
              className={`h-full rounded-full ${j.overdue > 0 ? 'bg-amber-500' : 'bg-emerald-500'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
            <span className="tabular-nums text-slate-600 dark:text-slate-300">
              {j.done} of {j.total}
            </span>
            {j.blocking_outstanding > 0 && (
              <span className="text-amber-700 dark:text-amber-400">
                {j.blocking_outstanding} required outstanding
              </span>
            )}
            {j.overdue > 0 && (
              <span className="font-medium text-amber-700 dark:text-amber-400">{j.overdue} overdue</span>
            )}
            {j.status !== 'in_progress' && <Badge variant="neutral">{j.status}</Badge>}
          </div>
        </div>
      </button>
    </Card>
  );
}

function StartDrawer({
  direction, onClose, employees, templates, pending, onSubmit,
}: {
  direction: Direction | null;
  onClose: () => void;
  employees: Employee[];
  templates: Template[];
  pending: boolean;
  onSubmit: (b: Record<string, unknown>) => void;
}) {
  const [employeeId, setEmployeeId] = useState('');
  const [anchor, setAnchor] = useState(today());
  const [templateId, setTemplateId] = useState('');

  const forDirection = templates.filter(t => t.direction === direction);
  const joining = direction === 'onboarding';

  return (
    <Drawer
      open={direction !== null}
      onClose={onClose}
      title={joining ? 'Start a joiner' : 'Start a leaver'}
      description={joining
        ? 'Every task is dated from their joining date, including the ones due before it.'
        : 'Every task is dated from their last working day, including the ones due before it.'}
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            loading={pending}
            disabled={!employeeId}
            onClick={() => onSubmit({
              employee_id: Number(employeeId),
              direction,
              anchor_date: anchor,
              template_id: templateId ? Number(templateId) : null,
            })}
          >
            Start checklist
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Who</span>
          <select
            value={employeeId}
            onChange={e => setEmployeeId(e.target.value)}
            className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="">Choose someone&hellip;</option>
            {employees.map(e => <option key={e.id} value={e.id}>{e.name} ({e.emp_id})</option>)}
          </select>
        </label>

        <Input
          label={joining ? 'Joining date' : 'Last working day'}
          type="date" required value={anchor}
          onChange={e => setAnchor(e.target.value)}
          helper={joining
            ? 'A date in the future is normal: preparation tasks are dated before it.'
            : 'Tasks like handover and the exit interview are dated before this.'}
        />

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Checklist</span>
          <select
            value={templateId}
            onChange={e => setTemplateId(e.target.value)}
            className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="">Use the default</option>
            {forDirection.map(t => (
              <option key={t.id} value={t.id}>{t.name}{t.is_default ? ' (default)' : ''}</option>
            ))}
          </select>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            The tasks are copied now, so editing the template later will not change this list.
          </span>
        </label>
      </div>
    </Drawer>
  );
}

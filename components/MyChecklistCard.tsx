'use client';

/**
 * components/MyChecklistCard.tsx — your own joining or leaving checklist.
 *
 * A checklist only HR can see is a checklist HR chases by email. Several of
 * these tasks are genuinely the employee's own — install the app, give an
 * emergency contact, acknowledge the policies — and routing those through
 * somebody else turns a five-minute job into a fortnight of reminders.
 *
 * Two things it is careful about:
 *
 *   It shows EVERYTHING on their list, including the tasks HR or IT own, so
 *   the person can see where things stand. But only their own tasks are
 *   tickable, and the rest say who is responsible instead of appearing broken
 *   when clicking does nothing. The server enforces this independently; this
 *   is the explanation, not the control.
 *
 *   It renders nothing at all when there is no checklist. An empty card
 *   saying "no tasks" on the dashboard of somebody who joined four years ago
 *   is clutter that teaches people to ignore that part of the screen.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import type { ApiResponse } from '@/lib/types';

type TaskStatus = 'pending' | 'done' | 'not_applicable';

interface Task {
  id: number; title: string; description: string | null;
  owner_role: string; due_on: string | null; is_blocking: boolean;
  status: TaskStatus; overdue: boolean;
}
interface Journey {
  id: number; direction: 'onboarding' | 'offboarding'; anchor_date: string;
  status: 'in_progress' | 'completed' | 'cancelled';
  tasks: Task[]; total: number; done: number; overdue: number;
}

const OWNER_LABEL: Record<string, string> = {
  hr: 'HR', manager: 'your manager', it: 'IT', finance: 'Finance', employee: 'you',
};

export default function MyChecklistCard() {
  const qc = useQueryClient();

  const { data } = useQuery({
    queryKey: ['my-checklist'],
    queryFn: async () => {
      const res = await fetch('/api/onboarding/journeys?mine=1');
      const json: ApiResponse<{ journeys: Journey[] }> = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Could not load');
      return json.data?.journeys ?? [];
    },
  });

  const tick = useMutation({
    mutationFn: async (v: { task_id: number; status: TaskStatus }) => {
      const res = await fetch('/api/onboarding/tasks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(v),
      });
      const json: ApiResponse = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Could not update');
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-checklist'] }),
  });

  const live = (data ?? []).filter(j => j.status === 'in_progress');
  // Nothing in progress means nothing to say. See the file comment.
  if (live.length === 0) return null;

  return (
    <>
      {live.map(j => {
        const mine = j.tasks.filter(t => t.owner_role === 'employee');
        const others = j.tasks.filter(t => t.owner_role !== 'employee');
        const myOutstanding = mine.filter(t => t.status === 'pending').length;

        return (
          <Card key={j.id}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                  {j.direction === 'onboarding' ? 'Getting you set up' : 'Before you leave'}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {myOutstanding === 0
                    ? 'Nothing left for you to do. The rest is with other people.'
                    : `${myOutstanding} thing${myOutstanding === 1 ? '' : 's'} for you to do.`}
                </p>
              </div>
              <Badge variant={j.overdue > 0 ? 'warning' : 'info'}>
                {j.done} of {j.total} done
              </Badge>
            </div>

            {mine.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {mine.map(t => (
                  <label
                    key={t.id}
                    className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 ${
                      t.overdue
                        ? 'border-amber-200 bg-amber-50/60 dark:border-amber-900/50 dark:bg-amber-950/20'
                        : 'border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={t.status === 'done'}
                      disabled={tick.isPending}
                      onChange={e => tick.mutate({
                        task_id: t.id, status: e.target.checked ? 'done' : 'pending',
                      })}
                      className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300"
                    />
                    <span className="min-w-0">
                      <span className={`block text-sm ${
                        t.status === 'done'
                          ? 'text-slate-400 line-through'
                          : 'text-slate-800 dark:text-slate-200'
                      }`}>
                        {t.title}
                      </span>
                      {t.description && (
                        <span className="block text-xs text-slate-500 dark:text-slate-400">
                          {t.description}
                        </span>
                      )}
                      {t.due_on && t.status === 'pending' && (
                        <span className={`block text-[11px] ${
                          t.overdue
                            ? 'font-medium text-amber-700 dark:text-amber-400'
                            : 'text-slate-400'
                        }`}>
                          by {t.due_on}{t.overdue ? ' — overdue' : ''}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            )}

            {others.length > 0 && (
              <details className="group mt-3">
                <summary className="cursor-pointer list-none text-xs text-slate-500 marker:content-[''] hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">
                  <span className="inline-block transition-transform group-open:rotate-90">&rsaquo;</span>
                  {' '}{others.filter(t => t.status === 'pending').length} with other people
                </summary>
                <ul className="mt-1.5 space-y-1">
                  {others.map(t => (
                    <li key={t.id} className="flex items-center gap-2 text-xs">
                      <span className={t.status === 'done'
                        ? 'text-slate-400 line-through'
                        : 'text-slate-600 dark:text-slate-300'}>
                        {t.title}
                      </span>
                      {/* Says who, rather than being an inert checkbox that
                          looks broken when clicking it does nothing. */}
                      <span className="text-slate-400">
                        {t.status === 'done' ? 'done' : `with ${OWNER_LABEL[t.owner_role] ?? t.owner_role}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {tick.isError && (
              <p className="mt-2 text-xs text-red-600 dark:text-red-400">
                {(tick.error as Error).message}
              </p>
            )}
          </Card>
        );
      })}
    </>
  );
}

'use client';

/**
 * /inbox — one queue for everything waiting on a decision.
 *
 * It replaces four destinations: Notifications, the Permissions queue,
 * Regularisations and Month Review. Those pages all still exist and still own
 * their decisions; what they could not do is tell you they had anything in
 * them. Two of them were not even in the menu.
 *
 * The column that justifies the page is WAITING. Nothing in this app showed
 * how long a request had sat unanswered, so the honest answer to "is anything
 * overdue?" was to open four pages and read the dates.
 *
 * Nothing is decided here on purpose - see lib/inbox.ts. Each row opens the
 * page that owns the rule.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Spinner from '@/components/ui/Spinner';
import Avatar from '@/components/ui/Avatar';
import type { ApiResponse } from '@/lib/types';

type Severity = 'critical' | 'warning' | 'info';
type Kind =
  | 'alert' | 'permission_request' | 'on_duty_request' | 'regularisation'
  | 'off_site_review' | 'month_exception';

interface Item {
  id: string;
  kind: Kind;
  severity: Severity;
  employee: { id: number; name: string; emp_id: string } | null;
  title: string;
  detail: string;
  action: string;
  href: string;
  alert_id?: number;
  waiting_since: string | null;
  waiting_days: number | null;
}

interface Summary {
  items: Item[];
  counts: {
    total: number; decisions: number; reviews: number;
    by_kind: Record<Kind, number>;
  };
  oldest_days: number | null;
  clear: boolean;
  scope_note: string | null;
  review_month: string;
}

const KIND_LABEL: Record<Kind, string> = {
  alert: 'Alert',
  permission_request: 'Time off',
  on_duty_request: 'On duty',
  regularisation: 'Correction',
  off_site_review: 'Off-site',
  month_exception: 'Month review',
};

const BORDER: Record<Severity, string> = {
  critical: 'border-l-red-500',
  warning: 'border-l-amber-500',
  info: 'border-l-slate-300 dark:border-l-slate-600',
};

/** How long it has been sitting, said the way a person would say it. */
function waited(days: number | null): { text: string; tone: string } {
  if (days === null) return { text: '--', tone: 'text-slate-400' };
  if (days === 0) return { text: 'today', tone: 'text-slate-500 dark:text-slate-400' };
  if (days === 1) return { text: '1 day', tone: 'text-amber-600 dark:text-amber-400' };
  return {
    text: `${days} days`,
    tone: days >= 3
      ? 'text-red-600 dark:text-red-400 font-semibold'
      : 'text-amber-600 dark:text-amber-400',
  };
}

interface AlertRule {
  rule_key: string; label: string; description: string;
  family: 'live' | 'pattern' | 'lifecycle';
  is_enabled: number; open_count: number;
}

/**
 * The alert rules, on and off, where their alerts land.
 *
 * The API could switch a rule off from the day it shipped and nothing ever
 * called it - so seven rules existed and a noisy one could not be stopped
 * except by editing the database. A rule nobody can turn off is a rule that
 * eventually gets the whole queue ignored.
 *
 * Folded away by default: this is a setting, and the queue is the job.
 */
function RuleSettings({ rules, canManage, onChanged }: {
  rules: AlertRule[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ran, setRan] = useState<string | null>(null);

  const toggle = useMutation({
    mutationFn: async (vars: { rule_key: string; enabled: boolean }) => {
      const res = await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_rule', ...vars }),
      });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Could not change the rule');
      return json;
    },
    onSuccess: () => { setError(null); onChanged(); },
    onError: (e: Error) => setError(e.message),
  });

  /**
   * Evaluate now rather than waiting for the scheduler.
   *
   * Somebody who has just switched a rule on, or set a threshold on a policy,
   * looks at this queue to see whether it caught anything - and the queue only
   * changes when the background job next runs, which is up to an hour. The API
   * could do this from the day it shipped; nothing asked it to.
   */
  const runNow = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'run' }),
      });
      const json = await res.json() as ApiResponse<{
        ran: string[]; skipped: string[];
        opened: number; updated: number; resolved: number;
      }>;
      if (!json.success) throw new Error(json.error ?? 'Could not check now');
      return json.data!;
    },
    onSuccess: d => {
      setError(null);
      setRan(d.opened === 0 && d.resolved === 0
        ? `Checked ${d.ran.length} rule${d.ran.length === 1 ? '' : 's'} - nothing new.`
        : `${d.opened} new, ${d.updated} updated, ${d.resolved} cleared.`);
      onChanged();
    },
    onError: (e: Error) => { setRan(null); setError(e.message); },
  });

  if (rules.length === 0) return null;
  const on = rules.filter(r => r.is_enabled).length;

  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span>
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Alert rules
          </span>
          <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
            {on} of {rules.length} switched on
          </span>
        </span>
        <span className="text-xs font-medium text-blue-600 dark:text-blue-400">
          {open ? 'Hide' : 'Change which alerts appear'}
        </span>
      </button>

      {ran && (
        <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">{ran}</p>
      )}

      {open && (
        <div className="mt-3 space-y-2">
          {rules.map(rule => (
            <div
              key={rule.rule_key}
              className="flex items-start justify-between gap-3 border-b border-slate-100 pb-2 last:border-0 dark:border-slate-800"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
                  {rule.label}
                  {rule.open_count > 0 && (
                    <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                      {rule.open_count} open
                    </span>
                  )}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">{rule.description}</p>
              </div>
              {canManage ? (
                <label className="flex shrink-0 items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={Boolean(rule.is_enabled)}
                    disabled={toggle.isPending}
                    onChange={e => toggle.mutate({
                      rule_key: rule.rule_key, enabled: e.target.checked,
                    })}
                  />
                  {rule.is_enabled ? 'On' : 'Off'}
                </label>
              ) : (
                <span className="shrink-0 text-xs text-slate-400">
                  {rule.is_enabled ? 'On' : 'Off'}
                </span>
              )}
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Switching one off resolves whatever it has open, so the queue does not
              keep rows nobody can act on. The thresholds themselves live on each
              policy.
            </p>
            {canManage && (
              <button
                type="button"
                disabled={runNow.isPending}
                onClick={() => runNow.mutate()}
                className="shrink-0 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                {runNow.isPending ? 'Checking\u2026' : 'Check now'}
              </button>
            )}
          </div>
          {error && (
            <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
          )}
        </div>
      )}
    </Card>
  );
}

export default function InboxPage() {
  const qc = useQueryClient();
  const [kind, setKind] = useState<Kind | 'all'>('all');
  // Which alert is having a note written for it. One at a time, because
  // acknowledging is a considered act and a page of open note fields invites
  // clearing the lot without reading them.
  const [noting, setNoting] = useState<number | null>(null);
  const [note, setNote] = useState('');

  const clear = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Could not update the alert');
      return json;
    },
    onSuccess: () => {
      setNoting(null);
      setNote('');
      qc.invalidateQueries({ queryKey: ['inbox'] });
      qc.invalidateQueries({ queryKey: ['alerts'] });
    },
  });

  const { data: alertsData } = useQuery({
    queryKey: ['alerts', 'rules'],
    queryFn: async () => {
      const res = await fetch('/api/alerts');
      const json = await res.json() as ApiResponse<{
        rules: AlertRule[]; can_manage: boolean;
      }>;
      // A manager without alerts.view gets a 403, which is not an error
      // here - it only means they do not see the settings.
      return json.success ? json.data : null;
    },
    retry: false,
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ['inbox'],
    queryFn: async () => {
      const res = await fetch('/api/inbox');
      const json: ApiResponse<Summary> = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Could not load the inbox');
      return json.data!;
    },
    // Somebody may be waiting on the other side of this queue.
    refetchInterval: 60_000,
  });

  const items = (data?.items ?? []).filter(i => kind === 'all' || i.kind === kind);
  const kinds = (Object.keys(KIND_LABEL) as Kind[])
    .filter(k => (data?.counts.by_kind[k] ?? 0) > 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Inbox</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Everything waiting on a decision, oldest first.
            {data?.scope_note && <> {data.scope_note}</>}
          </p>
        </div>
        {data && !data.clear && data.oldest_days !== null && data.oldest_days >= 2 && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">
            The oldest has been waiting <strong>{data.oldest_days} days</strong>.
          </p>
        )}
      </div>

      <RuleSettings
        rules={alertsData?.rules ?? []}
        canManage={Boolean(alertsData?.can_manage)}
        onChanged={() => {
          qc.invalidateQueries({ queryKey: ['alerts'] });
          qc.invalidateQueries({ queryKey: ['inbox'] });
        }}
      />

      {isLoading && <Card><div className="flex justify-center py-10"><Spinner /></div></Card>}
      {error && (
        <Card>
          <p className="py-6 text-center text-sm text-red-600 dark:text-red-400">
            {(error as Error).message}
          </p>
        </Card>
      )}

      {data?.clear && (
        <Card>
          <p className="py-8 text-center text-sm text-emerald-700 dark:text-emerald-400">
            Nothing is waiting. Every request has been answered, every off-site
            clock-in reviewed, and last month holds nothing that needs fixing.
          </p>
        </Card>
      )}

      {data && !data.clear && (
        <>
          {/* Counts that double as filters. The queue is usually cleared one
              kind at a time, because each kind is decided on a different page. */}
          <div className="flex flex-wrap gap-2">
            <FilterChip
              label={`Everything (${data.counts.total})`}
              active={kind === 'all'}
              onClick={() => setKind('all')}
            />
            {kinds.map(k => (
              <FilterChip
                key={k}
                label={`${KIND_LABEL[k]} (${data.counts.by_kind[k]})`}
                active={kind === k}
                onClick={() => setKind(k)}
              />
            ))}
          </div>

          <div className="space-y-2">
            {items.map(item => {
              const w = waited(item.waiting_days);
              return (
                <Card key={item.id} className={`border-l-4 ${BORDER[item.severity]}`}>
                  <div className="flex flex-wrap items-start gap-3">
                    {item.employee
                      ? <Avatar name={item.employee.name} size="sm" />
                      : <div className="h-8 w-8 shrink-0" />}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-slate-900 dark:text-slate-100">{item.title}</p>
                        <Badge variant="neutral">{KIND_LABEL[item.kind]}</Badge>
                      </div>
                      <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">{item.detail}</p>
                      {item.employee && (
                        <p className="mt-0.5 text-xs text-slate-400">{item.employee.emp_id}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className={`text-xs ${w.tone}`}>
                        {item.waiting_days === null ? '' : `waiting ${w.text}`}
                      </span>
                      {item.alert_id ? (
                        <button
                          type="button"
                          onClick={() => { setNoting(item.alert_id!); setNote(''); }}
                          className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
                        >
                          {item.action}
                        </button>
                      ) : (
                        <Link
                          href={item.href}
                          className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
                        >
                          {item.action}
                        </Link>
                      )}
                    </div>
                  </div>

                  {noting === item.alert_id && item.alert_id && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 dark:border-slate-700">
                      <input
                        autoFocus
                        value={note}
                        onChange={e => setNote(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            clear.mutate({ action: 'acknowledge', id: item.alert_id, note });
                          }
                          if (e.key === 'Escape') setNoting(null);
                        }}
                        placeholder="What was done about it? (optional)"
                        className="h-9 flex-1 rounded-lg border border-slate-300 px-3 text-sm dark:border-slate-600 dark:bg-slate-900"
                      />
                      <button
                        type="button"
                        disabled={clear.isPending}
                        onClick={() => clear.mutate({ action: 'acknowledge', id: item.alert_id, note })}
                        className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
                      >
                        Acknowledge
                      </button>
                      <button
                        type="button"
                        disabled={clear.isPending}
                        onClick={() => clear.mutate({
                          action: 'snooze', id: item.alert_id,
                          until: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
                        })}
                        className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700"
                      >
                        Snooze a week
                      </button>
                      <button
                        type="button"
                        onClick={() => setNoting(null)}
                        className="text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                      >
                        Cancel
                      </button>
                      <p className="w-full text-xs text-slate-500 dark:text-slate-400">
                        A note is worth leaving: &ldquo;spoke to him, hospital visit&rdquo; is the
                        outcome of most of these, and it stays on the record. The alert
                        reopens on its own if the fact comes back.
                      </p>
                      {clear.isError && (
                        <p className="w-full text-xs text-red-600 dark:text-red-400">
                          {(clear.error as Error).message}
                        </p>
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>

          {data.counts.reviews > 0 && kind === 'all' && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Month review entries are from {data.review_month} and are not waiting on
              anybody in particular, so they are left out of the menu badge.{' '}
              <Link href="/review" className="text-blue-600 underline decoration-dotted dark:text-blue-400">
                See the full review
              </Link>.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function FilterChip({ label, active, onClick }: {
  label: string; active: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? 'bg-blue-600 text-white'
          : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
      }`}
    >
      {label}
    </button>
  );
}

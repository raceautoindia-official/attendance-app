'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Spinner from '@/components/ui/Spinner';
import type { ApiResponse } from '@/lib/types';

/**
 * Month review — the list of things that need a decision.
 *
 * Every other admin page answers a question you already thought to ask. This is
 * the opposite: it surfaces what would have been worth noticing, so a month can
 * be signed off on purpose rather than by default.
 *
 * It deliberately shows nothing when there is nothing to show. A review screen
 * that always has rows in it stops being read.
 */

type Severity = 'critical' | 'warning' | 'info';

interface Exception {
  id: string;
  type: string;
  severity: Severity;
  employee: { id: number; name: string; emp_id: string } | null;
  date: string | null;
  title: string;
  detail: string;
  action: string;
}

interface Report {
  period: { from_date: string; to_date: string };
  counts: { critical: number; warning: number; info: number; total: number };
  exceptions: Exception[];
  clear: boolean;
}

const TONE: Record<Severity, { badge: 'danger' | 'warning' | 'neutral'; label: string; border: string }> = {
  critical: { badge: 'danger', label: 'Needs fixing', border: 'border-l-red-500' },
  warning: { badge: 'warning', label: 'Worth checking', border: 'border-l-amber-500' },
  info: { badge: 'neutral', label: 'For information', border: 'border-l-slate-300 dark:border-l-slate-600' },
};

function recentMonths(count = 12) {
  const out: Array<{ value: string; label: string }> = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push({
      value: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    });
  }
  return out;
}

export default function ReviewPage() {
  const months = useMemo(() => recentMonths(), []);
  const [month, setMonth] = useState(months[0].value);
  const [hidden, setHidden] = useState<Set<Severity>>(new Set());

  const { data, isLoading, error } = useQuery({
    queryKey: ['exceptions', month],
    queryFn: async () => {
      const res = await fetch(`/api/exceptions?month=${month}`);
      const json: ApiResponse<Report> = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Could not load the review');
      return json.data!;
    },
  });

  const toggle = (s: Severity) =>
    setHidden(prev => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });

  const shown = (data?.exceptions ?? []).filter(e => !hidden.has(e.severity));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Month Review</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Everything worth a second look before this month is signed off.
          </p>
        </div>
        <select
          value={month}
          onChange={e => setMonth(e.target.value)}
          className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
        >
          {months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </div>

      {isLoading && <Card><div className="flex justify-center py-10"><Spinner /></div></Card>}
      {error && (
        <Card>
          <p className="py-6 text-center text-sm text-red-600 dark:text-red-400">
            {(error as Error).message}
          </p>
        </Card>
      )}

      {data && (
        <>
          {data.clear ? (
            <Card>
              <p className="py-8 text-center text-sm text-emerald-700 dark:text-emerald-400">
                Nothing needs attention in this month. Every day is clocked out, every
                rostered employee recorded hours, and no pattern stood out.
              </p>
            </Card>
          ) : (
            <>
              {/* Counts double as filters: a reviewer usually wants to clear the
                  red ones first and come back to the rest. */}
              <div className="grid grid-cols-3 gap-3">
                {(['critical', 'warning', 'info'] as const).map(s => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggle(s)}
                    className={`rounded-xl border p-3 text-left transition-all ${
                      hidden.has(s)
                        ? 'border-slate-200 bg-slate-50 opacity-50 dark:border-slate-700 dark:bg-slate-800/40'
                        : 'border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-800'
                    }`}
                  >
                    <p className="text-xl font-bold tabular-nums text-slate-900 dark:text-white">
                      {data.counts[s]}
                    </p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      {TONE[s].label}
                    </p>
                    <p className="mt-0.5 text-[10px] text-slate-400">
                      {hidden.has(s) ? 'hidden — click to show' : 'click to hide'}
                    </p>
                  </button>
                ))}
              </div>

              <div className="space-y-2">
                {shown.map(e => (
                  <Card key={e.id} className={`border-l-4 ${TONE[e.severity].border}`}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                            {e.title}
                          </p>
                          <Badge variant={TONE[e.severity].badge}>{TONE[e.severity].label}</Badge>
                          {e.date && (
                            <span className="text-[11px] tabular-nums text-slate-400">{e.date}</span>
                          )}
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                          {e.detail}
                        </p>
                        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                          <span className="font-medium">What to do:</span> {e.action}
                        </p>
                      </div>
                      {e.employee && (
                        <Link
                          href={`/hours?employee=${e.employee.id}&month=${month}`}
                          className="shrink-0 rounded-lg border border-slate-300 px-2.5 py-1 text-[11px] font-medium text-slate-600 transition-colors hover:border-blue-400 hover:text-blue-600 dark:border-slate-600 dark:text-slate-300"
                        >
                          Open hours
                        </Link>
                      )}
                    </div>
                  </Card>
                ))}
                {shown.length === 0 && (
                  <Card>
                    <p className="py-6 text-center text-xs text-slate-500 dark:text-slate-400">
                      Everything is hidden by the filters above.
                    </p>
                  </Card>
                )}
              </div>
            </>
          )}

          <Card>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Reviewed everything above?{' '}
              <Link href="/hours" className="font-medium text-blue-600 hover:underline dark:text-blue-400">
                Close the month
              </Link>{' '}
              on the Working Hours page to make its figures final.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}

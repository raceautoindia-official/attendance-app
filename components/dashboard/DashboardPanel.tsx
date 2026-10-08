'use client';

/**
 * components/dashboard/DashboardPanel.tsx — the home dashboard.
 *
 * Ordered by what it asks of the reader, not by what is easiest to draw:
 *
 *   1. NOW      — four numbers, large, each one a link to the page that acts on it
 *   2. NEEDS YOU — the queues, shown ONLY when something is waiting
 *   3. SHAPE    — the charts, which explain the numbers above rather than repeat them
 *   4. CAVEATS  — what the figures do not cover, said out loud
 *
 * The queues disappear when empty on purpose. A dashboard that always shows
 * "0 pending" in five places teaches people to stop reading it, and then the
 * one day something IS pending it looks the same as every other day.
 *
 * Charts come from the server as ChartSpec and render through the same
 * component the assistant's charts use, so there is one palette and one set of
 * rules about what a chart may claim.
 */

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
import Spinner from '@/components/ui/Spinner';
import Chart from '@/components/charts/Chart';
import type { ApiResponse } from '@/lib/types';
import type { ChartSpec } from '@/lib/charts/types';

interface Kpi {
  key: string;
  label: string;
  value: number;
  measured: boolean;
  hint: string;
  href?: string;
  tone: 'neutral' | 'good' | 'warn' | 'bad';
}

interface QueueItem { key: string; label: string; count: number; href: string }

interface Dashboard {
  as_of: string;
  month: string;
  today: {
    date: string; headcount: number; clocked_in: number; still_working: number;
    on_leave: number; holiday: string | null; not_in_yet: number;
  };
  kpis: Kpi[];
  queues: QueueItem[];
  charts: ChartSpec[];
  notes: string[];
}

const TONE: Record<Kpi['tone'], string> = {
  neutral: 'text-slate-900 dark:text-slate-100',
  good: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  bad: 'text-red-600 dark:text-red-400',
};

function KpiCard({ k }: { k: Kpi }) {
  const body = (
    <>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {k.label}
      </p>
      {/* A figure nobody measured is not zero. Printing 0 here would read as a
          clean record, which is the opposite of "we never checked". */}
      <p className={`mt-1 text-3xl font-semibold tabular-nums ${k.measured ? TONE[k.tone] : 'text-slate-400 dark:text-slate-500'}`}>
        {k.measured ? k.value.toLocaleString() : 'not measured'}
      </p>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{k.hint}</p>
    </>
  );

  return (
    <Card>
      {k.href
        ? <Link href={k.href} className="block transition-opacity hover:opacity-80">{body}</Link>
        : body}
    </Card>
  );
}

export default function DashboardPanel({ month }: { month?: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard', month ?? 'current'],
    queryFn: async () => {
      const res = await fetch(`/api/dashboard${month ? `?month=${month}` : ''}`);
      const json: ApiResponse<Dashboard> = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Could not load the dashboard');
      return json.data!;
    },
    // The "working now" figure goes stale quickly; the rest does not mind.
    refetchInterval: 120_000,
  });

  if (isLoading) {
    return (
      <Card>
        <div className="flex items-center justify-center py-10"><Spinner /></div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <p className="text-sm text-red-600 dark:text-red-400">
          {(error as Error).message}
        </p>
      </Card>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-4">
      {data.today.holiday && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-900 dark:border-blue-900/50 dark:bg-blue-950/40 dark:text-blue-200">
          Today is a company holiday — <strong>{data.today.holiday}</strong>. Anyone who works
          today is credited in full and the hours count as overtime.
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {data.kpis.map(k => <KpiCard key={k.key} k={k} />)}
      </div>

      {/* Shown only when something is actually waiting — see the file comment. */}
      {data.queues.length > 0 && (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-200">
            Waiting on you
          </h2>
          <div className="flex flex-wrap gap-2">
            {data.queues.map(q => (
              <Link
                key={q.key}
                href={q.href}
                className="group flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-sm text-amber-900 transition-colors hover:bg-amber-100 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-900/40"
              >
                <span className="rounded bg-amber-200 px-1.5 py-0.5 text-xs font-semibold tabular-nums text-amber-900 dark:bg-amber-800 dark:text-amber-100">
                  {q.count}
                </span>
                {q.label}
                <span className="opacity-0 transition-opacity group-hover:opacity-100">&rarr;</span>
              </Link>
            ))}
          </div>
        </Card>
      )}

      {data.charts.length > 0 && (
        <div className="grid gap-4 xl:grid-cols-2">
          {data.charts.map((spec, i) => (
            <Card key={`${spec.type}-${i}`}>
              <Chart spec={spec} />
            </Card>
          ))}
        </div>
      )}

      {data.notes.length > 0 && (
        <Card>
          <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            What these figures do not cover
          </h2>
          <ul className="space-y-1">
            {data.notes.map((n, i) => (
              <li key={i} className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                {n}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

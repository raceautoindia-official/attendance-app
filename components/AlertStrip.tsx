'use client';

/**
 * What needs attention, on the page people already open first.
 *
 * The Inbox is where alerts get cleared, but somebody who starts their morning
 * on Today should not have to go looking to find out that two people have not
 * clocked in. One line, the counts, the three most serious, and a way through.
 *
 * Renders NOTHING when there is nothing. A strip that is always on screen
 * becomes part of the furniture, and then the morning it says something real
 * nobody sees it.
 */

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { ApiResponse } from '@/lib/types';

interface AlertRow {
  id: number;
  rule_key: string;
  employee_name: string | null;
  severity: 'critical' | 'warning' | 'info';
  state: 'open' | 'acknowledged' | 'resolved';
  title: string;
  body: string;
}

interface AlertsPayload {
  alerts: AlertRow[];
  counts: { total: number; open: number; critical: number; warning: number; info: number };
}

export default function AlertStrip() {
  const { data, error } = useQuery({
    queryKey: ['alerts', 'strip'],
    queryFn: async () => {
      const res = await fetch('/api/alerts?rules=0');
      const json = await res.json() as ApiResponse<AlertsPayload>;
      // A manager without alerts.view gets a 403, which is not a page error -
      // it is simply a strip they do not see.
      if (!json.success) throw new Error(json.error ?? 'no alerts');
      return json.data!;
    },
    refetchInterval: 120_000,
    retry: false,
  });

  if (error || !data) return null;
  const open = data.alerts.filter(a => a.state === 'open');
  if (open.length === 0) return null;

  const tone = data.counts.critical > 0
    ? 'border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-950/30'
    : 'border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30';

  return (
    <section className={`rounded-xl border p-4 ${tone}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {open.length} thing{open.length === 1 ? '' : 's'} need attention
        </h2>
        <Link
          href="/inbox"
          className="text-xs font-medium text-blue-700 underline decoration-dotted hover:decoration-solid dark:text-blue-300"
        >
          Open the queue
        </Link>
      </div>

      <ul className="mt-2 space-y-1">
        {/* Three, not all of them. The strip is a prompt to go and look, and a
            list long enough to scroll is not a prompt. */}
        {open.slice(0, 3).map(a => (
          <li key={a.id} className="text-sm text-slate-700 dark:text-slate-300">
            <span className={a.severity === 'critical' ? 'font-semibold' : ''}>{a.title}</span>
            {' '}
            <span className="text-xs text-slate-500 dark:text-slate-400">{a.body}</span>
          </li>
        ))}
      </ul>

      {open.length > 3 && (
        <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
          and {open.length - 3} more.
        </p>
      )}
    </section>
  );
}

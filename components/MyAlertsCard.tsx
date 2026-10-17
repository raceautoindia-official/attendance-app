'use client';

/**
 * The employee's own alerts, told to them in the second person.
 *
 * WHY SHOW SOMEBODY THEIR OWN LATENESS
 * ------------------------------------
 * Because the alternative is that the first they hear of it is their manager
 * raising it. "You have arrived late four times this month" is something a
 * person can act on themselves, and most people would rather fix it than be
 * told about it. The admin-facing wording ("Arun has been late four times") is
 * deliberately not what appears here - see `selfPhrasing` in lib/alerts.ts.
 *
 * Only the patterns. "You have not clocked in" read at four in the afternoon
 * is not news to the person who did not, and the API filters those out.
 *
 * Renders nothing when there is nothing, which for most people is most months.
 */

import { useQuery } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
import type { ApiResponse } from '@/lib/types';

interface MyAlert {
  id: number;
  rule_key: string;
  severity: 'critical' | 'warning' | 'info';
  period_key: string;
  title: string;
  body: string;
}

export default function MyAlertsCard() {
  const { data } = useQuery({
    queryKey: ['alerts', 'mine'],
    queryFn: async () => {
      const res = await fetch('/api/alerts?mine=1');
      const json = await res.json() as ApiResponse<{ alerts: MyAlert[] }>;
      if (!json.success) throw new Error(json.error ?? 'could not read');
      return json.data!.alerts;
    },
    retry: false,
  });

  if (!data || data.length === 0) return null;

  return (
    <Card>
      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
        Worth knowing
      </h2>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
        Your manager can see these too. Nothing here is a decision about you.
      </p>
      <ul className="mt-3 space-y-3">
        {data.map(a => (
          <li
            key={a.id}
            className={`border-l-4 pl-3 ${
              a.severity === 'critical'
                ? 'border-l-red-400'
                : a.severity === 'warning'
                  ? 'border-l-amber-400'
                  : 'border-l-slate-300 dark:border-l-slate-600'
            }`}
          >
            <p className="text-sm font-medium text-slate-800 dark:text-slate-200">{a.title}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">{a.body}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

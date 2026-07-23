'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Button from '@/components/ui/Button';
import Spinner from '@/components/ui/Spinner';
import Badge from '@/components/ui/Badge';
import type { ApiResponse } from '@/lib/types';

interface QuotaRow {
  employee_id: number;
  emp_id: string;
  employee_name: string;
  year: number;
  casual_total: number;
  sick_total: number;
  earned_total: number;
  casual_used: number;
  sick_used: number;
  earned_used: number;
  has_quota: boolean;
}

type Totals = { casual_total: number; sick_total: number; earned_total: number };

const numInputClass = 'w-16 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 px-2 py-1.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500';

function clampDays(raw: string): number {
  const n = parseInt(raw, 10);
  if (isNaN(n)) return 0;
  return Math.min(365, Math.max(0, n));
}

/** Yearly leave entitlement editor — lists every employee with their quota
 *  for the selected year, days already used, and remaining balance. */
export default function LeaveQuotasPanel({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const years = [currentYear - 2, currentYear - 1, currentYear, currentYear + 1];

  // Per-row unsaved edits, keyed by employee id.
  const [edits, setEdits] = useState<Record<number, Totals>>({});
  const [bulk, setBulk] = useState<Totals>({ casual_total: 12, sick_total: 6, earned_total: 12 });
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['leave-quotas', year],
    queryFn: async () => {
      const res = await fetch(`/api/leave-quotas?year=${year}`);
      return res.json() as Promise<ApiResponse<{ year: number; quotas: QuotaRow[] }>>;
    },
  });
  const quotas = data?.data?.quotas ?? [];
  const loadError = data && !data.success ? data.error : null;

  const saveMutation = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      setError(null);
      const res = await fetch('/api/leave-quotas', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Failed to save quota');
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leave-quotas'] });
      setEdits({});
    },
    onError: (err: Error) => setError(err.message),
  });

  const rowValues = (row: QuotaRow): Totals =>
    edits[row.employee_id] ?? {
      casual_total: row.casual_total,
      sick_total: row.sick_total,
      earned_total: row.earned_total,
    };

  const setRowValue = (employeeId: number, row: QuotaRow, key: keyof Totals, raw: string) => {
    setEdits(prev => ({
      ...prev,
      [employeeId]: { ...(prev[employeeId] ?? rowValues(row)), [key]: clampDays(raw) },
    }));
  };

  const remaining = (total: number, used: number) => Math.max(0, total - used);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Year</label>
          <select
            value={year}
            onChange={e => { setYear(Number(e.target.value)); setEdits({}); }}
            className="rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>

        {canEdit && (
          <div className="flex flex-wrap items-end gap-2 sm:ml-auto">
            {(['casual_total', 'sick_total', 'earned_total'] as const).map(key => (
              <div key={key} className="flex flex-col gap-1">
                <label className="text-xs text-slate-500 dark:text-slate-400 capitalize">{key.split('_')[0]}</label>
                <input
                  type="number"
                  min={0}
                  max={365}
                  value={bulk[key]}
                  onChange={e => setBulk(prev => ({ ...prev, [key]: clampDays(e.target.value) }))}
                  className={numInputClass}
                />
              </div>
            ))}
            <Button
              size="sm"
              variant="secondary"
              loading={saveMutation.isPending}
              onClick={() => {
                if (confirm(`Set the ${year} quota to Casual ${bulk.casual_total} / Sick ${bulk.sick_total} / Earned ${bulk.earned_total} for ALL active employees? This overwrites existing quotas for ${year}.`)) {
                  saveMutation.mutate({ apply_to_all: true, year, ...bulk });
                }
              }}
            >
              Apply to All
            </Button>
          </div>
        )}
      </div>

      {(error || loadError) && <p className="text-sm text-red-500">{error ?? loadError}</p>}

      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : (
        <div className="overflow-x-auto border border-slate-200 dark:border-slate-700 rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-900/60 text-left">
                <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Employee</th>
                {['Casual', 'Sick', 'Earned'].map(h => (
                  <th key={h} className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 text-center">
                    {h}
                    <span className="block font-normal normal-case text-slate-400">quota · used · left</span>
                  </th>
                ))}
                {canEdit && <th className="px-3 py-2.5" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50">
              {quotas.length === 0 ? (
                <tr>
                  <td colSpan={canEdit ? 5 : 4} className="px-4 py-8 text-center text-slate-400">
                    No active employees found.
                  </td>
                </tr>
              ) : quotas.map(row => {
                const values = rowValues(row);
                const dirty = !!edits[row.employee_id];
                return (
                  <tr key={row.employee_id}>
                    <td className="px-4 py-2.5">
                      <p className="font-medium text-slate-800 dark:text-slate-200">{row.employee_name}</p>
                      <p className="text-xs text-slate-400">
                        {row.emp_id}
                        {!row.has_quota && <Badge variant="warning" className="ml-2">No quota set</Badge>}
                      </p>
                    </td>
                    {([
                      ['casual_total', row.casual_used],
                      ['sick_total', row.sick_used],
                      ['earned_total', row.earned_used],
                    ] as const).map(([key, used]) => (
                      <td key={key} className="px-3 py-2.5 text-center whitespace-nowrap">
                        {canEdit ? (
                          <input
                            type="number"
                            min={0}
                            max={365}
                            value={values[key]}
                            onChange={e => setRowValue(row.employee_id, row, key, e.target.value)}
                            className={numInputClass}
                          />
                        ) : (
                          <span className="font-medium text-slate-800 dark:text-slate-200">{values[key]}</span>
                        )}
                        <span className="ml-2 text-xs text-slate-400">· {used} used ·</span>
                        <span className="ml-1 text-xs font-semibold text-slate-700 dark:text-slate-300">
                          {remaining(values[key], used)} left
                        </span>
                      </td>
                    ))}
                    {canEdit && (
                      <td className="px-3 py-2.5 text-right">
                        <Button
                          size="sm"
                          disabled={!dirty}
                          loading={saveMutation.isPending && dirty}
                          onClick={() => saveMutation.mutate({ employee_id: row.employee_id, year, ...values })}
                        >
                          Save
                        </Button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

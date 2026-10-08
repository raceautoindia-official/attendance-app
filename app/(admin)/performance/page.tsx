'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Spinner from '@/components/ui/Spinner';
import type { ApiResponse } from '@/lib/types';

/**
 * Performance — scoring, with its workings on show.
 *
 * A single number next to somebody's name invites being read as a verdict, so
 * the three components it is made of are always visible beside it, and the
 * facts the score deliberately excludes — leave taken above all — sit in the
 * same row rather than being buried.
 *
 * Leave is reported and never scored. It is an entitlement the company grants
 * and an administrator approves; ranking somebody down for taking approved sick
 * leave is not a judgement this page is willing to make silently.
 */

interface Component {
  value: number | null;
  weight: number;
  measurable: boolean;
  detail: string;
}

interface Score {
  employee: { id: number; name: string; emp_id: string; department: string | null };
  policy: { id: number; name: string; code: string } | null;
  standing: 'counted' | 'dormant' | 'excluded';
  components: { attendance: Component; punctuality: Component; hours: Component };
  total: number | null;
  facts: {
    working_days: number; days_attended: number; days_absent: number;
    leave_days: number; late_days: number | null;
    worked_minutes: number; required_minutes: number; net_minutes: number;
  };
  notes: string[];
}

interface Report {
  period: { from_date: string; to_date: string };
  ranked: Score[];
  unranked: Score[];
  median: number | null;
  notes: string[];
}

interface Policy { id: number; name: string; code: string }

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

const hm = (m: number) => `${Math.floor(Math.abs(m) / 60)}h ${Math.abs(m) % 60}m`;
const tone = (v: number | null) =>
  v == null ? 'text-slate-400'
    : v >= 90 ? 'text-emerald-600 dark:text-emerald-400'
      : v >= 70 ? 'text-slate-800 dark:text-slate-100'
        : v >= 50 ? 'text-amber-600 dark:text-amber-400'
          : 'text-red-600 dark:text-red-400';

export default function PerformancePage() {
  const months = useMemo(() => recentMonths(), []);
  const [month, setMonth] = useState(months[1]?.value ?? months[0].value);
  const [policyId, setPolicyId] = useState<string>('');
  const [expanded, setExpanded] = useState<number | null>(null);

  const { data: policies } = useQuery({
    queryKey: ['policies', 'for-performance'],
    queryFn: async () => {
      const res = await fetch('/api/policies');
      const json: ApiResponse<{ policies: Policy[] }> = await res.json();
      return json.data?.policies ?? [];
    },
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ['performance', month, policyId],
    queryFn: async () => {
      const res = await fetch(
        `/api/reports/performance?month=${month}${policyId ? `&policy_id=${policyId}` : ''}`,
      );
      const json: ApiResponse<Report> = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Could not load the scores');
      return json.data!;
    },
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Performance</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Attendance, punctuality and hours delivered, weighted by each employee&apos;s policy.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <select
            value={month}
            onChange={e => setMonth(e.target.value)}
            className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          >
            {months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <select
            value={policyId}
            onChange={e => setPolicyId(e.target.value)}
            className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="">All policies</option>
            {(policies ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </div>

      {isLoading && (
        <Card>
          <div className="flex flex-col items-center gap-2 py-10">
            <Spinner />
            <p className="text-xs text-slate-400">Building a full ledger for each employee…</p>
          </div>
        </Card>
      )}
      {error && (
        <Card><p className="py-6 text-center text-sm text-red-600 dark:text-red-400">{(error as Error).message}</p></Card>
      )}

      {data && (
        <>
          {data.notes.length > 0 && (
            <Card>
              <ul className="space-y-1">
                {data.notes.map((n, i) => (
                  <li key={i} className="text-xs text-slate-500 dark:text-slate-400">{n}</li>
                ))}
              </ul>
            </Card>
          )}

          <Card>
            <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              <strong className="font-semibold">What the score is made of:</strong> attendance
              (turned up when expected), punctuality (arrived on time, where that can be measured
              at all), and hours delivered. Week offs, holidays and approved leave never asked for
              anybody, so they cannot cost a mark.{' '}
              <strong className="font-semibold">Leave taken is shown but not scored</strong> — it is
              an entitlement the company grants, and ranking somebody down for approved sick leave
              is not a judgement this page makes on its own. Make it a weighted component in the
              policy if it should count.
            </p>
          </Card>

          {data.median != null && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Median score across the {data.ranked.length} people scored: <strong>{data.median}</strong>
            </p>
          )}

          <div className="space-y-2">
            {data.ranked.map((s, i) => (
              <Card key={s.employee.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 text-left"
                  onClick={() => setExpanded(expanded === s.employee.id ? null : s.employee.id)}
                >
                  <span className="w-6 shrink-0 text-center text-sm font-semibold tabular-nums text-slate-400">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                        {s.employee.name}
                      </span>
                      <span className="text-xs text-slate-400">{s.employee.emp_id}</span>
                      {s.policy && <Badge variant="info">{s.policy.code}</Badge>}
                      {s.facts.leave_days > 0 && (
                        <span className="text-[11px] text-slate-500 dark:text-slate-400">
                          {s.facts.leave_days} leave day{s.facts.leave_days === 1 ? '' : 's'}
                        </span>
                      )}
                      {s.facts.days_absent > 0 && (
                        <span className="text-[11px] text-amber-600 dark:text-amber-400">
                          {s.facts.days_absent} absent
                        </span>
                      )}
                    </span>
                    <span className="mt-1 flex flex-wrap gap-3 text-[11px] text-slate-500 dark:text-slate-400">
                      <span>Attendance <strong className={tone(s.components.attendance.value)}>
                        {s.components.attendance.value ?? '—'}
                      </strong></span>
                      <span>Punctuality <strong className={tone(s.components.punctuality.value)}>
                        {s.components.punctuality.value ?? 'n/a'}
                      </strong></span>
                      <span>Hours <strong className={tone(s.components.hours.value)}>
                        {s.components.hours.value ?? '—'}
                      </strong></span>
                    </span>
                  </span>
                  <span className={`shrink-0 text-xl font-bold tabular-nums ${tone(s.total)}`}>
                    {s.total ?? '—'}
                  </span>
                </button>

                {expanded === s.employee.id && (
                  <div className="mt-3 space-y-2 border-t border-slate-200 pt-3 dark:border-slate-700">
                    {(['attendance', 'punctuality', 'hours'] as const).map(k => {
                      const c = s.components[k];
                      return (
                        <div key={k} className="flex items-start justify-between gap-3 text-xs">
                          <span className="capitalize text-slate-600 dark:text-slate-300">
                            {k}
                            <span className="ml-1.5 text-slate-400">
                              weight {c.weight}%{!c.measurable && ' · redistributed'}
                            </span>
                            <span className="block text-[11px] text-slate-400">{c.detail}</span>
                          </span>
                          <span className={`shrink-0 tabular-nums font-medium ${tone(c.value)}`}>
                            {c.value ?? 'n/a'}
                          </span>
                        </div>
                      );
                    })}
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-dashed border-slate-200 pt-2 text-[11px] text-slate-500 dark:border-slate-700 dark:text-slate-400 sm:grid-cols-4">
                      <span>Worked <strong>{hm(s.facts.worked_minutes)}</strong></span>
                      <span>Required <strong>{hm(s.facts.required_minutes)}</strong></span>
                      {/* null is 'never measured', which must not print as 0 -
                          beside a card already saying punctuality could not be
                          measured, a bare 0 reads as a clean record. */}
                      <span>
                        Late days{' '}
                        {s.facts.late_days === null
                          ? <strong title="Not measured: this employee is on a flexible shift">not measured</strong>
                          : <strong>{s.facts.late_days}</strong>}
                      </span>
                      <span>Leave <strong>{s.facts.leave_days}</strong></span>
                    </div>
                    {s.notes.map((n, i) => (
                      <p key={i} className="text-[11px] text-amber-700 dark:text-amber-400">{n}</p>
                    ))}
                    <Link
                      href={`/reports?employee=${s.employee.id}&month=${month}`}
                      className="inline-block text-[11px] font-medium text-blue-600 hover:underline dark:text-blue-400"
                    >
                      Open their hours →
                    </Link>
                  </div>
                )}
              </Card>
            ))}
          </div>

          {data.ranked.length === 0 && (
            <Card>
              <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
                Nobody could be scored for this period.
              </p>
            </Card>
          )}

          {data.unranked.length > 0 && (
            <Card>
              <h2 className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
                Listed but not ranked
              </h2>
              <ul className="space-y-1">
                {data.unranked.map(s => (
                  <li key={s.employee.id} className="flex flex-wrap items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                    <span className="font-medium">{s.employee.name}</span>
                    <span className="text-slate-400">{s.notes[0] ?? s.standing}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-slate-400">
                An administrator, somebody with no roster, or nobody to score. Putting a number
                against them would be meaningless rather than low.
              </p>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

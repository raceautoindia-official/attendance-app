'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Spinner from '@/components/ui/Spinner';
import EmployeeDocuments from '@/components/EmployeeDocuments';
import type { ApiResponse } from '@/lib/types';

/**
 * Documents — who is missing which papers.
 *
 * Upload has existed and worked for months, and production holds zero
 * documents. The feature was never the problem: it lived inside an expanded row
 * on the Employees page, one person at a time, and nothing showed the gap. An
 * administrator had no way to see who had filed nothing, so nobody chased it.
 *
 * This leads with what is missing and lets the upload happen in place, so the
 * question and the answer are on the same screen.
 */

interface Requirement {
  key: string;
  label: string;
  reason: string;
  required: boolean;
}

interface Compliance {
  employee: { id: number; name: string; emp_id: string; department: string | null };
  policy: { id: number; name: string; code: string } | null;
  onFile: Array<{ id: number; doc_type: string; title: string; uploaded_on: string; storage: 'db' | 's3' }>;
  satisfied: Requirement[];
  missing: Requirement[];
  complete: boolean;
}

interface Report {
  employees: Compliance[];
  totals: { employees: number; complete: number; incomplete: number; documents_on_file: number };
  notes: string[];
  storage: { configured: boolean; max_bytes: number; note: string; bucket: string | null };
}

export default function DocumentsPage() {
  const [filter, setFilter] = useState<'incomplete' | 'all'>('incomplete');
  const [open, setOpen] = useState<number | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['document-compliance'],
    queryFn: async () => {
      const res = await fetch('/api/reports/documents');
      const json: ApiResponse<Report> = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Could not load the report');
      return json.data!;
    },
  });

  const shown = (data?.employees ?? []).filter(c => filter === 'all' || !c.complete);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Documents</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            What each employee still owes, and why it is being asked for.
          </p>
        </div>
        <div className="flex rounded-lg border border-slate-300 p-0.5 dark:border-slate-600">
          {(['incomplete', 'all'] as const).map(f => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                filter === f
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700'
              }`}
            >
              {f === 'incomplete' ? 'Missing something' : 'Everybody'}
            </button>
          ))}
        </div>
      </div>

      {isLoading && <Card><div className="flex justify-center py-10"><Spinner /></div></Card>}
      {error && (
        <Card><p className="py-6 text-center text-sm text-red-600 dark:text-red-400">{(error as Error).message}</p></Card>
      )}

      {data && (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Employees" value={String(data.totals.employees)} />
            <Stat label="Papers complete" value={String(data.totals.complete)} tone="good" />
            <Stat
              label="Missing something"
              value={String(data.totals.incomplete)}
              tone={data.totals.incomplete > 0 ? 'bad' : 'good'}
            />
          </div>

          <Card>
            <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              <strong className="font-semibold">Where these requirements come from:</strong> each
              employee&apos;s policy. If PF is applicable they need a PAN and a bank proof; that
              follows from the flag rather than being configured a second time. Somebody on no
              policy is asked only for proof of identity — the app does not invent obligations for
              an employee whose terms nobody has recorded.
            </p>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              {data.storage.configured
                ? `Files go straight to S3 (${data.storage.bucket}) — up to ${Math.floor(data.storage.max_bytes / (1024 * 1024))} MB each.`
                : `Files are stored in the database, up to ${Math.floor(data.storage.max_bytes / (1024 * 1024))} MB each. Configure an S3 bucket to allow larger ones.`}
            </p>
          </Card>

          {data.notes.map((n, i) => (
            <p key={i} className="text-xs text-slate-500 dark:text-slate-400">{n}</p>
          ))}

          {shown.length === 0 && (
            <Card>
              <p className="py-8 text-center text-sm text-emerald-700 dark:text-emerald-400">
                {filter === 'incomplete'
                  ? 'Everybody has filed what their policy requires.'
                  : 'No employees to show.'}
              </p>
            </Card>
          )}

          <div className="space-y-2">
            {shown.map(c => (
              <Card key={c.employee.id}>
                <button
                  type="button"
                  className="flex w-full items-start justify-between gap-3 text-left"
                  onClick={() => setOpen(open === c.employee.id ? null : c.employee.id)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                        {c.employee.name}
                      </span>
                      <span className="text-xs text-slate-400">{c.employee.emp_id}</span>
                      {c.policy
                        ? <Badge variant="info">{c.policy.code}</Badge>
                        : <Badge variant="neutral">no policy</Badge>}
                      {c.complete
                        ? <Badge variant="success">complete</Badge>
                        : <Badge variant="warning">
                            {c.missing.filter(m => m.required).length} missing
                          </Badge>}
                    </span>
                    <span className="mt-1 flex flex-wrap gap-1.5">
                      {c.missing.map(m => (
                        <span
                          key={m.key}
                          title={m.reason}
                          className={`rounded px-1.5 py-0.5 text-[10px] ${
                            m.required
                              ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
                              : 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400'
                          }`}
                        >
                          {m.label}{m.required ? '' : ' (optional)'}
                        </span>
                      ))}
                      {c.onFile.length > 0 && (
                        <span className="text-[10px] text-slate-400">
                          {c.onFile.length} on file
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-blue-600 dark:text-blue-400">
                    {open === c.employee.id ? 'Close' : 'Upload'}
                  </span>
                </button>

                {open === c.employee.id && (
                  <div className="mt-3 border-t border-slate-200 pt-3 dark:border-slate-700">
                    {c.missing.length > 0 && (
                      <ul className="mb-3 space-y-1">
                        {c.missing.map(m => (
                          <li key={m.key} className="text-xs text-slate-600 dark:text-slate-300">
                            <strong className="font-medium">{m.label}</strong>
                            <span className="text-slate-400"> — {m.reason}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <EmployeeDocuments employeeId={c.employee.id} canDelete />
                  </div>
                )}
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <Card>
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
      <p className={`mt-1 text-xl font-bold tabular-nums ${
        tone === 'bad' ? 'text-amber-600 dark:text-amber-400'
          : tone === 'good' ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-slate-900 dark:text-white'
      }`}>
        {value}
      </p>
    </Card>
  );
}

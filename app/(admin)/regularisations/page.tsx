'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Spinner from '@/components/ui/Spinner';
import type { ApiResponse } from '@/lib/types';

/**
 * Attendance corrections — the queue.
 *
 * Approving one applies the change to the attendance row, so this screen shows
 * the before and the after together. Somebody deciding should not have to open
 * another page to find out what they are changing.
 */

type Status = 'pending' | 'approved' | 'rejected' | 'cancelled';

interface Request {
  id: number;
  employee_id: number;
  employee_name: string;
  emp_id: string;
  work_date: string;
  requested_clock_in: string | null;
  requested_clock_out: string | null;
  reason: string;
  status: Status;
  requested_by_name: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  previous_clock_in: string | null;
  previous_clock_out: string | null;
  previous_total_minutes: number | null;
  created_at: string;
}

const ist = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short',
        hour: '2-digit', minute: '2-digit', hour12: true,
      })
    : '—';

const TONE: Record<Status, 'warning' | 'success' | 'danger' | 'neutral'> = {
  pending: 'warning', approved: 'success', rejected: 'danger', cancelled: 'neutral',
};

export default function RegularisationsPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<Status | 'all'>('pending');
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['regularisations', status],
    queryFn: async () => {
      const res = await fetch(`/api/regularisations?status=${status}`);
      const json: ApiResponse<{ requests: Request[] }> = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Could not load requests');
      return json.data?.requests ?? [];
    },
  });

  const decide = useMutation({
    mutationFn: async ({ id, action }: { id: number; action: 'approve' | 'reject' }) => {
      const res = await fetch(`/api/regularisations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, notes: notes[id] ?? null }),
      });
      const json: ApiResponse<unknown> = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Could not update the request');
      return json.data;
    },
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['regularisations'] });
      // The correction changed somebody's hours, so anything showing them is stale.
      qc.invalidateQueries({ queryKey: ['hours-ledger'] });
      qc.invalidateQueries({ queryKey: ['exceptions'] });
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Attendance Corrections</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Requests to fix a day — a missed clock-out, a wrong time. Approving one
            applies the change and records who agreed to it.
          </p>
        </div>
        <div className="flex rounded-lg border border-slate-300 p-0.5 dark:border-slate-600">
          {(['pending', 'approved', 'rejected', 'all'] as const).map(s => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className={`rounded-md px-2.5 py-1.5 text-xs font-medium capitalize transition-colors ${
                status === s
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <Card><p className="text-sm text-red-600 dark:text-red-400">{error}</p></Card>
      )}

      {isLoading && <Card><div className="flex justify-center py-10"><Spinner /></div></Card>}

      {data && data.length === 0 && (
        <Card>
          <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
            {status === 'pending'
              ? 'Nothing waiting for a decision.'
              : `No ${status} requests.`}
          </p>
        </Card>
      )}

      <div className="space-y-3">
        {(data ?? []).map(r => (
          <Card key={r.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                    {r.employee_name}
                  </p>
                  <span className="text-xs text-slate-400">{r.emp_id}</span>
                  <Badge variant={TONE[r.status]}>{r.status}</Badge>
                  <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
                    {r.work_date}
                  </span>
                </div>

                <p className="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                  &ldquo;{r.reason}&rdquo;
                </p>
                <p className="mt-0.5 text-[11px] text-slate-400">
                  Raised by {r.requested_by_name ?? 'unknown'} on{' '}
                  {new Date(r.created_at).toLocaleDateString('en-IN', {
                    day: 'numeric', month: 'short', year: 'numeric',
                  })}
                </p>

                {/* Before and after side by side: deciding should not need
                    another page to find out what is being changed. */}
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <div className="rounded-lg bg-slate-50 px-2.5 py-1.5 dark:bg-slate-800">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                      {r.status === 'approved' ? 'Was' : 'Currently'}
                    </p>
                    <p className="text-xs tabular-nums text-slate-700 dark:text-slate-200">
                      {r.status === 'approved'
                        ? `${ist(r.previous_clock_in)} → ${ist(r.previous_clock_out)}`
                        : 'on the attendance record'}
                    </p>
                  </div>
                  <div className="rounded-lg bg-blue-50 px-2.5 py-1.5 dark:bg-blue-950/40">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-blue-500 dark:text-blue-400">
                      {r.status === 'approved' ? 'Changed to' : 'Asking for'}
                    </p>
                    <p className="text-xs tabular-nums text-blue-800 dark:text-blue-200">
                      {r.requested_clock_in ? ist(r.requested_clock_in) : '(unchanged)'}
                      {' → '}
                      {r.requested_clock_out ? ist(r.requested_clock_out) : '(unchanged)'}
                    </p>
                  </div>
                </div>

                {r.reviewed_by_name && (
                  <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
                    {r.status === 'approved' ? 'Approved' : 'Rejected'} by {r.reviewed_by_name}
                    {r.reviewed_at ? ` on ${new Date(r.reviewed_at).toLocaleDateString('en-IN', {
                      day: 'numeric', month: 'short', year: 'numeric',
                    })}` : ''}
                    {r.review_notes ? ` — “${r.review_notes}”` : ''}
                  </p>
                )}
              </div>

              {r.status === 'pending' && (
                <div className="flex w-full flex-col gap-2 sm:w-64">
                  <Input
                    label="Note"
                    value={notes[r.id] ?? ''}
                    onChange={e => setNotes(n => ({ ...n, [r.id]: e.target.value }))}
                    placeholder="Required to reject"
                  />
                  <div className="flex gap-2">
                    <Button
                      className="flex-1"
                      onClick={() => decide.mutate({ id: r.id, action: 'approve' })}
                      disabled={decide.isPending}
                    >
                      Approve
                    </Button>
                    <Button
                      variant="danger"
                      className="flex-1"
                      onClick={() => decide.mutate({ id: r.id, action: 'reject' })}
                      disabled={decide.isPending || (notes[r.id] ?? '').trim().length < 3}
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

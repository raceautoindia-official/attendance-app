'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Spinner from '@/components/ui/Spinner';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// Things an admin should look at. Today: somebody clocked in away from their
// work site and gave a reason.
//
// Approving or rejecting does NOT change their attendance — that is stated on
// the page itself, because it is the thing most likely to be misunderstood. The
// employee was clocked in the moment they gave a reason and stays clocked in.
// ---------------------------------------------------------------------------

interface NotificationRow {
  attendance_id: number;
  employee_id: number;
  employee_name: string;
  emp_id: string;
  work_date: string;
  clock_in_utc: string;
  clock_in_lat: number | null;
  clock_in_lng: number | null;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewed_at: string | null;
  reviewed_by_name: string | null;
  review_notes: string | null;
  location_name: string | null;
  location_lat: number | null;
  location_lng: number | null;
  radius_meters: number | null;
}

const IST = 'Asia/Kolkata';

function istDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    timeZone: IST, day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

function metresBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const STATUS_BADGE: Record<NotificationRow['status'], 'warning' | 'success' | 'danger'> = {
  pending: 'warning', approved: 'success', rejected: 'danger',
};

export default function NotificationsPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending');
  const [notes, setNotes] = useState<Record<number, string>>({});

  const { data, isLoading } = useQuery({
    queryKey: ['notifications', filter],
    queryFn: async () => {
      const res = await fetch(`/api/notifications?status=${filter}`);
      return res.json() as Promise<ApiResponse<{ notifications: NotificationRow[]; pending_count: number }>>;
    },
    refetchInterval: 30_000,
  });
  const rows = data?.data?.notifications ?? [];

  const review = useMutation({
    mutationFn: async ({ id, action, note }: { id: number; action: 'approve' | 'reject'; note?: string }) => {
      const res = await fetch(`/api/notifications/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, review_notes: note?.trim() || null }),
      });
      const json = (await res.json()) as ApiResponse;
      if (!res.ok || !json.success) throw new Error(json.error ?? 'Could not record that');
      return json;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-800 dark:text-slate-200">Notifications</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Clock-ins from away from the work site, with the reason given.
        </p>
      </div>

      <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-3">
        <p className="text-sm text-blue-800 dark:text-blue-300">
          <strong>Their attendance is already counted.</strong> Approving or rejecting here records
          what you think of the trip — it does not add or remove anybody&apos;s hours, and a clock-in
          nobody reviews still counts in full. To change someone&apos;s hours, edit the record in
          Checkin Records.
        </p>
      </div>

      <div className="flex gap-2">
        {(['pending', 'approved', 'rejected', 'all'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
              filter === f
                ? 'bg-blue-600 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
            }`}
          >
            {f}
            {f === 'pending' && (data?.data?.pending_count ?? 0) > 0 && (
              <span className="ml-1.5 rounded-full bg-white/20 px-1.5 text-xs">
                {data?.data?.pending_count}
              </span>
            )}
          </button>
        ))}
      </div>

      {review.isError && (
        <p className="text-sm text-red-500">{(review.error as Error).message}</p>
      )}

      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : rows.length === 0 ? (
        <Card>
          <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
            {filter === 'pending'
              ? 'Nothing to review — nobody has clocked in away from their work site.'
              : `No ${filter} off-site clock-ins.`}
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map(r => {
            const away =
              r.clock_in_lat != null && r.clock_in_lng != null &&
              r.location_lat != null && r.location_lng != null
                ? Math.round(metresBetween(
                    Number(r.clock_in_lat), Number(r.clock_in_lng),
                    Number(r.location_lat), Number(r.location_lng)))
                : null;
            return (
              <Card key={r.attendance_id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-slate-800 dark:text-slate-200">
                        {r.employee_name}
                      </p>
                      <span className="text-xs text-slate-400">{r.emp_id}</span>
                      <Badge variant={STATUS_BADGE[r.status]}>{r.status}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      Clocked in {istDateTime(r.clock_in_utc)}
                      {away != null && r.radius_meters != null && (
                        <> · <strong>{away} m</strong> from {r.location_name ?? 'their work site'}
                          {' '}(fence {r.radius_meters} m)</>
                      )}
                    </p>
                    <p className="mt-2 rounded-md border-l-2 border-blue-500 bg-slate-50 px-3 py-2 text-sm text-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
                      {r.reason}
                    </p>
                    {r.clock_in_lat != null && r.clock_in_lng != null && (
                      <a
                        href={`https://www.google.com/maps?q=${r.clock_in_lat},${r.clock_in_lng}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1.5 inline-block text-xs text-blue-600 hover:underline dark:text-blue-400"
                      >
                        See where they were ↗
                      </a>
                    )}
                    {r.status !== 'pending' && (
                      <p className="mt-2 text-xs text-slate-400">
                        {r.status} by {r.reviewed_by_name ?? 'an admin'} on {istDateTime(r.reviewed_at)}
                        {r.review_notes ? ` — ${r.review_notes}` : ''}
                      </p>
                    )}
                  </div>

                  {r.status === 'pending' && (
                    <div className="flex w-full flex-col gap-2 sm:w-64">
                      <input
                        type="text"
                        placeholder="Note (optional)"
                        value={notes[r.attendance_id] ?? ''}
                        onChange={e => setNotes(n => ({ ...n, [r.attendance_id]: e.target.value }))}
                        maxLength={500}
                        className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800"
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          loading={review.isPending}
                          onClick={() => review.mutate({
                            id: r.attendance_id, action: 'approve', note: notes[r.attendance_id],
                          })}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={review.isPending}
                          onClick={() => review.mutate({
                            id: r.attendance_id, action: 'reject', note: notes[r.attendance_id],
                          })}
                        >
                          Dispute
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

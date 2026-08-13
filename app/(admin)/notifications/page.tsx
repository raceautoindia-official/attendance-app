'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Spinner from '@/components/ui/Spinner';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// Everything an admin should look at, day by day:
//
//   • clock-ins from away from the work site,
//   • attempts to do that which were REFUSED, and
//   • permission requests, with what was decided on them.
//
// Approving or disputing an off-site clock-in does NOT change anybody's
// attendance — that is stated on the page itself, because it is the thing most
// likely to be misunderstood.
// ---------------------------------------------------------------------------

type Decision = 'pending' | 'approved' | 'rejected' | 'none';

interface NotificationItem {
  id: string;
  kind: 'off_site_clock_in' | 'off_site_refused' | 'permission_request';
  employee_id: number;
  employee_name: string;
  emp_id: string;
  work_date: string;
  at_utc: string | null;
  decision: Decision;
  reviewed_at: string | null;
  reviewed_by_name: string | null;
  review_notes: string | null;
  attendance_id?: number;
  reason?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  distance_m?: number | null;
  radius_m?: number | null;
  accuracy_m?: number | null;
  location_name?: string | null;
  permission_id?: number;
  request_type?: string;
  start_time?: string;
  end_time?: string;
  minutes?: number;
}

interface DayGroup {
  work_date: string;
  items: NotificationItem[];
}

interface NotificationsData {
  days: DayGroup[];
  from_date: string;
  to_date: string;
  pending_count: number;
  totals: { off_site: number; refused: number; permission: number };
}

const IST = 'Asia/Kolkata';

function istTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-IN', {
    timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

function istDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    timeZone: IST, day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

/** "Wednesday, 13 August 2026" from a plain date, read in UTC so the label is
 *  the date itself rather than that date as seen from the browser's zone. */
function dayLabel(workDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) return workDate || 'Undated';
  return new Date(`${workDate}T12:00:00Z`).toLocaleDateString('en-IN', {
    timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

const DECISION_BADGE: Record<Exclude<Decision, 'none'>, 'warning' | 'success' | 'danger'> = {
  pending: 'warning', approved: 'success', rejected: 'danger',
};

const KIND_LABEL: Record<NotificationItem['kind'], string> = {
  off_site_clock_in: 'Off-site clock-in',
  off_site_refused: 'Clock-in refused',
  permission_request: 'Permission request',
};

const KIND_BADGE: Record<NotificationItem['kind'], 'warning' | 'danger' | 'info'> = {
  off_site_clock_in: 'warning',
  off_site_refused: 'danger',
  permission_request: 'info',
};

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export default function NotificationsPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('all');
  const [fromDate, setFromDate] = useState(isoDaysAgo(30));
  const [toDate, setToDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState<Record<number, string>>({});

  const { data, isLoading } = useQuery({
    queryKey: ['notifications', filter, fromDate, toDate],
    queryFn: async () => {
      const res = await fetch(
        `/api/notifications?status=${filter}&from_date=${fromDate}&to_date=${toDate}`,
      );
      return res.json() as Promise<ApiResponse<NotificationsData>>;
    },
    refetchInterval: 30_000,
  });
  const days = data?.data?.days ?? [];
  const totals = data?.data?.totals;

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
          Day by day: clock-ins from away from the work site, attempts that were refused,
          and permission requests with what was decided.
        </p>
      </div>

      <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-3">
        <p className="text-sm text-blue-800 dark:text-blue-300">
          <strong>An off-site clock-in&apos;s attendance is already counted.</strong> Approving or
          disputing one records what you think of the trip — it does not add or remove anybody&apos;s
          hours, and one nobody reviews still counts in full. To change someone&apos;s hours, edit the
          record in Checkin Records.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Input label="From" type="date" value={fromDate}
          onChange={e => setFromDate(e.target.value)} className="w-40" />
        <Input label="To" type="date" value={toDate}
          onChange={e => setToDate(e.target.value)} className="w-40" />
        <div className="flex gap-2">
          {(['all', 'pending', 'approved', 'rejected'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-lg px-3 py-2 text-sm font-medium capitalize transition-colors ${
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
      </div>

      {totals && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          In this period: {totals.off_site} off-site clock-in{totals.off_site === 1 ? '' : 's'},
          {' '}{totals.refused} refused attempt{totals.refused === 1 ? '' : 's'},
          {' '}{totals.permission} permission request{totals.permission === 1 ? '' : 's'}.
          {/* Filtering by decision hides refusals, which have none — say so
              rather than let the list look empty for no visible reason. */}
          {filter !== 'all' && totals.refused > 0 && (
            <> Refused attempts have no approve/reject decision — see <strong>all</strong>.</>
          )}
        </p>
      )}

      {review.isError && (
        <p className="text-sm text-red-500">{(review.error as Error).message}</p>
      )}

      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : days.length === 0 ? (
        <Card>
          <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
            {filter === 'all'
              ? 'Nothing in this period — no off-site clock-ins, no refused attempts, no permission requests.'
              : `Nothing ${filter} in this period.`}
          </p>
        </Card>
      ) : (
        <div className="space-y-6">
          {days.map(day => (
            <div key={day.work_date} className="space-y-3">
              <div className="flex items-baseline gap-3 border-b border-slate-200 dark:border-slate-700 pb-1.5">
                <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                  {dayLabel(day.work_date)}
                </h2>
                <span className="text-xs text-slate-400">
                  {day.items.length} item{day.items.length === 1 ? '' : 's'}
                </span>
              </div>

              {day.items.map(item => (
                <Card key={item.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-slate-800 dark:text-slate-200">
                          {item.employee_name}
                        </p>
                        <span className="text-xs text-slate-400">{item.emp_id}</span>
                        <Badge variant={KIND_BADGE[item.kind]}>{KIND_LABEL[item.kind]}</Badge>
                        {item.decision !== 'none' && (
                          <Badge variant={DECISION_BADGE[item.decision]}>{item.decision}</Badge>
                        )}
                      </div>

                      {item.kind === 'permission_request' ? (
                        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                          {item.request_type === 'on_duty' ? 'On-duty' : 'Permission'}
                          {' '}{item.start_time?.slice(0, 5)}–{item.end_time?.slice(0, 5)}
                          {' '}· {Math.floor((item.minutes ?? 0) / 60)}h {(item.minutes ?? 0) % 60}m
                          {' '}· applied {istDateTime(item.at_utc)}
                        </p>
                      ) : (
                        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                          {item.kind === 'off_site_refused' ? 'Tried at' : 'Clocked in'}
                          {' '}{istTime(item.at_utc)}
                          {item.distance_m != null && (
                            <> · <strong>{item.distance_m} m</strong> from
                              {' '}{item.location_name ?? 'their work site'}
                              {item.radius_m != null && <> (fence {item.radius_m} m)</>}
                            </>
                          )}
                          {/* A refusal at 60 m on a fix accurate to ±80 m is a
                              different conversation from one at 4 km. */}
                          {item.accuracy_m != null && (
                            <> · fix accurate to ±{Math.round(item.accuracy_m)} m</>
                          )}
                        </p>
                      )}

                      {item.reason && (
                        <p className="mt-2 rounded-md border-l-2 border-blue-500 bg-slate-50 px-3 py-2 text-sm text-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
                          {item.reason}
                        </p>
                      )}

                      {item.kind === 'off_site_clock_in' && !item.reason && (
                        <p className="mt-2 text-xs text-slate-400">
                          No reason recorded — an approved on-duty day, or a clock-in from before
                          reasons were kept.
                        </p>
                      )}

                      {item.kind === 'off_site_refused' && (
                        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                          They were <strong>not</strong> clocked in. If they are genuinely working
                          away today, approve an on-duty request for them.
                        </p>
                      )}

                      {item.latitude != null && item.longitude != null && (
                        <a
                          href={`https://www.google.com/maps?q=${item.latitude},${item.longitude}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-1.5 inline-block text-xs text-blue-600 hover:underline dark:text-blue-400"
                        >
                          See where they were ↗
                        </a>
                      )}

                      {item.decision !== 'none' && item.decision !== 'pending' && (
                        <p className="mt-2 text-xs text-slate-400">
                          {item.decision} by {item.reviewed_by_name ?? 'an admin'} on{' '}
                          {istDateTime(item.reviewed_at)}
                          {item.review_notes ? ` — ${item.review_notes}` : ''}
                        </p>
                      )}
                    </div>

                    {/* Only off-site clock-ins are reviewed here. A permission
                        request is decided on the Permissions page, where the
                        approval actually grants the hours — two buttons doing
                        different things under one label would be worse than a
                        link. */}
                    {item.kind === 'off_site_clock_in' && item.decision === 'pending'
                      && item.attendance_id != null && (
                      <div className="flex w-full flex-col gap-2 sm:w-64">
                        <input
                          type="text"
                          placeholder="Note (optional)"
                          value={notes[item.attendance_id] ?? ''}
                          onChange={e => setNotes(n => ({ ...n, [item.attendance_id!]: e.target.value }))}
                          maxLength={500}
                          className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800"
                        />
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            loading={review.isPending}
                            onClick={() => review.mutate({
                              id: item.attendance_id!, action: 'approve',
                              note: notes[item.attendance_id!],
                            })}
                          >
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={review.isPending}
                            onClick={() => review.mutate({
                              id: item.attendance_id!, action: 'reject',
                              note: notes[item.attendance_id!],
                            })}
                          >
                            Dispute
                          </Button>
                        </div>
                      </div>
                    )}

                    {item.kind === 'permission_request' && item.decision === 'pending' && (
                      <a
                        href="/permissions"
                        className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                      >
                        Decide in Permissions ↗
                      </a>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatInTimeZone } from 'date-fns-tz';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import Input from '@/components/ui/Input';
import Modal from '@/components/ui/Modal';
import Spinner from '@/components/ui/Spinner';
import { TIMEZONE } from '@/lib/constants';
import { formatDateOnly } from '@/lib/date';
import type {
  ApiResponse,
  PermissionBalance,
  PermissionRequest,
  PermissionRequestType,
  PermissionStatus,
} from '@/lib/types';

const STATUS_BADGE: Record<PermissionStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  approved: 'success',
  pending: 'warning',
  rejected: 'danger',
  cancelled: 'neutral',
};

function hm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** "09:30" → "09:30 am" for display. */
function clock12(t: string): string {
  const [h, m] = t.split(':').map(Number);
  if (Number.isNaN(h)) return t;
  const suffix = h < 12 ? 'am' : 'pm';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${suffix}`;
}

function diffMinutes(start: string, end: string): number | null {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  if ([sh, sm, eh, em].some(Number.isNaN)) return null;
  const diff = eh * 60 + em - (sh * 60 + sm);
  return diff > 0 ? diff : null;
}

/**
 * Employee self-service: apply for permission hours (a short paid absence in a
 * working day) and watch the monthly balance. Approved hours top the day's
 * worked time back up to the shift length.
 */
export default function PermissionHoursCard() {
  const qc = useQueryClient();
  const today = formatInTimeZone(new Date(), TIMEZONE, 'yyyy-MM-dd');
  const monthStart = `${today.slice(0, 7)}-01`;

  const [open, setOpen] = useState(false);
  const [requestType, setRequestType] = useState<PermissionRequestType>('permission');
  const [date, setDate] = useState(today);
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data: balanceData } = useQuery({
    queryKey: ['permissions', 'balance'],
    queryFn: async () => {
      const res = await fetch('/api/permissions/balance', { cache: 'no-store' });
      return res.json() as Promise<ApiResponse<PermissionBalance>>;
    },
  });

  const { data: listData, isLoading } = useQuery({
    queryKey: ['permissions', 'self', monthStart],
    queryFn: async () => {
      const params = new URLSearchParams({ from_date: monthStart, limit: '10', page: '1' });
      const res = await fetch(`/api/permissions?${params}`, { cache: 'no-store' });
      return res.json() as Promise<ApiResponse<{ permissions: PermissionRequest[] }>>;
    },
  });

  const balance = balanceData?.data;
  const requests = listData?.data?.permissions ?? [];

  const duration = useMemo(
    () => (startTime && endTime ? diffMinutes(startTime, endTime) : null),
    [startTime, endTime],
  );

  function resetForm() {
    setRequestType('permission');
    setDate(today);
    setStartTime('');
    setEndTime('');
    setReason('');
    setError(null);
  }

  const isOnDuty = requestType === 'on_duty';

  const applyMutation = useMutation({
    mutationFn: async () => {
      setError(null);
      const res = await fetch('/api/permissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_type: requestType,
          permission_date: date,
          start_time: startTime,
          end_time: endTime,
          reason: reason.trim() || null,
        }),
      });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Failed to apply');
      return json;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['permissions'] });
      qc.invalidateQueries({ queryKey: ['attendance'] });
      setOpen(false);
      resetForm();
    },
    onError: (err: Error) => setError(err.message),
  });

  const cancelMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/permissions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' }),
      });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Failed to cancel');
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['permissions'] }),
  });

  function submit() {
    if (!date) return setError('Pick a date');
    if (!startTime || !endTime) return setError('Enter both the start and end time');
    if (duration === null) return setError('End time must be later than the start time');
    if (balance && duration < balance.min_minutes_per_request) {
      return setError(`Must be at least ${hm(balance.min_minutes_per_request)}`);
    }
    // On duty is work, not time off — no per-request cap and no monthly quota.
    if (!isOnDuty && balance) {
      if (duration > balance.max_minutes_per_request) {
        return setError(`A single permission cannot exceed ${hm(balance.max_minutes_per_request)}`);
      }
      if (duration > balance.remaining_minutes) {
        return setError(
          balance.remaining_minutes <= 0
            ? 'You have used up this month\'s permission hours'
            : `Only ${hm(balance.remaining_minutes)} left this month`,
        );
      }
    }
    applyMutation.mutate();
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
            Permission Hours
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Short time off inside a working day. Approved hours count towards your day&apos;s hours.
          </p>
        </div>
        <Button size="sm" onClick={() => { resetForm(); setOpen(true); }}>Apply</Button>
      </div>

      {balance && (
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div>
            <p className="text-xs text-slate-500 dark:text-slate-400">Left this month</p>
            <p className="text-lg font-bold text-slate-800 dark:text-slate-200 mt-0.5">
              {hm(balance.remaining_minutes)}
              <span className="text-xs font-normal text-slate-400"> / {hm(balance.monthly_limit_minutes)}</span>
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500 dark:text-slate-400">Approved</p>
            <p className="text-lg font-bold text-slate-800 dark:text-slate-200 mt-0.5">
              {hm(balance.used_minutes)}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500 dark:text-slate-400">Awaiting approval</p>
            <p className="text-lg font-bold text-slate-800 dark:text-slate-200 mt-0.5">
              {hm(balance.pending_minutes)}
            </p>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-4"><Spinner /></div>
      ) : requests.length === 0 ? (
        <p className="text-sm text-slate-400 italic">No permission requests this month.</p>
      ) : (
        <div className="divide-y divide-slate-100 dark:divide-slate-700/50 -mx-1">
          {requests.map(r => (
            <div key={r.id} className="flex items-center justify-between gap-3 px-1 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-800 dark:text-slate-200 tabular-nums">
                  {formatDateOnly(r.permission_date)}
                  <span className="text-slate-400 font-normal">
                    {' · '}{clock12(r.start_time.slice(0, 5))} – {clock12(r.end_time.slice(0, 5))}
                  </span>
                  {r.request_type === 'on_duty' && (
                    <span className="ml-2 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
                      On duty
                    </span>
                  )}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                  {hm(Number(r.minutes))}
                  {r.reason ? ` · ${r.reason}` : ''}
                  {r.status === 'rejected' && r.review_notes ? ` · ${r.review_notes}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge variant={STATUS_BADGE[r.status]}>{r.status}</Badge>
                {r.status === 'pending' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={cancelMutation.isPending}
                    onClick={() => cancelMutation.mutate(r.id)}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Apply for Time Off or On-Duty">
        <div className="space-y-4">
          {/* The two are handled very differently, so make the choice explicit. */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {([
              ['permission', 'Permission (time off)', 'Personal time away — bank, doctor. Uses your monthly quota and tops your day back up.'],
              ['on_duty', 'On duty (office work outside)', 'Working away from the site. Does not use your quota, and you stay clocked in when you leave the fence.'],
            ] as const).map(([key, title, blurb]) => (
              <button
                key={key}
                type="button"
                onClick={() => setRequestType(key)}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  requestType === key
                    ? 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-900/20'
                    : 'border-slate-300 hover:border-slate-400 dark:border-slate-600'
                }`}
              >
                <p className="text-sm font-medium text-slate-800 dark:text-slate-200">{title}</p>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{blurb}</p>
              </button>
            ))}
          </div>

          {isOnDuty && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-400">
              Until an admin approves this, leaving the work site will still clock you out
              automatically.
            </p>
          )}

          <Input
            label="Date"
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="From (IST)"
              type="time"
              value={startTime}
              onChange={e => setStartTime(e.target.value)}
            />
            <Input
              label="To (IST)"
              type="time"
              value={endTime}
              onChange={e => setEndTime(e.target.value)}
            />
          </div>

          {duration !== null && (
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Duration: <span className="font-semibold">{hm(duration)}</span>
              {!isOnDuty && balance && (
                <span className="text-slate-400">
                  {' '}· {hm(balance.remaining_minutes)} left this month
                </span>
              )}
              {isOnDuty && <span className="text-slate-400"> · does not use your quota</span>}
            </p>
          )}

          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Reason</label>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="Bank work, doctor visit…"
              className="block w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="button" loading={applyMutation.isPending} onClick={submit}>
              Submit for Approval
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

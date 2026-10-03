'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatInTimeZone } from 'date-fns-tz';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import Input from '@/components/ui/Input';
import Modal from '@/components/ui/Modal';
import Pagination from '@/components/ui/Pagination';
import Spinner from '@/components/ui/Spinner';
import Table from '@/components/ui/Table';
import { formatDateOnly } from '@/lib/date';
import type {
  ApiResponse,
  Employee,
  PermissionRequest,
  PermissionStatus,
} from '@/lib/types';

const TZ = 'Asia/Kolkata';

const STATUS_BADGE: Record<PermissionStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  approved: 'success',
  pending: 'warning',
  rejected: 'danger',
  cancelled: 'neutral',
};

const STATUS_TABS: Array<[PermissionStatus | 'all', string]> = [
  ['pending', 'Pending'],
  ['approved', 'Approved'],
  ['rejected', 'Rejected'],
  ['all', 'All'],
];

const selectClass =
  'block w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';

function hm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

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
 * Admin queue for permission hours: approve or reject what employees applied
 * for, and file a permission on someone's behalf (recorded already approved).
 */
export default function PermissionsPage() {
  const qc = useQueryClient();
  const today = formatInTimeZone(new Date(), TZ, 'yyyy-MM-dd');
  const monthStart = `${today.slice(0, 7)}-01`;

  const [status, setStatus] = useState<PermissionStatus | 'all'>('pending');
  const [fromDate, setFromDate] = useState(monthStart);
  const [toDate, setToDate] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [page, setPage] = useState(1);

  // Reject-with-note modal
  const [rejectTarget, setRejectTarget] = useState<PermissionRequest | null>(null);
  const [rejectNote, setRejectNote] = useState('');

  // File-on-behalf modal
  const [addOpen, setAddOpen] = useState(false);
  const [formEmployeeId, setFormEmployeeId] = useState('');
  const [formDate, setFormDate] = useState(today);
  const [formStart, setFormStart] = useState('');
  const [formEnd, setFormEnd] = useState('');
  const [formReason, setFormReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const { data: empData } = useQuery({
    queryKey: ['employees', 'all'],
    queryFn: async () => {
      const res = await fetch('/api/employees?limit=200');
      return res.json() as Promise<ApiResponse<{ employees: Employee[] }>>;
    },
  });
  const employees = empData?.data?.employees ?? [];

  const { data, isLoading } = useQuery({
    queryKey: ['permissions', 'admin', { status, fromDate, toDate, employeeId, page }],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), limit: '25' });
      if (status !== 'all') params.set('status', status);
      if (fromDate) params.set('from_date', fromDate);
      if (toDate) params.set('to_date', toDate);
      if (employeeId) params.set('employee_id', employeeId);
      const res = await fetch(`/api/permissions?${params}`, { cache: 'no-store' });
      return res.json() as Promise<ApiResponse<{
        permissions: PermissionRequest[];
        pagination: { total: number; totalPages: number };
        pending_count: number;
        migration_pending?: boolean;
        /** Approved minutes per employee over the whole filter, not this page. */
        employee_totals?: Array<{
          employee_id: number;
          employee_name: string;
          emp_id: string;
          approved_minutes: number;
          approved_count: number;
          pending_count: number;
          rejected_count: number;
        }>;
      }>>;
    },
  });

  const rows = data?.data?.permissions ?? [];
  const employeeTotals = data?.data?.employee_totals ?? [];
  const pagination = data?.data?.pagination;
  const pendingCount = data?.data?.pending_count ?? 0;
  const migrationPending = data?.data?.migration_pending === true;

  const reviewMutation = useMutation({
    mutationFn: async ({
      id,
      action,
      review_notes,
      revise,
    }: {
      id: number; action: 'approve' | 'reject'; review_notes?: string;
      /** Changing a decision that was already made, rather than making one. */
      revise?: boolean;
    }) => {
      const res = await fetch(`/api/permissions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, review_notes: review_notes ?? null, revise: revise ?? false }),
      });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Failed');
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['permissions'] });
      qc.invalidateQueries({ queryKey: ['attendance'] });
      qc.invalidateQueries({ queryKey: ['reports'] });
      setRejectTarget(null);
      setRejectNote('');
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      setFormError(null);
      const res = await fetch('/api/permissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employee_id: Number(formEmployeeId),
          permission_date: formDate,
          start_time: formStart,
          end_time: formEnd,
          reason: formReason.trim() || null,
        }),
      });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Failed to record permission');
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['permissions'] });
      qc.invalidateQueries({ queryKey: ['attendance'] });
      setAddOpen(false);
      setFormEmployeeId('');
      setFormStart('');
      setFormEnd('');
      setFormReason('');
    },
    onError: (err: Error) => setFormError(err.message),
  });

  const formDuration = useMemo(
    () => (formStart && formEnd ? diffMinutes(formStart, formEnd) : null),
    [formStart, formEnd],
  );

  function submitOnBehalf() {
    if (!formEmployeeId) return setFormError('Select an employee');
    if (!formDate) return setFormError('Pick a date');
    if (!formStart || !formEnd) return setFormError('Enter both the start and end time');
    if (formDuration === null) return setFormError('End time must be later than the start time');
    createMutation.mutate();
  }

  return (
    <div className="space-y-4">
      {migrationPending && (
        <Card>
          <p className="text-sm text-amber-700 dark:text-amber-300">
            Permission hours are not set up yet. Run the migration
            {' '}<code className="text-xs">database/migrations/2026-08-04_add_permission_requests.sql</code>.
          </p>
        </Card>
      )}

      {/* Status tabs */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-lg bg-slate-100 dark:bg-slate-800 p-1 w-fit">
          {STATUS_TABS.map(([key, label]) => (
            <button
              key={key}
              onClick={() => { setStatus(key); setPage(1); }}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                status === key
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
              }`}
            >
              {label}
              {key === 'pending' && pendingCount > 0 && (
                <span className="ml-2 inline-flex items-center justify-center rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold text-white">
                  {pendingCount}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="sm:ml-auto">
          <Button onClick={() => { setFormError(null); setAddOpen(true); }}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Record Permission
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-end">
        <Input label="From" type="date" value={fromDate} onChange={e => { setFromDate(e.target.value); setPage(1); }} className="w-36" />
        <Input label="To" type="date" value={toDate} onChange={e => { setToDate(e.target.value); setPage(1); }} className="w-36" />
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Employee</label>
          <select
            value={employeeId}
            onChange={e => { setEmployeeId(e.target.value); setPage(1); }}
            className={`${selectClass} w-56`}
          >
            <option value="">All employees</option>
            {employees.map(e => <option key={e.id} value={e.id}>{e.name} ({e.emp_id})</option>)}
          </select>
        </div>
      </div>

      {/* TOTAL PERMISSION HOURS PER EMPLOYEE, over whatever filter is set.
          The list below is a page of individual requests and never answered
          "how much has this person taken", which is the question a month-end
          review actually asks. Only APPROVED minutes count: a pending or
          rejected request is not time anybody has had. */}
      {!isLoading && employeeTotals.length > 0 && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
          <div className="px-4 py-2.5 bg-slate-50 dark:bg-slate-900/60 border-b border-slate-200 dark:border-slate-700">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Permission hours taken — approved only, for this filter
            </p>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-700/50">
            {employeeTotals.map(t => (
              <div key={t.employee_id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                <div className="min-w-0">
                  <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
                    {t.employee_name}
                  </span>
                  <span className="ml-2 text-xs text-slate-400">{t.emp_id}</span>
                </div>
                <div className="flex items-center gap-4 text-xs">
                  <span className="tabular-nums font-semibold text-blue-600 dark:text-blue-400">
                    {Math.floor(t.approved_minutes / 60)}h {t.approved_minutes % 60}m
                  </span>
                  <span className="text-slate-400 tabular-nums">
                    {t.approved_count} approved
                    {t.pending_count > 0 && ` · ${t.pending_count} pending`}
                    {t.rejected_count > 0 && ` · ${t.rejected_count} rejected`}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : (
        <>
          <Table
            columns={[
              {
                key: 'employee_name',
                header: 'Employee',
                render: r => (
                  <div>
                    <p className="font-medium text-slate-800 dark:text-slate-200">
                      {(r as PermissionRequest).employee_name ?? '—'}
                    </p>
                    <p className="text-xs text-slate-400">{(r as PermissionRequest).employee_emp_id}</p>
                  </div>
                ),
              },
              {
                key: 'request_type',
                header: 'Type',
                render: r => {
                  const onDuty = (r as PermissionRequest).request_type === 'on_duty';
                  return (
                    <div>
                      <Badge variant={onDuty ? 'info' : 'neutral'}>
                        {onDuty ? 'On duty' : 'Permission'}
                      </Badge>
                      <p className="mt-1 text-xs text-slate-400">
                        {onDuty ? 'Working outside — stays clocked in' : 'Time off — tops up hours'}
                      </p>
                    </div>
                  );
                },
              },
              {
                key: 'permission_date',
                header: 'Date',
                render: r => {
                  const row = r as PermissionRequest;
                  const late = Number(row.days_late ?? 0);
                  return (
                    <div>
                      <span>{formatDateOnly(row.permission_date)}</span>
                      {/* Claimed after the fact — the approver should weigh that
                          rather than have to compare the dates themselves. */}
                      {Boolean(row.is_backdated) && (
                        <span className="block text-xs text-amber-600 dark:text-amber-400">
                          filed {late} day{late === 1 ? '' : 's'} later
                        </span>
                      )}
                    </div>
                  );
                },
              },
              {
                key: 'start_time',
                header: 'Time (IST)',
                render: r => {
                  const row = r as PermissionRequest;
                  return `${clock12(row.start_time.slice(0, 5))} – ${clock12(row.end_time.slice(0, 5))}`;
                },
              },
              {
                key: 'minutes',
                header: 'Duration',
                render: r => hm(Number((r as PermissionRequest).minutes)),
              },
              {
                key: 'reason',
                header: 'Reason',
                render: r => (r as PermissionRequest).reason ?? '—',
              },
              {
                key: 'status',
                header: 'Status',
                render: r => {
                  const row = r as PermissionRequest;
                  return (
                    <div>
                      <Badge variant={STATUS_BADGE[row.status]}>{row.status}</Badge>
                      {row.reviewed_by_name && row.status !== 'pending' && (
                        <p className="text-xs text-slate-400 mt-1">by {row.reviewed_by_name}</p>
                      )}
                      {row.review_notes && (
                        <p className="text-xs text-slate-400 mt-0.5">{row.review_notes}</p>
                      )}
                    </div>
                  );
                },
              },
              {
                key: 'actions',
                header: '',
                render: r => {
                  const row = r as PermissionRequest;
                  if (row.status === 'pending') {
                    return (
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          loading={reviewMutation.isPending}
                          onClick={() => reviewMutation.mutate({ id: row.id, action: 'approve' })}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => { setRejectTarget(row); setRejectNote(''); }}
                        >
                          Reject
                        </Button>
                      </div>
                    );
                  }
                  // CHANGING A DECISION. A verdict used to be final: a mistaken
                  // rejection could only be fixed by the employee applying
                  // again, and a mistaken approval could not be taken back at
                  // all. Approved hours count towards the day, so being unable
                  // to correct one is a real problem, not a tidiness one.
                  //
                  // A cancelled request is the employee's own withdrawal, not a
                  // verdict, so there is nothing here to change.
                  if (row.status === 'approved' || row.status === 'rejected') {
                    const flip = row.status === 'approved' ? 'reject' : 'approve';
                    return (
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={reviewMutation.isPending}
                        onClick={() => {
                          if (!confirm(
                            `Change this from ${row.status} to ${flip === 'approve' ? 'approved' : 'rejected'}?`
                            + (flip === 'reject'
                              ? '\n\nThe hours it credited will be taken off the day.'
                              : '\n\nIt will credit hours towards that day.'),
                          )) return;
                          reviewMutation.mutate({ id: row.id, action: flip, revise: true });
                        }}
                      >
                        Change to {flip === 'approve' ? 'approved' : 'rejected'}
                      </Button>
                    );
                  }
                  return <span className="text-slate-400">—</span>;
                },
              },
            ]}
            data={rows as object[]}
            emptyMessage="No permission requests for this filter."
          />

          {reviewMutation.isError && (
            <p className="text-sm text-red-500">{(reviewMutation.error as Error).message}</p>
          )}

          {pagination && pagination.totalPages > 1 && (
            <Pagination page={page} totalPages={pagination.totalPages} onPageChange={setPage} />
          )}
        </>
      )}

      {/* Reject modal */}
      <Modal open={!!rejectTarget} onClose={() => setRejectTarget(null)} title="Reject Permission Request">
        {rejectTarget && (
          <div className="space-y-4">
            <div className="text-sm text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-700/50 rounded-lg px-3 py-2">
              <span className="font-medium text-slate-700 dark:text-slate-300">{rejectTarget.employee_name}</span>
              {' — '}{formatDateOnly(rejectTarget.permission_date)}
              {' · '}{clock12(rejectTarget.start_time.slice(0, 5))} – {clock12(rejectTarget.end_time.slice(0, 5))}
              {' · '}{hm(Number(rejectTarget.minutes))}
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Reason (shown to the employee)</label>
              <textarea
                value={rejectNote}
                onChange={e => setRejectNote(e.target.value)}
                rows={2}
                maxLength={500}
                className="block w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            {reviewMutation.isError && (
              <p className="text-sm text-red-500">{(reviewMutation.error as Error).message}</p>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="secondary" onClick={() => setRejectTarget(null)}>Cancel</Button>
              <Button
                type="button"
                variant="danger"
                loading={reviewMutation.isPending}
                onClick={() => reviewMutation.mutate({
                  id: rejectTarget.id,
                  action: 'reject',
                  review_notes: rejectNote.trim() || undefined,
                })}
              >
                Reject
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Record on behalf modal */}
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Record Permission Hours">
        <div className="space-y-4">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Filed on an employee&apos;s behalf — recorded as already approved.
          </p>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Employee</label>
            <select value={formEmployeeId} onChange={e => setFormEmployeeId(e.target.value)} className={selectClass}>
              <option value="">Select employee…</option>
              {employees.map(e => <option key={e.id} value={e.id}>{e.name} ({e.emp_id})</option>)}
            </select>
          </div>

          <Input label="Date" type="date" value={formDate} onChange={e => setFormDate(e.target.value)} />

          <div className="grid grid-cols-2 gap-3">
            <Input label="From (IST)" type="time" value={formStart} onChange={e => setFormStart(e.target.value)} />
            <Input label="To (IST)" type="time" value={formEnd} onChange={e => setFormEnd(e.target.value)} />
          </div>

          {formDuration !== null && (
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Duration: <span className="font-semibold">{hm(formDuration)}</span>
            </p>
          )}

          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Reason</label>
            <textarea
              value={formReason}
              onChange={e => setFormReason(e.target.value)}
              rows={2}
              maxLength={500}
              className="block w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {formError && <p className="text-sm text-red-500">{formError}</p>}

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button type="button" loading={createMutation.isPending} onClick={submitOnBehalf}>
              Record & Approve
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

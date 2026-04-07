'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import Table from '@/components/ui/Table';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Modal from '@/components/ui/Modal';
import Badge from '@/components/ui/Badge';
import Pagination from '@/components/ui/Pagination';
import Spinner from '@/components/ui/Spinner';
import type { AttendanceRecord, AttendanceStatus, ApiResponse } from '@/lib/types';

type AttRow = AttendanceRecord & { employee_name?: string; emp_id?: string };

const STATUS_BADGE: Record<AttendanceStatus, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  present: 'success', late: 'warning', absent: 'danger',
  early_departure: 'warning', leave: 'info', holiday: 'info',
};

const IST_LOCALE = 'en-IN';
const TZ = 'Asia/Kolkata';

function toIST(d: Date | string | null | undefined) {
  if (!d) return '—';
  return new Date(d).toLocaleTimeString(IST_LOCALE, { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: true });
}
function toISOLocal(d: Date | string | null | undefined) {
  if (!d) return '';
  const dt = new Date(d);
  return format(dt, "yyyy-MM-dd'T'HH:mm");
}

const editSchema = z.object({
  clock_in_utc: z.string().optional(),
  clock_out_utc: z.string().optional(),
  status: z.enum(['present', 'late', 'absent', 'early_departure', 'leave', 'holiday']),
  notes: z.string().max(500).optional(),
});
type EditForm = z.infer<typeof editSchema>;

const selectClass = 'block w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';

export default function AttendancePage() {
  const qc = useQueryClient();
  const today = format(new Date(), 'yyyy-MM-dd');
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [empSearch, setEmpSearch] = useState('');
  const [page, setPage] = useState(1);
  const [editTarget, setEditTarget] = useState<AttRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['attendance', { fromDate, toDate, empSearch, page }],
    queryFn: async () => {
      const params = new URLSearchParams({ from_date: fromDate, to_date: toDate, page: String(page), limit: '25' });
      if (empSearch) params.set('employee_search', empSearch);
      const res = await fetch(`/api/attendance?${params}`);
      return res.json() as Promise<ApiResponse<{ records: AttRow[]; pagination: { total: number; totalPages: number } }>>;
    },
  });

  const records = data?.data?.records ?? [];
  const pagination = data?.data?.pagination;

  const editForm = useForm<EditForm>({ resolver: zodResolver(editSchema) });

  const editMutation = useMutation({
    mutationFn: async ({ id, values }: { id: number; values: EditForm }) => {
      const body: Record<string, unknown> = { status: values.status, notes: values.notes };
      if (values.clock_in_utc) body.clock_in_utc = new Date(values.clock_in_utc).toISOString();
      if (values.clock_out_utc) body.clock_out_utc = new Date(values.clock_out_utc).toISOString();
      const res = await fetch(`/api/attendance/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Failed');
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['attendance'] }); setEditTarget(null); },
  });

  function openEdit(row: AttRow) {
    setEditTarget(row);
    editForm.reset({
      clock_in_utc: toISOLocal(row.clock_in_utc),
      clock_out_utc: toISOLocal(row.clock_out_utc),
      status: row.status,
      notes: row.notes ?? '',
    });
  }

  function mapsLink(lat?: number | null, lng?: number | null) {
    if (!lat || !lng) return null;
    return `https://www.google.com/maps?q=${lat},${lng}`;
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-end">
        <Input label="From" type="date" value={fromDate} onChange={e => { setFromDate(e.target.value); setPage(1); }} className="w-36" />
        <Input label="To" type="date" value={toDate} onChange={e => { setToDate(e.target.value); setPage(1); }} className="w-36" />
        <Input
          label="Employee"
          placeholder="Search name…"
          value={empSearch}
          onChange={e => { setEmpSearch(e.target.value); setPage(1); }}
          className="sm:w-48"
        />
      </div>

      {/* Table */}
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
                    <p className="font-medium text-slate-800 dark:text-slate-200">{(r as AttRow).employee_name ?? '—'}</p>
                    <p className="text-xs text-slate-400">{(r as AttRow).emp_id}</p>
                  </div>
                ),
              },
              { key: 'work_date', header: 'Date' },
              { key: 'clock_in_utc', header: 'In (IST)', render: r => toIST((r as AttRow).clock_in_utc) },
              { key: 'clock_out_utc', header: 'Out (IST)', render: r => toIST((r as AttRow).clock_out_utc) },
              {
                key: 'total_minutes',
                header: 'Hours',
                render: r => {
                  const m = (r as AttRow).total_minutes;
                  return m != null ? `${Math.floor(m / 60)}h ${m % 60}m` : '—';
                },
              },
              {
                key: 'status',
                header: 'Status',
                render: r => <Badge variant={STATUS_BADGE[(r as AttRow).status]}>{(r as AttRow).status.replace('_', ' ')}</Badge>,
              },
              {
                key: 'clock_in_lat',
                header: 'Location',
                render: r => {
                  const link = mapsLink((r as AttRow).clock_in_lat, (r as AttRow).clock_in_lng);
                  if (!link) return <span className="text-slate-400">—</span>;
                  return (
                    <a href={link} target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline text-xs">
                      View map ↗
                    </a>
                  );
                },
              },
              {
                key: 'actions',
                header: '',
                render: r => (
                  <Button size="sm" variant="ghost" onClick={() => openEdit(r as AttRow)}>Edit</Button>
                ),
              },
            ]}
            data={records as object[]}
            emptyMessage="No attendance records for the selected date range."
          />

          {pagination && pagination.totalPages > 1 && (
            <Pagination page={page} totalPages={pagination.totalPages} onPageChange={setPage} />
          )}
        </>
      )}

      {/* Edit modal */}
      <Modal open={!!editTarget} onClose={() => setEditTarget(null)} title="Edit Attendance Record">
        {editTarget && (
          <form onSubmit={editForm.handleSubmit(v => editMutation.mutate({ id: editTarget.id, values: v }))} className="space-y-4">
            <div className="text-sm text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-700/50 rounded-lg px-3 py-2">
              <span className="font-medium text-slate-700 dark:text-slate-300">{editTarget.employee_name}</span>
              {' — '}{editTarget.work_date}
            </div>

            <Input label="Clock In (UTC)" type="datetime-local" {...editForm.register('clock_in_utc')} />
            <Input label="Clock Out (UTC)" type="datetime-local" {...editForm.register('clock_out_utc')} />

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Status</label>
              <select {...editForm.register('status')} className={selectClass}>
                {(['present', 'late', 'absent', 'early_departure', 'leave', 'holiday'] as AttendanceStatus[]).map(s => (
                  <option key={s} value={s}>{s.replace('_', ' ')}</option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Notes</label>
              <textarea
                {...editForm.register('notes')}
                rows={2}
                className="block w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {editMutation.isError && (
              <p className="text-sm text-red-500">{(editMutation.error as Error).message}</p>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="secondary" onClick={() => setEditTarget(null)}>Cancel</Button>
              <Button type="submit" loading={editMutation.isPending}>Save</Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}

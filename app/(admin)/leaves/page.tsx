'use client';

import { useState } from 'react';
import { useForm, useWatch, type Resolver } from 'react-hook-form';
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
import type { Employee, ApiResponse } from '@/lib/types';
import { formatDateOnly } from '@/lib/date';

interface LeaveRow {
  id: number;
  employee_id: number | null;
  leave_date: string;
  leave_type: string;
  notes: string | null;
  employee_name: string | null;
  employee_emp_id: string | null;
}

const LEAVE_BADGE: Record<string, 'info' | 'success' | 'warning' | 'danger' | 'neutral'> = {
  casual: 'info', sick: 'warning', earned: 'success', holiday: 'neutral', other: 'neutral',
};

const leaveSchema = z.object({
  employee_id: z.preprocess(
    value => (value === '' || value === null || value === undefined ? undefined : value),
    z.coerce.number().int().positive().optional(),
  ),
  leave_date: z.string().min(1, 'Required'),
  leave_type: z.preprocess(
    value => (value === '' || value === null || value === undefined ? undefined : value),
    z.enum(['casual', 'sick', 'earned', 'holiday', 'other']).optional(),
  ),
  notes: z.string().max(500).optional(),
  is_holiday: z.preprocess(
    value => value === true || value === 'true' || value === 'on',
    z.boolean(),
  ).default(false),
}).superRefine((data, ctx) => {
  if (!data.is_holiday && !data.employee_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['employee_id'],
      message: 'Please select an employee',
    });
  }
  if (!data.is_holiday && !data.leave_type) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['leave_type'],
      message: 'Please select a leave type',
    });
  }
});
type LeaveForm = z.infer<typeof leaveSchema>;

const selectClass = 'block w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';

export default function LeavesPage() {
  const qc = useQueryClient();
  const today = format(new Date(), 'yyyy-MM-dd');
  const firstOfMonth = format(new Date(new Date().getFullYear(), new Date().getMonth(), 1), 'yyyy-MM-dd');

  const [fromDate, setFromDate] = useState(firstOfMonth);
  const [toDate, setToDate] = useState(today);
  const [page, setPage] = useState(1);
  const [addOpen, setAddOpen] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['leaves', { fromDate, toDate, page }],
    queryFn: async () => {
      const params = new URLSearchParams({ from_date: fromDate, to_date: toDate, page: String(page), limit: '25' });
      const res = await fetch(`/api/leaves?${params}`);
      return res.json() as Promise<ApiResponse<{ leaves: LeaveRow[]; pagination: { total: number; totalPages: number } }>>;
    },
  });

  const { data: empData } = useQuery({
    queryKey: ['employees', 'all'],
    queryFn: async () => {
      const res = await fetch('/api/employees?limit=200');
      return res.json() as Promise<ApiResponse<{ employees: Employee[] }>>;
    },
  });

  const leaves = data?.data?.leaves ?? [];
  const pagination = data?.data?.pagination;
  const employees = empData?.data?.employees ?? [];

  const form = useForm<LeaveForm>({
    resolver: zodResolver(leaveSchema) as unknown as Resolver<LeaveForm>,
    defaultValues: { leave_type: 'casual', is_holiday: false, leave_date: today },
    shouldUnregister: true,
  });
  const isHoliday = useWatch({ control: form.control, name: 'is_holiday' }) ?? false;

  const createMutation = useMutation({
    mutationFn: async (values: LeaveForm) => {
      setSubmitError(null);
      const normalizedDate = values.leave_date.includes('-') && values.leave_date.length === 10
        ? (values.leave_date.match(/^\d{2}-\d{2}-\d{4}$/)
          ? `${values.leave_date.slice(6, 10)}-${values.leave_date.slice(3, 5)}-${values.leave_date.slice(0, 2)}`
          : values.leave_date)
        : values.leave_date;
      const body: Record<string, unknown> = {
        leave_date: normalizedDate,
        leave_type: values.is_holiday ? 'holiday' : values.leave_type,
        notes: values.notes,
      };
      if (!values.is_holiday && values.employee_id) body.employee_id = values.employee_id;
      const res = await fetch('/api/leaves', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let message = `Request failed (${res.status})`;
        try {
          const json = await res.json() as ApiResponse;
          message = json.error ?? message;
        } catch {}
        throw new Error(message);
      }
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Failed');
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['leaves'] }); setAddOpen(false); form.reset(); setSubmitError(null); },
    onError: (error) => {
      setSubmitError(error instanceof Error ? error.message : 'Failed to save leave/holiday');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/leaves/${id}`, { method: 'DELETE' });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Failed');
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['leaves'] }),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-end">
        <Input label="From" type="date" value={fromDate} onChange={e => { setFromDate(e.target.value); setPage(1); }} className="w-36" />
        <Input label="To" type="date" value={toDate} onChange={e => { setToDate(e.target.value); setPage(1); }} className="w-36" />
        <div className="sm:ml-auto">
          <Button onClick={() => setAddOpen(true)}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Mark Leave / Holiday
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : (
        <>
          <Table
            columns={[
              { key: 'leave_date', header: 'Date', render: r => formatDateOnly((r as LeaveRow).leave_date) },
              {
                key: 'employee_name',
                header: 'Employee',
                render: r => (r as LeaveRow).employee_id === null
                  ? <Badge variant="neutral">All Employees (Holiday)</Badge>
                  : (
                    <div>
                      <p className="font-medium">{(r as LeaveRow).employee_name ?? '—'}</p>
                      <p className="text-xs text-slate-400">{(r as LeaveRow).employee_emp_id}</p>
                    </div>
                  ),
              },
              {
                key: 'leave_type',
                header: 'Type',
                render: r => (
                  <Badge variant={LEAVE_BADGE[(r as LeaveRow).leave_type] ?? 'neutral'}>
                    {(r as LeaveRow).leave_type}
                  </Badge>
                ),
              },
              { key: 'notes', header: 'Notes', render: r => (r as LeaveRow).notes ?? '—' },
              {
                key: 'actions',
                header: '',
                render: r => (
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => { if (confirm('Delete this leave record?')) deleteMutation.mutate((r as LeaveRow).id); }}
                  >
                    Delete
                  </Button>
                ),
              },
            ]}
            data={leaves as object[]}
            emptyMessage="No leave records for the selected period."
          />

          {pagination && pagination.totalPages > 1 && (
            <Pagination page={page} totalPages={pagination.totalPages} onPageChange={setPage} />
          )}
        </>
      )}

      {/* Add leave modal */}
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Mark Leave or Holiday">
        <form
          onSubmit={form.handleSubmit(
            (v: LeaveForm) => createMutation.mutate(v),
            (errors) => {
              const firstError = Object.values(errors)[0];
              setSubmitError(firstError?.message?.toString() ?? 'Please fill required fields');
            },
          )}
          className="space-y-4"
        >
          <label className="flex items-center gap-2 cursor-pointer p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700">
            <input type="checkbox" {...form.register('is_holiday')} className="w-4 h-4 rounded border-slate-300 text-blue-600" />
            <div>
              <p className="text-sm font-medium text-amber-800 dark:text-amber-300">Company-wide Holiday</p>
              <p className="text-xs text-amber-600 dark:text-amber-400">Marks this day as a holiday for ALL active employees</p>
            </div>
          </label>

          {!isHoliday && (
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Employee</label>
              <select {...form.register('employee_id')} className={selectClass}>
                <option value="">Select employee…</option>
                {employees.map(e => <option key={e.id} value={e.id}>{e.name} ({e.emp_id})</option>)}
              </select>
              {form.formState.errors.employee_id?.message && (
                <p className="text-sm text-red-500">{form.formState.errors.employee_id.message}</p>
              )}
            </div>
          )}

          <Input label="Date" type="date" {...form.register('leave_date')}
            error={form.formState.errors.leave_date?.message} />

          {!isHoliday && (
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Leave Type</label>
              <select {...form.register('leave_type')} className={selectClass}>
                <option value="casual">Casual</option>
                <option value="sick">Sick</option>
                <option value="earned">Earned</option>
                <option value="other">Other</option>
              </select>
              {form.formState.errors.leave_type?.message && (
                <p className="text-sm text-red-500">{form.formState.errors.leave_type.message}</p>
              )}
            </div>
          )}

          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Notes (optional)</label>
            <textarea
              {...form.register('notes')}
              rows={2}
              className="block w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {(submitError || createMutation.isError) && (
            <p className="text-sm text-red-500">{submitError ?? (createMutation.error as Error).message}</p>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button type="submit" loading={createMutation.isPending}>
              {isHoliday ? 'Mark Holiday' : 'Mark Leave'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

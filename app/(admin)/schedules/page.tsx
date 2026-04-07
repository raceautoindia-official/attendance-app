'use client';

import { useState } from 'react';
import { useForm, useWatch, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Table from '@/components/ui/Table';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Modal from '@/components/ui/Modal';
import Badge from '@/components/ui/Badge';
import Spinner from '@/components/ui/Spinner';
import type { Shift, Employee, Location, ApiResponse } from '@/lib/types';
import { useCurrentUser } from '@/lib/useCurrentUser';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const shiftSchema = z.object({
  name: z.string().min(1, 'Required'),
  type: z.enum(['fixed', 'flexible', 'rotating']),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  required_hours: z.coerce.number().min(1).max(24).optional(),
  grace_minutes: z.coerce.number().min(0).max(120).default(10),
  working_days: z.array(z.string()).min(1, 'Select at least one day'),
});

type ShiftForm = z.infer<typeof shiftSchema>;

const assignSchema = z.object({
  employee_id: z.coerce.number().int().positive('Required'),
  shift_id: z.coerce.number().int().positive('Required'),
  location_id: z.coerce.number().int().positive().optional(),
  geofencing_enabled: z.boolean().default(false),
  effective_from: z.string().min(1, 'Required'),
});
type AssignForm = z.infer<typeof assignSchema>;

const selectClass = 'block w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';

const TYPE_BADGE: Record<string, 'info' | 'success' | 'warning' | 'neutral'> = {
  fixed: 'info', flexible: 'success', rotating: 'warning', custom: 'neutral',
};

export default function SchedulesPage() {
  const qc = useQueryClient();
  const currentUser = useCurrentUser();
  const isSuperAdmin = currentUser?.role === 'super_admin';
  const [addOpen, setAddOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);

  const { data: shiftsData, isLoading: shiftsLoading } = useQuery({
    queryKey: ['shifts'],
    queryFn: async () => {
      const res = await fetch('/api/schedules');
      return res.json() as Promise<ApiResponse<{ shifts: Shift[] }>>;
    },
  });

  const { data: empData } = useQuery({
    queryKey: ['employees', 'all'],
    queryFn: async () => {
      const res = await fetch('/api/employees?limit=100');
      return res.json() as Promise<ApiResponse<{ employees: Employee[] }>>;
    },
  });

  const { data: locData } = useQuery({
    queryKey: ['locations', 'all'],
    queryFn: async () => {
      const res = await fetch('/api/locations');
      return res.json() as Promise<ApiResponse<{ locations: Location[] }>>;
    },
  });

  const shifts = shiftsData?.data?.shifts ?? [];
  const employees = empData?.data?.employees ?? [];
  const locations = locData?.data?.locations ?? [];

  // Create shift
  const shiftForm = useForm<ShiftForm>({
    resolver: zodResolver(shiftSchema) as unknown as Resolver<ShiftForm>,
    defaultValues: { type: 'fixed', grace_minutes: 10, working_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] },
  });
  const shiftType = useWatch({ control: shiftForm.control, name: 'type' });
  const workingDays = useWatch({ control: shiftForm.control, name: 'working_days' }) ?? [];

  const createShiftMutation = useMutation({
    mutationFn: async (values: ShiftForm) => {
      const res = await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Failed');
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['shifts'] }); setAddOpen(false); shiftForm.reset(); },
  });

  const deleteShiftMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/schedules/${id}`, { method: 'DELETE' });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Failed');
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['shifts'] }),
  });

  // Assign schedule
  const assignForm = useForm<AssignForm>({
    resolver: zodResolver(assignSchema) as unknown as Resolver<AssignForm>,
    defaultValues: { geofencing_enabled: false, effective_from: new Date().toISOString().slice(0, 10) },
  });

  const assignMutation = useMutation({
    mutationFn: async (values: AssignForm) => {
      const res = await fetch('/api/schedules/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Failed');
    },
    onSuccess: () => { setAssignOpen(false); assignForm.reset(); },
  });

  function toggleDay(day: string) {
    const current = workingDays;
    const next = current.includes(day) ? current.filter(d => d !== day) : [...current, day];
    shiftForm.setValue('working_days', next);
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-3 justify-end">
        <Button variant="secondary" onClick={() => setAssignOpen(true)}>Assign Schedule</Button>
        {isSuperAdmin && (
          <Button onClick={() => setAddOpen(true)}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Shift
          </Button>
        )}
      </div>

      {shiftsLoading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : (
        <Table
          columns={[
            { key: 'name', header: 'Shift Name', render: r => <span className="font-medium">{(r as Shift).name}</span> },
            {
              key: 'type',
              header: 'Type',
              render: r => <Badge variant={TYPE_BADGE[(r as Shift).type]}>{(r as Shift).type}</Badge>,
            },
            {
              key: 'hours',
              header: 'Hours',
              render: r => {
                const s = r as Shift;
                if (s.type === 'fixed') return `${s.start_time?.slice(0, 5) ?? '—'} – ${s.end_time?.slice(0, 5) ?? '—'}`;
                if (s.type === 'flexible') return `${s.required_hours}h required`;
                return '—';
              },
            },
            {
              key: 'working_days',
              header: 'Working Days',
              render: r => ((r as Shift).working_days ?? []).join(', '),
            },
            { key: 'grace_minutes', header: 'Grace', render: r => `${(r as Shift).grace_minutes}m` },
            {
              key: 'actions',
              header: '',
              render: r => isSuperAdmin ? (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => { if (confirm('Delete this shift?')) deleteShiftMutation.mutate((r as Shift).id); }}
                >
                  Delete
                </Button>
              ) : null,
            },
          ]}
          data={shifts as object[]}
          emptyMessage="No shifts defined yet."
        />
      )}

      {/* Create shift modal */}
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Create Shift" size="lg">
        <form onSubmit={shiftForm.handleSubmit((v: ShiftForm) => createShiftMutation.mutate(v))} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Input label="Shift Name" {...shiftForm.register('name')} error={shiftForm.formState.errors.name?.message} />
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Type</label>
              <select {...shiftForm.register('type')} className={selectClass}>
                <option value="fixed">Fixed</option>
                <option value="flexible">Flexible</option>
                <option value="rotating">Rotating</option>
              </select>
            </div>
          </div>

          {shiftType === 'fixed' && (
            <div className="grid grid-cols-2 gap-4">
              <Input label="Start Time" type="time" {...shiftForm.register('start_time')} />
              <Input label="End Time" type="time" {...shiftForm.register('end_time')} />
            </div>
          )}

          {shiftType === 'flexible' && (
            <Input label="Required Hours Per Day" type="number" min={1} max={24}
              {...shiftForm.register('required_hours')} error={shiftForm.formState.errors.required_hours?.message} />
          )}

          <Input label="Grace Period (minutes)" type="number" min={0} max={120}
            {...shiftForm.register('grace_minutes')} />

          <div>
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-2">Working Days</label>
            <div className="flex flex-wrap gap-2">
              {DAYS.map(day => (
                <button
                  key={day}
                  type="button"
                  onClick={() => toggleDay(day)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                    workingDays.includes(day)
                      ? 'bg-blue-600 text-white border-blue-600 dark:bg-blue-500 dark:border-blue-500'
                      : 'border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                >
                  {day}
                </button>
              ))}
            </div>
            {shiftForm.formState.errors.working_days && (
              <p className="text-xs text-red-500 mt-1">{shiftForm.formState.errors.working_days.message}</p>
            )}
          </div>

          {createShiftMutation.isError && (
            <p className="text-sm text-red-500">{(createShiftMutation.error as Error).message}</p>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button type="submit" loading={createShiftMutation.isPending}>Create Shift</Button>
          </div>
        </form>
      </Modal>

      {/* Assign schedule modal */}
      <Modal open={assignOpen} onClose={() => setAssignOpen(false)} title="Assign Schedule">
        <form onSubmit={assignForm.handleSubmit((v: AssignForm) => assignMutation.mutate(v))} className="space-y-4">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Employee</label>
            <select {...assignForm.register('employee_id')} className={selectClass}>
              <option value="">Select employee…</option>
              {employees.map(e => <option key={e.id} value={e.id}>{e.name} ({e.emp_id})</option>)}
            </select>
            {assignForm.formState.errors.employee_id && (
              <p className="text-xs text-red-500">{assignForm.formState.errors.employee_id.message}</p>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Shift</label>
            <select {...assignForm.register('shift_id')} className={selectClass}>
              <option value="">Select shift…</option>
              {shifts.map(s => <option key={s.id} value={s.id}>{s.name} ({s.type})</option>)}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Location (optional)</label>
            <select {...assignForm.register('location_id')} className={selectClass}>
              <option value="">No location</option>
              {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" {...assignForm.register('geofencing_enabled')}
              className="w-4 h-4 rounded border-slate-300 text-blue-600" />
            <span className="text-sm text-slate-700 dark:text-slate-300">Enable geofencing</span>
          </label>

          <Input label="Effective From" type="date" {...assignForm.register('effective_from')}
            error={assignForm.formState.errors.effective_from?.message} />

          {assignMutation.isError && (
            <p className="text-sm text-red-500">{(assignMutation.error as Error).message}</p>
          )}
          {assignMutation.isSuccess && (
            <p className="text-sm text-green-600 dark:text-green-400">Schedule assigned successfully.</p>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setAssignOpen(false)}>Cancel</Button>
            <Button type="submit" loading={assignMutation.isPending}>Assign</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

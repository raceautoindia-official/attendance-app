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
  location_id: z.preprocess(v => (v === '' || v === null || v === undefined) ? undefined : Number(v), z.number().int().positive().optional()),
  geofencing_enabled: z.boolean().default(false),
  effective_from: z.string().min(1, 'Required'),
  // Add alongside the current shift (double shift) rather than replacing it.
  additional: z.boolean().default(false),
});
type AssignForm = z.infer<typeof assignSchema>;

interface AssignedShift {
  schedule_id: number;
  shift_id: number;
  shift_name: string;
  start_time: string | null;
  end_time: string | null;
  location_id: number | null;
  location_name: string | null;
  geofencing_enabled: boolean;
  effective_from: string;
  fence_without_location: boolean;
}
interface EmployeeAssignments {
  employee_id: number;
  employee_name: string;
  emp_id: string;
  shifts: AssignedShift[];
  overlapping_shifts: string[] | null;
}

const hhmm = (t: string | null) => (t ? t.slice(0, 5) : '—');

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
  const [editTarget, setEditTarget] = useState<Shift | null>(null);

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

  // Who is currently rostered on what — needed to show an employee's existing
  // shift before adding a second, and to flag misconfigured schedules.
  const { data: assignData, isLoading: assignLoading } = useQuery({
    queryKey: ['schedule-assignments'],
    queryFn: async () => {
      const res = await fetch('/api/schedules/assignments');
      return res.json() as Promise<ApiResponse<{ assignments: EmployeeAssignments[] }>>;
    },
  });
  const assignments = assignData?.data?.assignments ?? [];

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

  // Edit shift
  const editShiftForm = useForm<ShiftForm>({
    resolver: zodResolver(shiftSchema) as unknown as Resolver<ShiftForm>,
    defaultValues: { type: 'fixed', grace_minutes: 10, working_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] },
  });
  const editShiftType = useWatch({ control: editShiftForm.control, name: 'type' });
  const editWorkingDays = useWatch({ control: editShiftForm.control, name: 'working_days' }) ?? [];

  function openEditShift(shift: Shift) {
    setEditTarget(shift);
    editShiftForm.reset({
      name: shift.name,
      type: shift.type as ShiftForm['type'],
      start_time: shift.start_time ?? undefined,
      end_time: shift.end_time ?? undefined,
      required_hours: shift.required_hours ?? undefined,
      grace_minutes: shift.grace_minutes,
      working_days: shift.working_days ?? [],
    });
  }

  function toggleEditDay(day: string) {
    const current = editWorkingDays;
    const next = current.includes(day) ? current.filter(d => d !== day) : [...current, day];
    editShiftForm.setValue('working_days', next);
  }

  const editShiftMutation = useMutation({
    mutationFn: async ({ id, values }: { id: number; values: ShiftForm }) => {
      const res = await fetch(`/api/schedules/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Failed');
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['shifts'] }); setEditTarget(null); },
  });

  // Assign schedule
  const assignForm = useForm<AssignForm>({
    resolver: zodResolver(assignSchema) as unknown as Resolver<AssignForm>,
    defaultValues: {
      // Default ON. Choosing a work location and then NOT fencing it is the
      // unusual case, but the form used to default off — so an admin who
      // assigned a site got no fence, no warning, and no away-from-site
      // clock-out, with nothing on screen saying why. The checkbox is disabled
      // until a location is picked, and the server forces it off without one,
      // so this cannot switch on a fence that has nothing to check against.
      geofencing_enabled: true,
      additional: false,
      effective_from: new Date().toISOString().slice(0, 10),
    },
  });

  // What the employee picked in the modal already has, so the admin can see
  // what a second shift would sit next to.
  const selectedEmployeeId = Number(assignForm.watch('employee_id')) || null;
  const addAsSecond = assignForm.watch('additional');
  const selectedAssignment = selectedEmployeeId
    ? assignments.find(a => a.employee_id === selectedEmployeeId)
    : undefined;

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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['employees'] });
      qc.invalidateQueries({ queryKey: ['attendance'] });
      qc.invalidateQueries({ queryKey: ['schedule-assignments'] });
      setAssignOpen(false);
      assignForm.reset();
    },
  });

  function toggleDay(day: string) {
    const current = workingDays;
    const next = current.includes(day) ? current.filter(d => d !== day) : [...current, day];
    shiftForm.setValue('working_days', next);
  }

  // Schedules that claim a fence but have no coordinates to check against, so
  // nothing is actually enforced. New ones are refused at assignment; these are
  // older rows, and the admin has to pick a location to make them real.
  const unfenced = assignments.flatMap(a =>
    a.shifts.filter(s => s.fence_without_location).map(s => ({ ...a, shift: s })));
  const clashing = assignments.filter(a => a.overlapping_shifts);

  // One row per assigned schedule, so the fence can be switched per person
  // without reassigning them. Geofencing used to be settable only at assignment
  // time, which meant it was changed with SQL instead — and a fence left on for
  // someone whose phone had stopped reporting costs them real hours.
  const fenceRows = assignments.flatMap(a =>
    a.shifts.map(s => ({
      key: s.schedule_id,
      employee_name: a.employee_name,
      emp_id: a.emp_id,
      shift: s,
    })));

  const fenceMutation = useMutation({
    mutationFn: async ({ scheduleId, enabled }: { scheduleId: number; enabled: boolean }) => {
      const res = await fetch(`/api/schedules/assignments/${scheduleId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ geofencing_enabled: enabled }),
      });
      const json = (await res.json()) as ApiResponse;
      if (!res.ok || !json.success) throw new Error(json.error ?? 'Could not change geofencing');
      return json;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedule-assignments'] }),
  });

  return (
    <div className="space-y-4">
      {unfenced.length > 0 && (
        <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
            Geofencing is switched on for {unfenced.length} schedule{unfenced.length > 1 ? 's' : ''} with no
            location — no fence is being enforced for them.
          </p>
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
            {unfenced.map(u => `${u.employee_name} (${u.shift.shift_name})`).join(', ')} — reassign with a
            location to make the fence real, or turn geofencing off.
          </p>
        </div>
      )}

      {clashing.length > 0 && (
        <div className="rounded-lg border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-3">
          <p className="text-sm font-medium text-red-800 dark:text-red-300">
            {clashing.length} employee{clashing.length > 1 ? 's have' : ' has'} overlapping shifts, which
            cannot both be worked — their expected hours will be overstated.
          </p>
          <p className="mt-1 text-xs text-red-700 dark:text-red-400">
            {clashing.map(a => `${a.employee_name}: ${a.overlapping_shifts!.join(' + ')}`).join('; ')}
          </p>
        </div>
      )}

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

      {/* Who is fenced. Tick to enforce the work site for that person; untick to
          leave them tracked but unjudged. */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700">
          <h2 className="font-semibold text-slate-800 dark:text-slate-200">Geofencing</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Tick to enforce the work site: clock-in is refused away from it, and leaving it ends the day.
            Unticking does <strong>not</strong> stop live tracking — their movements are still recorded,
            they are simply not judged by a radius. Leave it off for anyone whose phone does not report
            continuously, or their day is closed at their last known position.
          </p>
        </div>
        {fenceMutation.isError && (
          <p className="px-5 py-2 text-sm text-red-500">{(fenceMutation.error as Error).message}</p>
        )}
        {assignLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : (
          <Table
            columns={[
              {
                key: 'employee',
                header: 'Employee',
                render: r => {
                  const row = r as (typeof fenceRows)[number];
                  return (
                    <div>
                      <p className="font-medium text-slate-800 dark:text-slate-200">{row.employee_name}</p>
                      <p className="text-xs text-slate-400">{row.emp_id}</p>
                    </div>
                  );
                },
              },
              {
                key: 'shift',
                header: 'Shift',
                render: r => (r as (typeof fenceRows)[number]).shift.shift_name,
              },
              {
                key: 'site',
                header: 'Work Site',
                render: r => {
                  const s = (r as (typeof fenceRows)[number]).shift;
                  return s.location_name
                    ? <span className="text-slate-700 dark:text-slate-300">{s.location_name}</span>
                    : <span className="text-slate-400 text-xs">No location — assign one to fence them</span>;
                },
              },
              {
                key: 'geofence',
                header: 'Geofence',
                render: r => {
                  const row = r as (typeof fenceRows)[number];
                  const s = row.shift;
                  const canFence = s.location_id != null;
                  return (
                    <label className={`flex items-center gap-2 ${canFence ? 'cursor-pointer' : 'cursor-not-allowed'}`}>
                      <input
                        type="checkbox"
                        checked={s.geofencing_enabled}
                        disabled={!canFence || fenceMutation.isPending}
                        onChange={e =>
                          fenceMutation.mutate({ scheduleId: s.schedule_id, enabled: e.target.checked })}
                        className="w-4 h-4 rounded border-slate-300 text-blue-600 disabled:opacity-50"
                      />
                      <span className={`text-xs ${s.geofencing_enabled
                        ? 'text-slate-700 dark:text-slate-300'
                        : 'text-slate-400'}`}>
                        {s.geofencing_enabled ? 'Fenced' : 'Tracking only'}
                      </span>
                    </label>
                  );
                },
              },
            ]}
            data={fenceRows as object[]}
            emptyMessage="No schedules assigned yet."
          />
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
                <div className="flex gap-1 justify-end">
                  <Button size="sm" variant="ghost" onClick={() => openEditShift(r as Shift)}>Edit</Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => { if (confirm('Delete this shift?')) deleteShiftMutation.mutate((r as Shift).id); }}
                  >
                    Delete
                  </Button>
                </div>
              ) : null,
              headerClassName: 'text-right',
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

      {/* Edit shift modal */}
      <Modal open={!!editTarget} onClose={() => setEditTarget(null)} title="Edit Shift" size="lg">
        {editTarget && (
          <form onSubmit={editShiftForm.handleSubmit((v: ShiftForm) => editShiftMutation.mutate({ id: editTarget.id, values: v }))} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Input label="Shift Name" {...editShiftForm.register('name')} error={editShiftForm.formState.errors.name?.message} />
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Type</label>
                <select {...editShiftForm.register('type')} className={selectClass}>
                  <option value="fixed">Fixed</option>
                  <option value="flexible">Flexible</option>
                  <option value="rotating">Rotating</option>
                </select>
              </div>
            </div>

            {editShiftType === 'fixed' && (
              <div className="grid grid-cols-2 gap-4">
                <Input label="Start Time" type="time" {...editShiftForm.register('start_time')} />
                <Input label="End Time" type="time" {...editShiftForm.register('end_time')} />
              </div>
            )}

            {editShiftType === 'flexible' && (
              <Input label="Required Hours Per Day" type="number" min={1} max={24}
                {...editShiftForm.register('required_hours')} error={editShiftForm.formState.errors.required_hours?.message} />
            )}

            <Input label="Grace Period (minutes)" type="number" min={0} max={120}
              {...editShiftForm.register('grace_minutes')} />

            <div>
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-2">Working Days</label>
              <div className="flex flex-wrap gap-2">
                {DAYS.map(day => (
                  <button
                    key={day}
                    type="button"
                    onClick={() => toggleEditDay(day)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                      editWorkingDays.includes(day)
                        ? 'bg-blue-600 text-white border-blue-600 dark:bg-blue-500 dark:border-blue-500'
                        : 'border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                    }`}
                  >
                    {day}
                  </button>
                ))}
              </div>
            </div>

            {editShiftMutation.isError && (
              <p className="text-sm text-red-500">{(editShiftMutation.error as Error).message}</p>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="secondary" onClick={() => setEditTarget(null)}>Cancel</Button>
              <Button type="submit" loading={editShiftMutation.isPending}>Save Changes</Button>
            </div>
          </form>
        )}
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

          {/* What this employee is already rostered on today. */}
          {selectedAssignment && selectedAssignment.shifts.length > 0 && (
            <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 p-3">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5">
                Currently assigned
              </p>
              <ul className="space-y-1">
                {selectedAssignment.shifts.map(s => (
                  <li key={s.schedule_id} className="text-sm text-slate-700 dark:text-slate-300">
                    {s.shift_name}{' '}
                    <span className="text-slate-500 dark:text-slate-400">
                      {hhmm(s.start_time)}–{hhmm(s.end_time)}
                      {s.location_name ? ` · ${s.location_name}` : ''}
                    </span>
                    {s.fence_without_location && (
                      <span className="ml-1 text-xs text-amber-600 dark:text-amber-400">
                        (geofencing on but no location — nothing is fenced)
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {selectedAssignment.overlapping_shifts && (
                <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">
                  These shifts overlap: {selectedAssignment.overlapping_shifts.join(' and ')}
                </p>
              )}
            </div>
          )}

          {/* Double shift: only the employees the admin opts in get a second. */}
          {selectedAssignment && selectedAssignment.shifts.length > 0 && (
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="checkbox" {...assignForm.register('additional')}
                className="mt-0.5 w-4 h-4 rounded border-slate-300 text-blue-600" />
              <span className="text-sm text-slate-700 dark:text-slate-300">
                Add as a second shift (double shift)
                <span className="block text-xs text-slate-500 dark:text-slate-400">
                  {addAsSecond
                    ? 'Both shifts stay in force; the day expects the hours of both.'
                    : 'Leave unticked to replace the current shift.'}
                </span>
              </span>
            </label>
          )}

          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
              {addAsSecond ? 'Second shift' : 'Shift'}
            </label>
            <select {...assignForm.register('shift_id')} className={selectClass}>
              <option value="">Select shift…</option>
              {shifts
                .filter(s => !addAsSecond || !selectedAssignment?.shifts.some(a => a.shift_id === s.id))
                .map(s => <option key={s.id} value={s.id}>{s.name} ({s.type})</option>)}
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
              disabled={!assignForm.watch('location_id')}
              className="w-4 h-4 rounded border-slate-300 text-blue-600 disabled:opacity-50" />
            <span className={`text-sm ${assignForm.watch('location_id')
              ? 'text-slate-700 dark:text-slate-300'
              : 'text-slate-400 dark:text-slate-500'}`}>
              Enable geofencing
              {!assignForm.watch('location_id') && ' — pick a location first'}
            </span>
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

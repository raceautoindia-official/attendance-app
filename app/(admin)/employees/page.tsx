'use client';

import { useMemo, useState } from 'react';
import { useForm, useWatch, type Resolver, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Table from '@/components/ui/Table';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Drawer from '@/components/ui/Drawer';
import Wizard from '@/components/ui/Wizard';
import Badge from '@/components/ui/Badge';
import Pagination from '@/components/ui/Pagination';
import Avatar from '@/components/ui/Avatar';
import Spinner from '@/components/ui/Spinner';
import Card from '@/components/ui/Card';
import EmployeeDocuments from '@/components/EmployeeDocuments';
import type { Employee, ApiResponse, Role } from '@/lib/types';
import { useCurrentUser } from '@/lib/useCurrentUser';
import { suggestEmpId, randomPin } from '@/lib/suggest';
import Suggest from '@/components/ui/Suggest';

type EmpRow = Employee & {
  department?: string | null;
  manager_name?: string | null;
  passkey_count?: number;
  has_exemption?: number | boolean;
  shift_name?: string | null;
  shift_type?: string | null;
  shift_start_time?: string | null;
  shift_end_time?: string | null;
  location_name?: string | null;
  geofencing_enabled?: number | boolean | null;
  schedule_effective_from?: string | null;
};

const ROLE_BADGE: Record<Role, 'info' | 'warning' | 'neutral'> = {
  employee: 'neutral', manager: 'info', super_admin: 'warning',
};

const empSchema = z.object({
  emp_id: z.string().min(1, 'Required'),
  name: z.string().min(1, 'Required'),
  email: z.string().email('Invalid email').or(z.literal('')).optional(),
  phone: z.string().optional(),
  role: z.enum(['employee', 'manager', 'super_admin']),
  department: z.string().optional(),
  manager_id: z.preprocess(v => (v === '' || v === null || v === undefined) ? null : Number(v), z.number().int().positive().nullable().optional()),
  // The API (create, update and both login routes) accepts 4–6 digits — keep
  // the form in step, otherwise a 4-digit PIN is rejected here for no reason.
  pin: z.string().regex(/^\d{4,6}$/, 'PIN must be 4–6 digits'),
  work_mode: z.enum(['on_site', 'off_site']).optional(),
  allow_multiple_sessions: z.boolean().optional(),
  shift_id: z.preprocess(v => (v === '' || v === null || v === undefined) ? null : Number(v), z.number().int().positive().nullable().optional()),
  location_id: z.preprocess(v => (v === '' || v === null || v === undefined) ? null : Number(v), z.number().int().positive().nullable().optional()),
  geofencing_enabled: z.boolean().optional(),
  live_tracking_enabled: z.boolean().optional(),
  schedule_effective_from: z.string().optional(),
  department_id: z.preprocess(v => (v === '' || v === null || v === undefined) ? null : Number(v), z.number().int().positive().nullable().optional()),
  policy_id: z.preprocess(v => (v === '' || v === null || v === undefined) ? null : Number(v), z.number().int().positive().nullable().optional()),
});

const editSchema = empSchema.omit({ pin: true }).extend({
  // Blank = keep the current PIN; otherwise 4–6 digits, matching the API.
  new_pin: z.string().regex(/^\d{4,6}$/, 'PIN must be 4–6 digits').or(z.literal('')).optional(),
  work_mode: z.enum(['on_site', 'off_site']).optional(),
  allow_multiple_sessions: z.boolean().optional(),
  bank_account_name: z.string().max(100).optional(),
  bank_account_number: z.string().regex(/^[A-Za-z0-9]{5,24}$/, 'Account number must be 5–24 letters/digits').or(z.literal('')).optional(),
  bank_ifsc: z.string().regex(/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/, 'IFSC must look like SBIN0001234').or(z.literal('')).optional(),
  bank_name: z.string().max(100).optional(),
  pan_number: z.string().regex(/^[A-Za-z]{5}\d{4}[A-Za-z]$/, 'PAN must look like ABCDE1234F').or(z.literal('')).optional(),
  aadhaar_number: z.string().regex(/^\d{12}$/, 'Aadhaar must be 12 digits').or(z.literal('')).optional(),
});

type EmpForm = z.infer<typeof empSchema>;
type EditForm = z.infer<typeof editSchema>;

const selectClass = 'block w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';

interface BoundDevice {
  id: number;
  device_id: string;
  platform: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export default function EmployeesPage() {
  const qc = useQueryClient();
  const currentUser = useCurrentUser();
  const isSuperAdmin = currentUser?.role === 'super_admin';
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<EmpRow | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['employees', { page, search }],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), limit: '25' });
      if (search) params.set('search', search);
      const res = await fetch(`/api/employees?${params}`);
      return res.json() as Promise<ApiResponse<{
        employees: EmpRow[];
        pagination: { total: number; totalPages: number };
        unscheduled: { id: number; emp_id: string; name: string }[];
      }>>;
    },
  });

  // Memoised because downstream hooks depend on it: '?? []' hands back a new
  // empty array on every render, which silently defeats any memo keyed on it.
  const employees = useMemo(() => data?.data?.employees ?? [], [data]);
  const pagination = data?.data?.pagination;
  const unscheduled = data?.data?.unscheduled ?? [];

  const { data: mgrData } = useQuery({
    queryKey: ['employees', 'managers'],
    queryFn: async () => {
      const res = await fetch('/api/employees?role=manager&limit=100');
      return res.json() as Promise<ApiResponse<{ employees: EmpRow[] }>>;
    },
  });
  const managers = mgrData?.data?.employees ?? [];

  const { data: shiftsData } = useQuery({
    queryKey: ['schedules', 'all'],
    queryFn: async () => {
      const res = await fetch('/api/schedules?limit=500');
      return res.json() as Promise<ApiResponse<{ shifts: Array<{ id: number; name: string; type: string }> }>>;
    },
  });
  const shifts = shiftsData?.data?.shifts ?? [];

  const { data: policiesData } = useQuery({
    queryKey: ['policies', 'active'],
    queryFn: async () => {
      const res = await fetch('/api/policies');
      return res.json() as Promise<ApiResponse<{ policies: Array<{
        id: number; name: string; code: string; default_shift_id: number | null;
        default_shift_name: string | null;
      }> }>>;
    },
  });
  const policies = policiesData?.data?.policies ?? [];

  const { data: deptData } = useQuery({
    queryKey: ['org', 'departments', 'for-employee-form'],
    queryFn: async () => {
      const res = await fetch('/api/org/departments');
      return res.json() as Promise<ApiResponse<{ departments: Array<{
        id: number; name: string; depth: number;
      }> }>>;
    },
  });
  const departments = deptData?.data?.departments ?? [];

  const { data: locationsData } = useQuery({
    queryKey: ['locations', 'all'],
    queryFn: async () => {
      const res = await fetch('/api/locations?limit=500');
      return res.json() as Promise<ApiResponse<{
        locations: Array<{ id: number; name: string; company_name?: string | null }>;
      }>>;
    },
  });
  const locations = locationsData?.data?.locations ?? [];

  // Add form
  // The id the new starter will sign in with, following the numbering
  // already in use. Recomputed from the list on screen, so two admins
  // adding people at once still see different suggestions once either
  // list refreshes - and the server rejects a duplicate regardless.
  const suggestedEmpId = useMemo(
    () => suggestEmpId(employees.map(e => e.emp_id)),
    [employees],
  );

  // A generated PIN has to be readable once: the admin has to pass it on,
  // and the field itself is masked.
  const [generatedPin, setGeneratedPin] = useState<string | null>(null);

  const addForm = useForm<EmpForm>({
    resolver: zodResolver(empSchema) as unknown as Resolver<EmpForm>,
    defaultValues: {
      role: 'employee',
      // Default ON, matching the Schedules screen: assigning a work location
      // and not fencing it is the exception. The server still forces it off
      // when no location is chosen, so this never claims a fence that has
      // nothing to measure against.
      geofencing_enabled: true,
      live_tracking_enabled: true,
      work_mode: 'on_site',
      allow_multiple_sessions: false,
      schedule_effective_from: new Date().toISOString().slice(0, 10),
    },
  });
  const addEmpId = useWatch({ control: addForm.control, name: 'emp_id' });
  const [createNotes, setCreateNotes] = useState<string[]>([]);

  const addMutation = useMutation({
    mutationFn: async (values: EmpForm) => {
      const res = await fetch('/api/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const json = await res.json() as ApiResponse<{ notes?: string[] }>;
      if (!json.success) throw new Error(json.error ?? 'Failed');
      return json;
    },
    onSuccess: json => {
      qc.invalidateQueries({ queryKey: ['employees'] });
      // A new starter given a department is placed in the org chart server-side,
      // so the Organisation page's unplaced queue is already out of date.
      qc.invalidateQueries({ queryKey: ['org'] });
      setAddOpen(false);
      addForm.reset();
      setGeneratedPin(null);
      // Which shift they ended up on, and whether the policy actually applied.
      // Both are decided server-side, so neither is obvious from the form.
      setCreateNotes(json.data?.notes ?? []);
    },
  });

  // Phone bound to the employee being edited — see lib/deviceBinding.ts.
  const { data: deviceData, isLoading: devicesLoading } = useQuery({
    queryKey: ['employee-devices', editTarget?.id],
    enabled: !!editTarget,
    queryFn: async () => {
      const res = await fetch(`/api/employees/${editTarget!.id}/devices`);
      return res.json() as Promise<ApiResponse<{ devices: BoundDevice[] }>>;
    },
  });
  const devices = deviceData?.data?.devices ?? [];

  const releaseDeviceMutation = useMutation({
    mutationFn: async (employeeId: number) => {
      const res = await fetch(`/api/employees/${employeeId}/devices`, { method: 'DELETE' });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Failed');
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['employee-devices'] }),
  });

  // Edit form
  const editForm = useForm<EditForm>({ resolver: zodResolver(editSchema) as unknown as Resolver<EditForm> });
  const editMutation = useMutation({
    mutationFn: async ({ id, values }: { id: number; values: EditForm }) => {
      const chosen = departments.find(d => d.name === values.department);
      const res = await fetch(`/api/employees/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chosen ? { ...values, department_id: chosen.id } : values),
      });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Failed');
      return json;
    },
    // The org queries too: a department change here writes a placement, and
    // the Organisation page's unplaced queue is read straight off it.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['employees'] });
      qc.invalidateQueries({ queryKey: ['org'] });
      setEditTarget(null);
    },
  });

  // Deactivate
  const deactivateMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/employees/${id}`, { method: 'DELETE' });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Failed');
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['employees'] }),
  });

  // Grant / revoke exemption
  const grantExemptionMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/employees/${id}/exemption`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Initial access — pending passkey enrolment' }),
      });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Failed');
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['employees'] }),
  });

  const revokeExemptionMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/employees/${id}/exemption`, { method: 'DELETE' });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Failed');
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['employees'] }),
  });

  // Reset login access — clears passkeys AND grants a fresh PIN exemption so a
  // locked-out employee ("Passkey setup required") can sign in with their PIN
  // and re-enrol a passkey. Super admin only.
  const resetAccessMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/employees/${id}/reset-access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Login reset by super admin' }),
      });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Failed');
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['employees'] }),
  });

  function openEdit(emp: EmpRow) {
    setEditTarget(emp);
    editForm.reset({
      emp_id: emp.emp_id,
      name: emp.name,
      email: emp.email ?? '',
      phone: emp.phone ?? '',
      role: emp.role,
      department: emp.department ?? '',
      manager_id: emp.manager_id ?? undefined,
      // `!!`, like the line below it. The API returns this flag as the NUMBER
      // 1 (mysql2 hands TINYINT(1) back as a number), and the form's schema
      // asks for a boolean - so seeding it raw made an edit that never touched
      // the checkbox fail validation with 'expected boolean, received number'.
      // Absent still means on, which is why this is not a bare !!.
      live_tracking_enabled: emp.live_tracking_enabled == null
        ? true : !!emp.live_tracking_enabled,
      work_mode: emp.work_mode ?? 'on_site',
      allow_multiple_sessions: !!emp.allow_multiple_sessions,
      new_pin: '',
      bank_account_name: emp.bank_account_name ?? '',
      bank_account_number: emp.bank_account_number ?? '',
      bank_ifsc: emp.bank_ifsc ?? '',
      bank_name: emp.bank_name ?? '',
      pan_number: emp.pan_number ?? '',
      aadhaar_number: emp.aadhaar_number ?? '',
    });
  }

  return (
    <div className="space-y-4">
      {createNotes.length > 0 && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 dark:border-blue-900/50 dark:bg-blue-950/40 dark:text-blue-200">
          <div className="space-y-0.5">
            {createNotes.map((n, i) => <p key={i}>{n}</p>)}
          </div>
          <button onClick={() => setCreateNotes([])} className="text-xs underline">Dismiss</button>
        </div>
      )}
      {/* Absent marking derives working days from the assigned shift, so anyone
          without a schedule is silently skipped by the nightly job. */}
      {unscheduled.length > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-900/20">
          <svg className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div className="min-w-0">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
              {unscheduled.length} active {unscheduled.length === 1 ? 'employee has' : 'employees have'} no shift assigned
            </p>
            <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">
              They will never be marked absent — the nightly job works out which days are working
              days from the assigned shift, so it skips them entirely. Assign a shift under
              Schedules, or from Edit on their row.
            </p>
            <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-400">
              {unscheduled.slice(0, 12).map(u => `${u.name} (${u.emp_id})`).join(', ')}
              {unscheduled.length > 12 ? ` +${unscheduled.length - 12} more` : ''}
            </p>
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3">
        <Input
          placeholder="Search by name or ID…"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          className="sm:max-w-xs"
        />
        {isSuperAdmin && (
          <div className="flex gap-2 sm:ml-auto">
            <Button data-tour="employee-new" onClick={() => { setGeneratedPin(null); setAddOpen(true); }}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add Employee
            </Button>
          </div>
        )}
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : (
        <>
          <Table
            columns={[
              {
                key: 'name',
                header: 'Employee',
                render: r => (
                  <div className="flex items-center gap-2.5">
                    <Avatar name={(r as EmpRow).name} size="sm" />
                    <div>
                      <p className="font-medium text-slate-800 dark:text-slate-200">{(r as EmpRow).name}</p>
                      <p className="text-xs text-slate-400">{(r as EmpRow).emp_id}</p>
                    </div>
                  </div>
                ),
              },
              // Phone was only visible after expanding a row, so an admin who
              // had just typed one in had no way to see it had been saved.
              { key: 'phone', header: 'Phone', render: r => (r as EmpRow).phone ?? '—' },
              { key: 'department', header: 'Department', render: r => (r as EmpRow).department ?? '—' },
              {
                key: 'role',
                header: 'Role',
                render: r => (
                  <Badge variant={ROLE_BADGE[(r as EmpRow).role]}>
                    {(r as EmpRow).role.replace('_', ' ')}
                  </Badge>
                ),
              },
              { key: 'email', header: 'Email', render: r => (r as EmpRow).email ?? '—' },
              {
                key: 'is_active',
                header: 'Status',
                render: r => (
                  <Badge variant={(r as EmpRow).is_active ? 'success' : 'neutral'}>
                    {(r as EmpRow).is_active ? 'Active' : 'Inactive'}
                  </Badge>
                ),
              },
              {
                key: 'actions',
                header: '',
                render: r => (
                  <div className="flex items-center gap-1 justify-end">
                    {isSuperAdmin && (
                      <Button size="sm" variant="ghost" onClick={e => { e.stopPropagation(); openEdit(r as EmpRow); }}>Edit</Button>
                    )}
                    {/* Recovery for employees locked out of login (e.g. "No passkeys available"
                        on their device, or no passkey/exemption at all). Removes any passkeys
                        and grants a temporary PIN-only login so they can sign in and re-enrol. */}
                    {isSuperAdmin && (r as EmpRow).is_active && (
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={resetAccessMutation.isPending}
                        onClick={e => {
                          e.stopPropagation();
                          if (confirm(`Reset login for ${(r as EmpRow).name}?\n\nThis removes all their passkeys and grants a temporary PIN-only login, so they can sign in with their PIN and enrol a new passkey on their device.\n\nUse this when an employee is locked out (e.g. "No passkeys available").`)) {
                            resetAccessMutation.mutate((r as EmpRow).id);
                          }
                        }}
                      >
                        Reset Login
                      </Button>
                    )}
                    {isSuperAdmin && (r as EmpRow).is_active && (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={e => { e.stopPropagation(); if (confirm('Deactivate this employee?')) deactivateMutation.mutate((r as EmpRow).id); }}
                      >
                        Deactivate
                      </Button>
                    )}
                  </div>
                ),
                headerClassName: 'text-right',
              },
            ]}
            data={employees as object[]}
            onRowClick={r => setExpandedId(expandedId === (r as EmpRow).id ? null : (r as EmpRow).id)}
            emptyMessage="No employees found."
          />

          {/* Expanded detail */}
          {expandedId && (
            <Card className="border-blue-200 dark:border-blue-800">
              {(() => {
                const emp = employees.find(e => e.id === expandedId);
                if (!emp) return null;
                const hasSchedule = !!emp.shift_name;
                const shiftHours = emp.shift_start_time && emp.shift_end_time
                  ? `${String(emp.shift_start_time).slice(0, 5)} – ${String(emp.shift_end_time).slice(0, 5)}`
                  : null;
                return (
                  <div className="space-y-4">
                    {/* Contact & auth */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                      <div><p className="text-xs text-slate-500 uppercase tracking-wide">Email</p><p className="mt-0.5 font-medium text-slate-800 dark:text-slate-200">{emp.email ?? '—'}</p></div>
                      <div><p className="text-xs text-slate-500 uppercase tracking-wide">Phone</p><p className="mt-0.5 font-medium text-slate-800 dark:text-slate-200">{emp.phone ?? '—'}</p></div>
                      <div><p className="text-xs text-slate-500 uppercase tracking-wide">Manager</p><p className="mt-0.5 font-medium text-slate-800 dark:text-slate-200">{emp.manager_name ?? '—'}</p></div>
                      <div><p className="text-xs text-slate-500 uppercase tracking-wide">Passkeys</p><p className="mt-0.5 font-medium text-slate-800 dark:text-slate-200">{Number(emp.passkey_count ?? 0)}</p></div>
                      <div><p className="text-xs text-slate-500 uppercase tracking-wide">Live Tracking</p><p className="mt-0.5"><Badge variant={emp.live_tracking_enabled ? 'info' : 'neutral'}>{emp.live_tracking_enabled ? 'Enabled' : 'Disabled'}</Badge></p></div>
                      <div><p className="text-xs text-slate-500 uppercase tracking-wide">Work Mode</p><p className="mt-0.5"><Badge variant={emp.work_mode === 'off_site' ? 'warning' : 'info'}>{emp.work_mode === 'off_site' ? 'Off-site' : 'On-site'}</Badge></p></div>
                      <div><p className="text-xs text-slate-500 uppercase tracking-wide">Multiple Shifts</p><p className="mt-0.5"><Badge variant={emp.allow_multiple_sessions ? 'success' : 'neutral'}>{emp.allow_multiple_sessions ? 'Allowed' : 'Single'}</Badge></p></div>
                      <div>
                        <p className="text-xs text-slate-500 uppercase tracking-wide">PIN Exemption</p>
                        <div className="mt-0.5 flex items-center gap-2">
                          <Badge variant={emp.has_exemption ? 'success' : 'neutral'}>{emp.has_exemption ? 'Granted' : 'None'}</Badge>
                          {emp.has_exemption ? (
                            <Button size="sm" variant="danger"
                              loading={revokeExemptionMutation.isPending}
                              onClick={() => { if (confirm('Revoke PIN exemption? Employee will need a passkey to log in.')) revokeExemptionMutation.mutate(emp.id); }}>
                              Revoke
                            </Button>
                          ) : (
                            <Button size="sm" variant="secondary"
                              loading={grantExemptionMutation.isPending}
                              onClick={() => grantExemptionMutation.mutate(emp.id)}>
                              Grant Access
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                    {/* Current schedule */}
                    <div className="border-t border-slate-200 dark:border-slate-700 pt-3">
                      <p className="text-xs text-slate-500 uppercase tracking-wide mb-2">Current Schedule</p>
                      {hasSchedule ? (
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                          <div><p className="text-xs text-slate-500">Shift</p><p className="mt-0.5 font-medium text-slate-800 dark:text-slate-200">{emp.shift_name}</p></div>
                          <div><p className="text-xs text-slate-500">Type</p><p className="mt-0.5 font-medium text-slate-800 dark:text-slate-200 capitalize">{emp.shift_type}</p></div>
                          <div><p className="text-xs text-slate-500">Hours</p><p className="mt-0.5 font-medium text-slate-800 dark:text-slate-200">{shiftHours ?? '—'}</p></div>
                          <div><p className="text-xs text-slate-500">Location</p><p className="mt-0.5 font-medium text-slate-800 dark:text-slate-200">{emp.location_name ?? '—'}</p></div>
                          <div><p className="text-xs text-slate-500">Geofencing</p><p className="mt-0.5"><Badge variant={emp.geofencing_enabled ? 'info' : 'neutral'}>{emp.geofencing_enabled ? 'Enabled' : 'Disabled'}</Badge></p></div>
                          <div><p className="text-xs text-slate-500">Effective From</p><p className="mt-0.5 font-medium text-slate-800 dark:text-slate-200">{emp.schedule_effective_from ? String(emp.schedule_effective_from).slice(0, 10) : '—'}</p></div>
                        </div>
                      ) : (
                        <p className="text-sm text-slate-400 italic">No active schedule assigned.</p>
                      )}
                    </div>
                    {/* Bank & identity */}
                    <div className="border-t border-slate-200 dark:border-slate-700 pt-3">
                      <p className="text-xs text-slate-500 uppercase tracking-wide mb-2">Bank &amp; Identity</p>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                        <div><p className="text-xs text-slate-500">Account Holder</p><p className="mt-0.5 font-medium text-slate-800 dark:text-slate-200">{emp.bank_account_name ?? '—'}</p></div>
                        <div><p className="text-xs text-slate-500">Account Number</p><p className="mt-0.5 font-medium text-slate-800 dark:text-slate-200">{emp.bank_account_number ?? '—'}</p></div>
                        <div><p className="text-xs text-slate-500">IFSC</p><p className="mt-0.5 font-medium text-slate-800 dark:text-slate-200">{emp.bank_ifsc ?? '—'}</p></div>
                        <div><p className="text-xs text-slate-500">Bank</p><p className="mt-0.5 font-medium text-slate-800 dark:text-slate-200">{emp.bank_name ?? '—'}</p></div>
                        <div><p className="text-xs text-slate-500">PAN</p><p className="mt-0.5 font-medium text-slate-800 dark:text-slate-200">{emp.pan_number ?? '—'}</p></div>
                        <div><p className="text-xs text-slate-500">Aadhaar</p><p className="mt-0.5 font-medium text-slate-800 dark:text-slate-200">{emp.aadhaar_number ?? '—'}</p></div>
                      </div>
                    </div>
                    {/* Documents */}
                    <div className="border-t border-slate-200 dark:border-slate-700 pt-3">
                      <p className="text-xs text-slate-500 uppercase tracking-wide mb-2">Documents</p>
                      <EmployeeDocuments employeeId={emp.id} canDelete={isSuperAdmin} />
                    </div>
                  </div>
                );
              })()}
            </Card>
          )}

          {pagination && pagination.totalPages > 1 && (
            <Pagination page={page} totalPages={pagination.totalPages} onPageChange={setPage} />
          )}
        </>
      )}

      {/* Add modal */}
      {/* Four steps instead of twenty fields at once. The old form asked for
          identity, role, shift, location, policy, geofencing and work mode on
          one screen with nothing to say which three actually mattered, and the
          usual result is a record created with the easy half filled in. */}
      <Drawer
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add an employee"
        description="Four short steps. Everything here can be changed afterwards."
        size="lg"
      >
        <Wizard
          busy={addMutation.isPending}
          error={addMutation.isError ? (addMutation.error as Error).message : null}
          finishLabel="Create employee"
          onCancel={() => setAddOpen(false)}
          onFinish={() => addForm.handleSubmit((v: EmpForm) => addMutation.mutate(v))()}
          steps={[
            {
              key: 'person',
              title: 'The person',
              hint: 'Who they are, and how they will sign in.',
              // Validated on LEAVING this step rather than at the end. Being
              // told on step four that step one was wrong means redoing the walk.
              validate: () => {
                const v = addForm.getValues();
                if (!v.emp_id?.trim()) return 'An employee ID is needed - it is what they sign in with.';
                if (!v.name?.trim()) return 'A full name is needed.';
                if (!/^[0-9]{4,6}$/.test(String(v.pin ?? ''))) return 'The initial PIN must be 4 to 6 digits.';
                return null;
              },
              content: (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1">
                      <Input label="Employee ID" required {...addForm.register('emp_id')}
                        error={addForm.formState.errors.emp_id?.message}
                        helper="What they type to sign in. Must be unique." />
                      <Suggest suggestion={suggestedEmpId} current={addEmpId}
                        onUse={v => addForm.setValue('emp_id', v, { shouldDirty: true, shouldValidate: true })} />
                    </div>
                    <Input label="Full Name" required {...addForm.register('name')}
                      error={addForm.formState.errors.name?.message} />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <Input label="Email" type="email" {...addForm.register('email')}
                      error={addForm.formState.errors.email?.message} />
                    <Input label="Phone" {...addForm.register('phone')} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Input label="Initial PIN (4-6 digits)" required type="password" maxLength={6}
                      inputMode="numeric" autoComplete="new-password" {...addForm.register('pin')}
                      error={addForm.formState.errors.pin?.message}
                      helper="They sign in with this once, then set up a passkey on their phone." />
                    <button
                      type="button"
                      onClick={() => {
                        const pin = randomPin();
                        addForm.setValue('pin', pin, { shouldDirty: true, shouldValidate: true });
                        setGeneratedPin(pin);
                      }}
                      className="self-start text-xs font-medium text-blue-600 underline decoration-dotted hover:decoration-solid dark:text-blue-400"
                    >
                      Generate a PIN
                    </button>
                    {generatedPin && (
                      <p className="text-xs text-slate-600 dark:text-slate-300">
                        PIN set to <strong>{generatedPin}</strong> &mdash; pass it on now, it is
                        stored hashed and cannot be read back.
                      </p>
                    )}
                  </div>
                </div>
              ),
            },
            {
              key: 'role',
              title: 'Role',
              hint: 'What they can see in this app, and who they report to.',
              content: (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1">
                      <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Role</label>
                      <select {...addForm.register('role')} className={selectClass}>
                        <option value="employee">Employee</option>
                        <option value="manager">Manager</option>
                        <option value="super_admin">Super Admin</option>
                      </select>
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        Employees see only their own records.
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                        Reporting manager
                      </label>
                      <select {...addForm.register('manager_id')} className={selectClass}>
                        <option value="">Nobody yet</option>
                        {managers.map(m => <option key={m.id} value={m.id}>{m.name} ({m.emp_id})</option>)}
                      </select>
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        Who this person reports to. Used for approvals and for what a
                        manager can see.
                      </span>
                    </div>
                  </div>

                  {/* Chosen, not typed. The free-text version of this field
                      currently holds an employee id and a phone number across
                      five people, which is what free text does when nobody is
                      watching. Picking one here also places them in the
                      organisation, so a new starter never joins the unplaced
                      queue. */}
                  <div className="flex flex-col gap-1">
                    <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                      Department
                    </label>
                    <select {...addForm.register('department_id')} className={selectClass}>
                      <option value="">Not set</option>
                      {departments.map(d => (
                        <option key={d.id} value={d.id}>
                          {'\u2014'.repeat(d.depth)} {d.name}
                        </option>
                      ))}
                    </select>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      {departments.length === 0
                        ? 'No departments yet - create them on the Organisation page first.'
                        : 'Add or rename departments on the Organisation page. Choosing one here also places them in the org chart.'}
                    </span>
                  </div>
                </div>
              ),
            },
            {
              key: 'work',
              title: 'How they work',
              hint: 'Shift, policy and site. Skip it and set these later if you do not know yet.',
              canSkip: true,
              content: (
                <div className="space-y-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Policy</label>
                    <select {...addForm.register('policy_id')} className={selectClass}>
                      <option value="">No policy - uses the global defaults</option>
                      {policies.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.code}){p.default_shift_name ? ' - ' + p.default_shift_name : ''}
                        </option>
                      ))}
                    </select>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      Sets their monthly hours, grace and statutory flags. Leave the shift
                      below empty and the policy&rsquo;s own shift is used.
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1">
                      <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Shift</label>
                      <select {...addForm.register('shift_id')} className={selectClass}>
                        <option value="">No shift</option>
                        {shifts.map(sh => <option key={sh.id} value={sh.id}>{sh.name} ({sh.type})</option>)}
                      </select>
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        Without one they have no required hours at all.
                      </span>
                    </div>
                    <Input label="Effective From" type="date"
                      {...addForm.register('schedule_effective_from')} />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1">
                      <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                        Work site
                      </label>
                      {/* Named for its company, because a site belongs to one and so
                          does a department - and somebody rostered at one company's
                          site while placed in another company's department is a
                          disagreement nothing else on this form would show. The
                          server says so after saving; this is how it is avoided
                          first. */}
                      <select {...addForm.register('location_id')} className={selectClass}>
                        <option value="">No work site</option>
                        {locations.map(l => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                            {l.company_name ? ` - ${l.company_name}` : ' - no company set'}
                          </option>
                        ))}
                      </select>
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        Where they clock in. Work sites and their companies are managed
                        under People, Work sites.
                      </span>
                    </div>
                    <label className="mt-7 flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                      <input type="checkbox" {...addForm.register('geofencing_enabled')} />
                      Enable geofencing
                    </label>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1">
                      <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Work Mode</label>
                      <select {...addForm.register('work_mode')} className={selectClass}>
                        <option value="on_site">On-site (geofence enforced)</option>
                        <option value="off_site">Off-site (field - no geofence)</option>
                      </select>
                    </div>
                    <label className="mt-7 flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                      <input type="checkbox" {...addForm.register('allow_multiple_sessions')} />
                      Allow multiple clock-ins per day
                    </label>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                    <input type="checkbox" {...addForm.register('live_tracking_enabled')} />
                    Enable live tracking
                  </label>
                </div>
              ),
            },
            {
              key: 'review',
              title: 'Check',
              hint: 'What is about to be created.',
              content: (
                <ReviewStep form={addForm} shifts={shifts} policies={policies} locations={locations} />
              ),
            },
          ]}
        />
      </Drawer>

      {/* Edit modal */}
      <Drawer open={!!editTarget} onClose={() => setEditTarget(null)} title="Edit Employee" size="lg">
        {editTarget && (
          <form onSubmit={editForm.handleSubmit((v: EditForm) => editMutation.mutate({ id: editTarget.id, values: v }))} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              {/* Read-only, because the update API does not accept it: typing a
                  new one here was silently discarded, and the field looked like
                  it had worked. The employee ID is what they log in with and
                  what every attendance row is keyed to, so it is not something
                  to change in passing. */}
              <Input label="Employee ID" readOnly disabled
                helper="Cannot be changed"
                {...editForm.register('emp_id')} />
              <Input label="Full Name" {...editForm.register('name')} error={editForm.formState.errors.name?.message} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Input label="Email" type="email" {...editForm.register('email')} />
              <Input label="Phone" {...editForm.register('phone')} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Role</label>
                <select {...editForm.register('role')} className={selectClass}>
                  <option value="employee">Employee</option>
                  <option value="manager">Manager</option>
                  <option value="super_admin">Super Admin</option>
                </select>
              </div>
              {/* Chosen here too. An edit form that still accepts free text
                  undoes the create form the first time anybody corrects a
                  record. The current value is shown even when it matches no
                  real department - five people are filed under an employee id
                  or a phone number, and hiding that would make it unfixable. */}
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  Department
                </label>
                <select {...editForm.register('department')} className={selectClass}>
                  <option value="">Not set</option>
                  {departments.map(d => (
                    <option key={d.id} value={d.name}>
                      {'—'.repeat(d.depth)} {d.name}
                    </option>
                  ))}
                  {/* Whatever is on the record now, when it is not a real
                      department. Listed so it can be seen and replaced. */}
                  {editTarget?.department
                    && !departments.some(d => d.name === editTarget.department) && (
                    <option value={editTarget.department}>
                      {editTarget.department} (not a department)
                    </option>
                  )}
                </select>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  Managed on the Organisation page.
                </span>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Reporting manager
              </label>
              <select {...editForm.register('manager_id')} className={selectClass}>
                <option value="">Nobody yet</option>
                {managers.map(m => <option key={m.id} value={m.id}>{m.name} ({m.emp_id})</option>)}
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
              <input type="checkbox" {...editForm.register('live_tracking_enabled')} />
              Enable live tracking for this employee
            </label>

            {/* Work mode + multi-session */}
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Work Mode</label>
                <select {...editForm.register('work_mode')} className={selectClass}>
                  <option value="on_site">On-site (geofence enforced)</option>
                  <option value="off_site">Off-site (field — no geofence)</option>
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 mt-7">
                <input type="checkbox" {...editForm.register('allow_multiple_sessions')} />
                Allow multiple clock-ins per day (plant)
              </label>
            </div>

            {/* Bank & statutory identity */}
            <div className="border-t border-slate-200 dark:border-slate-700 pt-4">
              <p className="text-xs text-slate-500 uppercase tracking-wide mb-3">Bank &amp; Identity</p>
              <div className="grid grid-cols-2 gap-4">
                <Input label="Account Holder Name" {...editForm.register('bank_account_name')}
                  error={editForm.formState.errors.bank_account_name?.message} />
                <Input label="Account Number" {...editForm.register('bank_account_number')}
                  error={editForm.formState.errors.bank_account_number?.message} />
                <Input label="IFSC Code" placeholder="SBIN0001234" {...editForm.register('bank_ifsc')}
                  error={editForm.formState.errors.bank_ifsc?.message} />
                <Input label="Bank Name" {...editForm.register('bank_name')}
                  error={editForm.formState.errors.bank_name?.message} />
                <Input label="PAN Number" placeholder="ABCDE1234F" {...editForm.register('pan_number')}
                  error={editForm.formState.errors.pan_number?.message} />
                <Input label="Aadhaar Number" placeholder="12 digits" maxLength={12} inputMode="numeric"
                  {...editForm.register('aadhaar_number')}
                  error={editForm.formState.errors.aadhaar_number?.message} />
              </div>
            </div>

            <Input label="New PIN (leave blank to keep)" type="password" maxLength={6} inputMode="numeric"
              autoComplete="new-password" helper="Leave empty to keep the current PIN, or enter 4–6 digits to change it"
              error={editForm.formState.errors.new_pin?.message}
              {...editForm.register('new_pin')} />

            {/* Attendance is tied to the first phone this employee used. A new
                handset or a reinstall needs the old binding released, or they
                cannot clock in at all. */}
            <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-3">
              <p className="text-sm font-medium text-slate-700 dark:text-slate-300">Registered phone</p>
              {devicesLoading ? (
                <p className="text-xs text-slate-400 mt-1">Checking…</p>
              ) : devices.length === 0 ? (
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  None yet — the next phone used to clock in will be registered.
                </p>
              ) : (
                <>
                  <ul className="mt-1 space-y-0.5">
                    {devices.map(d => (
                      <li key={d.id} className="text-xs text-slate-500 dark:text-slate-400">
                        {d.platform ?? 'device'} · last used {d.last_seen_at}
                      </li>
                    ))}
                  </ul>
                  <Button type="button" variant="secondary" className="mt-2"
                    loading={releaseDeviceMutation.isPending}
                    onClick={() => releaseDeviceMutation.mutate(editTarget.id)}>
                    Release for a new phone
                  </Button>
                </>
              )}
              {releaseDeviceMutation.isSuccess && (
                <p className="mt-1 text-xs text-green-600 dark:text-green-400">
                  Released — the next phone they use will be registered.
                </p>
              )}
            </div>

            {editMutation.isError && (
              <p className="text-sm text-red-500">{(editMutation.error as Error).message}</p>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="secondary" onClick={() => setEditTarget(null)}>Cancel</Button>
              <Button type="submit" loading={editMutation.isPending}>Save Changes</Button>
            </div>
          </form>
        )}
      </Drawer>
    </div>
  );
}

/**
 * The last step: what is actually about to be created.
 *
 * Reads back the IDs as the names they stand for. A review that says
 * "policy_id: 3" confirms nothing, because the reader has no idea which policy
 * 3 is - and the whole point of a final step is catching the selection that
 * was made by accident.
 *
 * It also names what was left out. An employee with no shift has no required
 * hours at all, and one in no department is invisible to department-based
 * access later. Both are legitimate choices and both are worth seeing before
 * pressing the button, not discovering a fortnight later.
 */
function ReviewStep({
  form, shifts, policies, locations,
}: {
  form: UseFormReturn<EmpForm>;
  shifts: Array<{ id: number; name: string; type: string }>;
  policies: Array<{ id: number; name: string; code: string }>;
  locations: Array<{ id: number; name: string }>;
}) {
  const v = form.getValues();
  const shift = shifts.find(s => String(s.id) === String(v.shift_id));
  const policy = policies.find(p => String(p.id) === String(v.policy_id));
  const location = locations.find(l => String(l.id) === String(v.location_id));

  const rows: Array<[string, string]> = [
    ['Employee ID', v.emp_id || '--'],
    ['Name', v.name || '--'],
    ['Email', v.email || 'none'],
    ['Phone', v.phone || 'none'],
    ['Role', String(v.role ?? 'employee').replace('_', ' ')],
    ['Department', v.department || 'not set'],
    ['Policy', policy ? policy.name + ' (' + policy.code + ')' : 'none - global defaults'],
    ['Shift', shift ? shift.name + ' (' + shift.type + ')' : 'none'],
    ['Location', location ? location.name : 'none'],
    ['Work mode', v.work_mode === 'off_site' ? 'Off-site (no geofence)' : 'On-site'],
  ];

  const gaps: string[] = [];
  if (!v.shift_id && !v.policy_id) {
    gaps.push('No shift and no policy, so they will have no required hours at all until one is set.');
  } else if (!v.shift_id && v.policy_id) {
    gaps.push('No shift chosen, so the shift named by the policy will be used.');
  }
  if (!v.department?.trim()) {
    gaps.push('No department. Place them on the Organisation page afterwards, or department-based access will not include them.');
  }

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700">
        {rows.map(([k, val]) => (
          <div key={k}>
            <dt className="text-xs text-slate-400">{k}</dt>
            <dd className="text-slate-800 dark:text-slate-200">{val}</dd>
          </div>
        ))}
      </dl>

      {gaps.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900/50 dark:bg-amber-950/40">
          <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
            Worth knowing, none of it blocking:
          </p>
          <ul className="mt-1 space-y-0.5">
            {gaps.map((g, i) => (
              <li key={i} className="text-xs text-amber-800 dark:text-amber-300">{g}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

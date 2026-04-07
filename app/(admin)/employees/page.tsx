'use client';

import { useState } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Table from '@/components/ui/Table';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Modal from '@/components/ui/Modal';
import Badge from '@/components/ui/Badge';
import Pagination from '@/components/ui/Pagination';
import Avatar from '@/components/ui/Avatar';
import Spinner from '@/components/ui/Spinner';
import Card from '@/components/ui/Card';
import type { Employee, ApiResponse, Role } from '@/lib/types';
import { useCurrentUser } from '@/lib/useCurrentUser';

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
  pin: z.string().length(6, 'PIN must be 6 digits').regex(/^\d+$/, 'Numbers only'),
});

const editSchema = empSchema.omit({ pin: true }).extend({
  new_pin: z.string().length(6).regex(/^\d+$/).or(z.literal('')).optional(),
});

type EmpForm = z.infer<typeof empSchema>;
type EditForm = z.infer<typeof editSchema>;

const selectClass = 'block w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';

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
      return res.json() as Promise<ApiResponse<{ employees: EmpRow[]; pagination: { total: number; totalPages: number } }>>;
    },
  });

  const employees = data?.data?.employees ?? [];
  const pagination = data?.data?.pagination;

  const { data: mgrData } = useQuery({
    queryKey: ['employees', 'managers'],
    queryFn: async () => {
      const res = await fetch('/api/employees?role=manager&limit=100');
      return res.json() as Promise<ApiResponse<{ employees: EmpRow[] }>>;
    },
  });
  const managers = mgrData?.data?.employees ?? [];

  // Add form
  const addForm = useForm<EmpForm>({ resolver: zodResolver(empSchema) as unknown as Resolver<EmpForm>, defaultValues: { role: 'employee' } });
  const addMutation = useMutation({
    mutationFn: async (values: EmpForm) => {
      const res = await fetch('/api/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Failed');
      return json;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['employees'] }); setAddOpen(false); addForm.reset(); },
  });

  // Edit form
  const editForm = useForm<EditForm>({ resolver: zodResolver(editSchema) as unknown as Resolver<EditForm> });
  const editMutation = useMutation({
    mutationFn: async ({ id, values }: { id: number; values: EditForm }) => {
      const res = await fetch(`/api/employees/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Failed');
      return json;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['employees'] }); setEditTarget(null); },
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

  // Passkey reset
  const resetPasskeysMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/employees/${id}/passkeys`, { method: 'DELETE' });
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
      new_pin: '',
    });
  }

  return (
    <div className="space-y-4">
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
            <Button onClick={() => setAddOpen(true)}>
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
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={e => { e.stopPropagation(); if (confirm('Reset all passkeys?')) resetPasskeysMutation.mutate((r as EmpRow).id); }}
                    >
                      Reset Keys
                    </Button>
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
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add Employee" size="lg">
        <form onSubmit={addForm.handleSubmit((v: EmpForm) => addMutation.mutate(v))} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Input label="Employee ID" {...addForm.register('emp_id')} error={addForm.formState.errors.emp_id?.message} />
            <Input label="Full Name" {...addForm.register('name')} error={addForm.formState.errors.name?.message} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input label="Email" type="email" {...addForm.register('email')} error={addForm.formState.errors.email?.message} />
            <Input label="Phone" {...addForm.register('phone')} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Role</label>
              <select {...addForm.register('role')} className={selectClass}>
                <option value="employee">Employee</option>
                <option value="manager">Manager</option>
                <option value="super_admin">Super Admin</option>
              </select>
            </div>
            <Input label="Department" {...addForm.register('department')} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Manager</label>
            <select {...addForm.register('manager_id')} className={selectClass}>
              <option value="">No manager</option>
              {managers.map(m => <option key={m.id} value={m.id}>{m.name} ({m.emp_id})</option>)}
            </select>
          </div>
          <Input label="Initial PIN (6 digits)" type="password" maxLength={6} inputMode="numeric"
            {...addForm.register('pin')} error={addForm.formState.errors.pin?.message} />

          {addMutation.isError && (
            <p className="text-sm text-red-500">{(addMutation.error as Error).message}</p>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button type="submit" loading={addMutation.isPending}>Add Employee</Button>
          </div>
        </form>
      </Modal>

      {/* Edit modal */}
      <Modal open={!!editTarget} onClose={() => setEditTarget(null)} title="Edit Employee" size="lg">
        {editTarget && (
          <form onSubmit={editForm.handleSubmit((v: EditForm) => editMutation.mutate({ id: editTarget.id, values: v }))} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Input label="Employee ID" {...editForm.register('emp_id')} error={editForm.formState.errors.emp_id?.message} />
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
              <Input label="Department" {...editForm.register('department')} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Manager</label>
              <select {...editForm.register('manager_id')} className={selectClass}>
                <option value="">No manager</option>
                {managers.map(m => <option key={m.id} value={m.id}>{m.name} ({m.emp_id})</option>)}
              </select>
            </div>
            <Input label="New PIN (leave blank to keep)" type="password" maxLength={6} inputMode="numeric"
              helper="Leave empty to keep current PIN" {...editForm.register('new_pin')} />

            {editMutation.isError && (
              <p className="text-sm text-red-500">{(editMutation.error as Error).message}</p>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="secondary" onClick={() => setEditTarget(null)}>Cancel</Button>
              <Button type="submit" loading={editMutation.isPending}>Save Changes</Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}

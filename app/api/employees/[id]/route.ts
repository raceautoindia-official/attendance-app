import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth, hashPin } from '@/lib/auth';
import { getWorkDateIST } from '@/lib/attendance';
import {
  hasBankColumns,
  bankSelect,
  BankDetailsSchema,
  normalizeBankDetails,
  hasWorkModeColumns,
  workModeSelect,
} from '@/lib/employeeDetails';
import type { ApiResponse, Employee, EmployeeSchedule } from '@/lib/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Params = { params: Promise<{ id: string }> };
async function hasLiveTrackingColumn() {
  const row = await queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'employees'
       AND COLUMN_NAME = 'live_tracking_enabled'`,
  );
  return Number(row?.c ?? 0) > 0;
}

async function resolveId(context: Params): Promise<number | null> {
  const { id } = await context.params;
  const n = parseInt(id, 10);
  return isNaN(n) ? null : n;
}

async function assertManagerScope(
  auth: { id: number; role: string },
  employeeId: number,
): Promise<NextResponse | null> {
  if (auth.role === 'super_admin') return null;
  const emp = await queryOne<{ manager_id: number | null }>(
    'SELECT manager_id FROM employees WHERE id = ?',
    [employeeId],
  );
  if (!emp || emp.manager_id !== auth.id) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Access denied: not in your team' },
      { status: 403 },
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// GET /api/employees/[id]
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest, context: Params) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const employeeId = await resolveId(context);
  if (!employeeId) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid ID' }, { status: 400 });
  }

  const scopeError = await assertManagerScope(auth, employeeId);
  if (scopeError) return scopeError;

  const [liveTrackingColExists, bankColsExist, workModeColsExist] = await Promise.all([
    hasLiveTrackingColumn(),
    hasBankColumns(),
    hasWorkModeColumns(),
  ]);
  const employee = await queryOne<Employee>(
    `SELECT e.id, e.emp_id, e.name, e.email, e.phone, e.department,
            ${bankSelect(bankColsExist)},
            ${workModeSelect(workModeColsExist)},
            e.role, e.is_active,
            ${liveTrackingColExists ? 'e.live_tracking_enabled' : 'TRUE AS live_tracking_enabled'},
            e.manager_id,
            e.created_at, e.updated_at
     FROM employees e WHERE e.id = ?`,
    [employeeId],
  );
  if (!employee) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Employee not found' }, { status: 404 });
  }

  // Active schedule with nested shift + location
  const schedule = await queryOne<EmployeeSchedule>(
    `SELECT
       es.id, es.employee_id, es.shift_id, es.location_id,
       es.geofencing_enabled, es.effective_from, es.effective_to,
       es.assigned_by, es.created_at,
       JSON_OBJECT(
         'id', s.id, 'name', s.name, 'type', s.type,
         'start_time', s.start_time, 'end_time', s.end_time,
         'required_hours', s.required_hours, 'grace_minutes', s.grace_minutes,
         'working_days', s.working_days
       ) AS shift,
       IF(l.id IS NOT NULL,
         JSON_OBJECT('id', l.id, 'name', l.name,
           'latitude', l.latitude, 'longitude', l.longitude,
           'radius_meters', l.radius_meters),
         NULL
       ) AS location
     FROM employee_schedules es
     JOIN  shifts s    ON es.shift_id    = s.id
     LEFT JOIN locations l ON es.location_id = l.id
     WHERE es.employee_id = ?
       AND es.effective_from <= ?
       AND (es.effective_to IS NULL OR es.effective_to >= ?)
     ORDER BY es.effective_from DESC
     LIMIT 1`,
    [employeeId, getWorkDateIST(), getWorkDateIST()],
  );

  if (schedule) {
    const s = schedule as unknown as Record<string, unknown>;
    if (typeof s.shift === 'string') s.shift = JSON.parse(s.shift as string);
    if (typeof s.location === 'string') s.location = JSON.parse(s.location as string);
  }

  return NextResponse.json<ApiResponse<{ employee: Employee; schedule: EmployeeSchedule | null }>>(
    { success: true, data: { employee, schedule: schedule ?? null } },
  );
}

// ---------------------------------------------------------------------------
// PUT /api/employees/[id]
// ---------------------------------------------------------------------------

const UpdateEmployeeSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().max(20).nullable().optional(),
  department: z.string().max(100).nullable().optional(),
  role: z.enum(['employee', 'manager', 'super_admin']).optional(),
  manager_id: z.number().int().positive().nullable().optional(),
  is_active: z.boolean().optional(),
  live_tracking_enabled: z.boolean().optional(),
  work_mode: z.enum(['on_site', 'off_site']).optional(),
  allow_multiple_sessions: z.boolean().optional(),
  new_pin: z.string().regex(/^\d{4,6}$/, 'PIN must be 4–6 digits').optional(),
}).extend(BankDetailsSchema.shape);

export async function PUT(request: NextRequest, context: Params) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  const employeeId = await resolveId(context);
  if (!employeeId) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid ID' }, { status: 400 });
  }

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 }); }

  const parsed = UpdateEmployeeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Validation error' },
      { status: 400 },
    );
  }

  const [liveTrackingColExists, bankColsExist] = await Promise.all([
    hasLiveTrackingColumn(),
    hasBankColumns(),
  ]);
  const existing = await queryOne<Employee>(
    `SELECT id, emp_id, name, email, phone, department, role, is_active,
            ${liveTrackingColExists ? 'live_tracking_enabled' : 'TRUE AS live_tracking_enabled'},
            manager_id,
            created_at, updated_at FROM employees WHERE id = ?`,
    [employeeId],
  );
  if (!existing) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Employee not found' }, { status: 404 });
  }

  const {
    name, email, phone, department, role, manager_id, is_active,
    live_tracking_enabled, work_mode, allow_multiple_sessions, new_pin,
  } = parsed.data;
  // The edit form always submits these fields, so with the migration not yet
  // run they are silently skipped (the form could only contain the synthesized
  // defaults anyway) — a 503 here would block editing EVERY employee field.
  const workModeColsExist = await hasWorkModeColumns();

  // Email uniqueness check if changing
  if (email !== undefined && email !== existing.email) {
    const dup = await queryOne<{ id: number }>(
      'SELECT id FROM employees WHERE email = ? AND id != ?',
      [email, employeeId],
    );
    if (dup) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: `Email '${email}' is already in use` },
        { status: 409 },
      );
    }
  }

  const setClauses: string[] = [];
  const params: unknown[] = [];

  const apply = (col: string, val: unknown) => {
    setClauses.push(`${col} = ?`);
    params.push(val);
  };

  if (name !== undefined) apply('name', name);
  if (email !== undefined) apply('email', email);
  if (phone !== undefined) apply('phone', phone);
  if (department !== undefined) apply('department', department);
  if (role !== undefined) apply('role', role);
  if (manager_id !== undefined) apply('manager_id', manager_id);
  if (is_active !== undefined) apply('is_active', is_active ? 1 : 0);
  if (liveTrackingColExists && live_tracking_enabled !== undefined) apply('live_tracking_enabled', live_tracking_enabled ? 1 : 0);
  if (workModeColsExist && work_mode !== undefined) apply('work_mode', work_mode);
  if (workModeColsExist && allow_multiple_sessions !== undefined) apply('allow_multiple_sessions', allow_multiple_sessions ? 1 : 0);
  if (new_pin !== undefined) apply('pin_hash', await hashPin(new_pin));

  // Same graceful degradation for the bank/identity fields: the edit form
  // always submits them, so pre-migration they are skipped, not fatal.
  const bankFields = normalizeBankDetails(parsed.data);
  if (bankColsExist) {
    for (const [col, val] of Object.entries(bankFields)) apply(col, val);
  }

  if (setClauses.length === 0) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'No fields to update' },
      { status: 400 },
    );
  }

  params.push(employeeId);
  await query(`UPDATE employees SET ${setClauses.join(', ')} WHERE id = ?`, params);

  if (liveTrackingColExists && live_tracking_enabled === false) {
    await query(
      `UPDATE live_tracking_sessions
       SET is_active = FALSE, ended_at_utc = UTC_TIMESTAMP()
       WHERE employee_id = ? AND is_active = TRUE`,
      [employeeId],
    );
  }

  await insertAuditLog({
    action: 'employee_updated',
    entity: 'employee',
    entity_id: employeeId,
    performed_by: auth.id,
    details: {
      changed_fields: Object.keys(parsed.data).filter(k => k !== 'new_pin'),
      pin_changed: new_pin !== undefined,
    },
    ip_address: request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
  });

  const updated = await queryOne<Employee>(
    `SELECT e.id, e.emp_id, e.name, e.email, e.phone, e.department,
            ${bankSelect(bankColsExist)},
            ${workModeSelect(workModeColsExist)},
            e.role, e.is_active,
            ${liveTrackingColExists ? 'e.live_tracking_enabled' : 'TRUE AS live_tracking_enabled'},
            e.manager_id,
            e.created_at, e.updated_at FROM employees e WHERE e.id = ?`,
    [employeeId],
  );
  return NextResponse.json<ApiResponse<Employee>>({ success: true, data: updated! });
}

// ---------------------------------------------------------------------------
// DELETE /api/employees/[id]  (soft delete)
// ---------------------------------------------------------------------------

export async function DELETE(request: NextRequest, context: Params) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  const employeeId = await resolveId(context);
  if (!employeeId) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid ID' }, { status: 400 });
  }

  const existing = await queryOne<{ id: number; emp_id: string }>(
    'SELECT id, emp_id FROM employees WHERE id = ? AND is_active = TRUE',
    [employeeId],
  );
  if (!existing) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Employee not found or already inactive' }, { status: 404 });
  }

  // Soft delete + invalidate all sessions
  await Promise.all([
    query('UPDATE employees SET is_active = FALSE WHERE id = ?', [employeeId]),
    query('DELETE FROM refresh_tokens WHERE employee_id = ?', [employeeId]),
  ]);

  await insertAuditLog({
    action: 'employee_deactivated',
    entity: 'employee',
    entity_id: employeeId,
    performed_by: auth.id,
    details: { emp_id: existing.emp_id },
    ip_address: request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
  });

  return NextResponse.json<ApiResponse>(
    { success: true, message: 'Employee deactivated' },
  );
}

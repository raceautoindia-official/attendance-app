import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth, hashPin } from '@/lib/auth';
import { getWorkDateIST } from '@/lib/attendance';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/lib/constants';
import { hasBankColumns, bankSelect, hasWorkModeColumns, workModeSelect } from '@/lib/employeeDetails';
import type { ApiResponse, Employee } from '@/lib/types';

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

// ---------------------------------------------------------------------------
// Validation — POST
// ---------------------------------------------------------------------------

// Empty string from a form field means "nothing typed", not a value to be
// validated. The add form submits every field whether or not it was filled in.
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

const CreateEmployeeSchema = z.object({
  emp_id: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9]+$/, 'emp_id must be alphanumeric'),
  name: z.string().min(1).max(100),
  email: z.preprocess(blankToNull, z.string().email().nullable().optional()),
  phone: z.preprocess(blankToNull, z.string().max(20).nullable().optional()),
  department: z.preprocess(blankToNull, z.string().max(100).nullable().optional()),
  pin: z.string().regex(/^\d{4,6}$/, 'PIN must be 4–6 digits'),
  role: z.enum(['employee', 'manager', 'super_admin']).default('employee'),
  manager_id: z.number().int().positive().nullable().optional(),
  shift_id: z.number().int().positive().nullable().optional(),
  location_id: z.number().int().positive().nullable().optional(),
  geofencing_enabled: z.boolean().optional().default(false),
  live_tracking_enabled: z.boolean().optional().default(true),
  // Settable when the employee is created. It could only be changed by editing
  // afterwards, so every new field employee started life fenced as on-site and
  // had to be corrected in a second step.
  work_mode: z.enum(['on_site', 'off_site']).optional().default('on_site'),
  allow_multiple_sessions: z.boolean().optional().default(false),
  schedule_effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

// ---------------------------------------------------------------------------
// GET /api/employees
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);

  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
  const limit = Math.min(
    Math.max(1, parseInt(searchParams.get('limit') ?? String(DEFAULT_PAGE_SIZE), 10)),
    MAX_PAGE_SIZE,
  );
  const offset = (page - 1) * limit;
  const search = searchParams.get('search')?.trim();
  const role = searchParams.get('role');
  const isActiveParam = searchParams.get('is_active');

  const conditions: string[] = [];
  const params: unknown[] = [];

  // Managers only see their direct reports
  if (auth.role === 'manager') {
    conditions.push('e.manager_id = ?');
    params.push(auth.id);
  }

  if (search) {
    conditions.push('(e.name LIKE ? OR e.emp_id LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  const validRoles = ['employee', 'manager', 'super_admin'];
  if (role && validRoles.includes(role)) {
    conditions.push('e.role = ?');
    params.push(role);
  }

  if (isActiveParam !== null) {
    conditions.push('e.is_active = ?');
    params.push(isActiveParam === 'true' ? 1 : 0);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [liveTrackingColExists, bankColsExist, workModeColsExist] = await Promise.all([
    hasLiveTrackingColumn(),
    hasBankColumns(),
    hasWorkModeColumns(),
  ]);
  const liveTrackingSelect = liveTrackingColExists ? 'e.live_tracking_enabled' : 'TRUE AS live_tracking_enabled';

  const [countRow, rows] = await Promise.all([
    queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM employees e ${where}`,
      [...params],
    ),
    query<Employee>(
      // Never expose pin_hash
      `SELECT e.id, e.emp_id, e.name, e.email, e.phone, e.department,
              ${bankSelect(bankColsExist)},
              ${workModeSelect(workModeColsExist)},
              e.role,
              e.is_active, ${liveTrackingSelect}, e.manager_id, e.created_at, e.updated_at,
              m.name       AS manager_name,
              s.name       AS shift_name,
              s.type       AS shift_type,
              s.start_time AS shift_start_time,
              s.end_time   AS shift_end_time,
              l.name       AS location_name,
              es.geofencing_enabled,
              es.effective_from AS schedule_effective_from,
              (SELECT COUNT(*) FROM passkeys p WHERE p.employee_id = e.id)          AS passkey_count,
              (SELECT COUNT(*) FROM passkey_exemptions pe WHERE pe.employee_id = e.id AND pe.is_active = TRUE) AS has_exemption
       FROM employees e
       LEFT JOIN employees m ON m.id = e.manager_id
       LEFT JOIN employee_schedules es
         ON es.id = (
           SELECT id FROM employee_schedules
           WHERE employee_id = e.id
             AND effective_from <= ?
             AND (effective_to IS NULL OR effective_to >= ?)
           ORDER BY effective_from DESC
           LIMIT 1
         )
       LEFT JOIN shifts s ON s.id = es.shift_id
       LEFT JOIN locations l ON l.id = es.location_id
       ${where}
       ORDER BY e.emp_id ASC
       LIMIT ? OFFSET ?`,
      [getWorkDateIST(), getWorkDateIST(), ...params, limit, offset],
    ),
  ]);

  const total = Number(countRow?.total ?? 0);

  // Active employees with NO schedule in force today. The nightly mark-absent
  // job derives working days from the assigned shift, so an employee without a
  // schedule is invisible to it — they can miss any number of days and never be
  // flagged. Reported across the whole scope, not just this page, so the count
  // doesn't change as the admin pages through.
  const unscheduled = await query<{ id: number; emp_id: string; name: string }>(
    `SELECT e.id, e.emp_id, e.name
     FROM employees e
     WHERE e.is_active = TRUE
       ${auth.role === 'manager' ? 'AND e.manager_id = ?' : ''}
       AND NOT EXISTS (
         SELECT 1 FROM employee_schedules es
         WHERE es.employee_id = e.id
           AND es.effective_from <= ?
           AND (es.effective_to IS NULL OR es.effective_to >= ?)
       )
     ORDER BY e.emp_id ASC`,
    auth.role === 'manager'
      ? [auth.id, getWorkDateIST(), getWorkDateIST()]
      : [getWorkDateIST(), getWorkDateIST()],
  );

  return NextResponse.json<ApiResponse<{
    employees: Employee[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
    /** Active employees with no schedule today — excluded from absent marking */
    unscheduled: { id: number; emp_id: string; name: string }[];
  }>>({
    success: true,
    data: {
      employees: rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      unscheduled,
    },
  });
}

// ---------------------------------------------------------------------------
// POST /api/employees
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 }); }

  const parsed = CreateEmployeeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Validation error' },
      { status: 400 },
    );
  }

  const {
    emp_id, name, email, phone, department, pin, role, manager_id,
    shift_id, location_id, geofencing_enabled, live_tracking_enabled,
    work_mode, allow_multiple_sessions, schedule_effective_from,
  } = parsed.data;
  const [liveTrackingColExists, workModeColsPresent] = await Promise.all([
    hasLiveTrackingColumn(),
    hasWorkModeColumns(),
  ]);

  // Uniqueness checks
  const [dupEmpId, dupEmail] = await Promise.all([
    queryOne<{ id: number }>('SELECT id FROM employees WHERE emp_id = ?', [emp_id]),
    email
      ? queryOne<{ id: number }>('SELECT id FROM employees WHERE email = ?', [email])
      : Promise.resolve(null),
  ]);

  if (dupEmpId) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: `emp_id '${emp_id}' is already in use` },
      { status: 409 },
    );
  }
  if (dupEmail) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: `Email '${email}' is already in use` },
      { status: 409 },
    );
  }

  const pinHash = await hashPin(pin);

  if (shift_id) {
    const shift = await queryOne<{ id: number }>('SELECT id FROM shifts WHERE id = ?', [shift_id]);
    if (!shift) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'Selected shift not found' },
        { status: 404 },
      );
    }
  }
  if (location_id) {
    const location = await queryOne<{ id: number }>(
      'SELECT id FROM locations WHERE id = ? AND is_active = TRUE',
      [location_id],
    );
    if (!location) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'Selected location not found' },
        { status: 404 },
      );
    }
  }
  if (shift_id && !schedule_effective_from) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'schedule_effective_from is required when assigning a shift' },
      { status: 400 },
    );
  }

  // Built column by column rather than as one branch per optional migration:
  // there are two independent groups now (live tracking, and work mode with
  // multi-session), so a nested ternary would be four hand-written statements
  // that have to agree with each other.
  const cols = ['emp_id', 'name', 'email', 'phone', 'department', 'pin_hash', 'role', 'manager_id'];
  const vals: unknown[] = [
    emp_id, name, email ?? null, phone ?? null, department ?? null, pinHash, role, manager_id ?? null,
  ];
  if (liveTrackingColExists) {
    cols.push('live_tracking_enabled');
    vals.push(live_tracking_enabled ? 1 : 0);
  }
  if (workModeColsPresent) {
    cols.push('work_mode', 'allow_multiple_sessions');
    vals.push(work_mode, allow_multiple_sessions ? 1 : 0);
  }
  const result = await query(
    `INSERT INTO employees (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    vals,
  );
  const insertId = (result as unknown as { insertId: number }).insertId;

  if (shift_id && schedule_effective_from) {
    await query(
      `INSERT INTO employee_schedules
       (employee_id, shift_id, location_id, geofencing_enabled, effective_from, assigned_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        insertId,
        shift_id,
        location_id ?? null,
        location_id ? (geofencing_enabled ? 1 : 0) : 0,
        schedule_effective_from,
        auth.id,
      ],
    );
  }

  // Auto-grant a PIN exemption so the new employee can sign in with their PIN
  // and set up their passkey on first login. (Admin only hands out an ID + PIN;
  // no separate "grant access" step needed.) Non-fatal if it fails.
  try {
    await query(
      `INSERT INTO passkey_exemptions (employee_id, granted_by, reason, is_active)
       VALUES (?, ?, ?, TRUE)`,
      [insertId, auth.id, 'Initial setup — pending passkey enrolment'],
    );
  } catch (err) {
    console.error('[employees] Failed to auto-grant initial PIN exemption:', err);
  }

  await insertAuditLog({
    action: 'employee_created',
    entity: 'employee',
    entity_id: insertId,
    performed_by: auth.id,
    details: { emp_id, name, role },
    ip_address: request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
  });

  const employee = await queryOne<Employee>(
    `SELECT id, emp_id, name, email, phone, department, role, is_active,
            ${liveTrackingColExists ? 'live_tracking_enabled' : 'TRUE AS live_tracking_enabled'},
            manager_id, created_at, updated_at
     FROM employees WHERE id = ?`,
    [insertId],
  );

  return NextResponse.json<ApiResponse<Employee>>(
    { success: true, data: employee! },
    { status: 201 },
  );
}

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth, hashPin } from '@/lib/auth';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/lib/constants';
import type { ApiResponse, Employee } from '@/lib/types';

// ---------------------------------------------------------------------------
// Validation — POST
// ---------------------------------------------------------------------------

const CreateEmployeeSchema = z.object({
  emp_id: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9]+$/, 'emp_id must be alphanumeric'),
  name: z.string().min(1).max(100),
  email: z.string().email().nullable().optional(),
  phone: z.string().max(20).nullable().optional(),
  pin: z.string().regex(/^\d{4,6}$/, 'PIN must be 4–6 digits'),
  role: z.enum(['employee', 'manager', 'super_admin']).default('employee'),
  manager_id: z.number().int().positive().nullable().optional(),
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

  const [countRow, rows] = await Promise.all([
    queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM employees e ${where}`,
      [...params],
    ),
    query<Employee>(
      // Never expose pin_hash
      `SELECT e.id, e.emp_id, e.name, e.email, e.phone, e.role,
              e.is_active, e.manager_id, e.created_at, e.updated_at,
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
             AND effective_from <= CURDATE()
             AND (effective_to IS NULL OR effective_to >= CURDATE())
           ORDER BY effective_from DESC
           LIMIT 1
         )
       LEFT JOIN shifts s ON s.id = es.shift_id
       LEFT JOIN locations l ON l.id = es.location_id
       ${where}
       ORDER BY e.emp_id ASC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ),
  ]);

  const total = Number(countRow?.total ?? 0);

  return NextResponse.json<ApiResponse<{
    employees: Employee[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }>>({
    success: true,
    data: {
      employees: rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
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

  const { emp_id, name, email, phone, pin, role, manager_id } = parsed.data;

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

  const result = await query(
    `INSERT INTO employees (emp_id, name, email, phone, pin_hash, role, manager_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [emp_id, name, email ?? null, phone ?? null, pinHash, role, manager_id ?? null],
  );
  const insertId = (result as unknown as { insertId: number }).insertId;

  await insertAuditLog({
    action: 'employee_created',
    entity: 'employee',
    entity_id: insertId,
    performed_by: auth.id,
    details: { emp_id, name, role },
    ip_address: request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
  });

  const employee = await queryOne<Employee>(
    `SELECT id, emp_id, name, email, phone, role, is_active, manager_id,
            created_at, updated_at
     FROM employees WHERE id = ?`,
    [insertId],
  );

  return NextResponse.json<ApiResponse<Employee>>(
    { success: true, data: employee! },
    { status: 201 },
  );
}

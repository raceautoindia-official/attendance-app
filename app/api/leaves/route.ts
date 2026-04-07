import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/lib/constants';
import type { ApiResponse, LeaveRecord } from '@/lib/types';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const CreateLeaveSchema = z.object({
  // null / omitted = company-wide holiday (all active employees)
  employee_id: z.number().int().positive().nullable().optional(),
  leave_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'leave_date must be YYYY-MM-DD'),
  leave_type: z.enum(['casual', 'sick', 'earned', 'holiday', 'other']),
  notes: z.string().max(500).nullable().optional(),
});

// ---------------------------------------------------------------------------
// GET /api/leaves — manager | super_admin, paginated
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

  const fromDate = searchParams.get('from_date');
  const toDate = searchParams.get('to_date');
  const employeeId = searchParams.get('employee_id');

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (auth.role === 'manager') {
    // Can see their team's leaves AND company-wide holidays (employee_id IS NULL)
    conditions.push(
      '(lr.employee_id IN (SELECT id FROM employees WHERE manager_id = ?) OR lr.employee_id IS NULL)',
    );
    params.push(auth.id);
  }

  if (fromDate) {
    conditions.push('lr.leave_date >= ?');
    params.push(fromDate);
  }
  if (toDate) {
    conditions.push('lr.leave_date <= ?');
    params.push(toDate);
  }
  if (employeeId) {
    const eid = parseInt(employeeId, 10);
    if (!isNaN(eid)) {
      conditions.push('lr.employee_id = ?');
      params.push(eid);
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [countRow, rows] = await Promise.all([
    queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM leave_records lr ${where}`,
      [...params],
    ),
    query<LeaveRecord & { employee_name: string | null; employee_emp_id: string | null }>(
      `SELECT lr.*,
              e.name   AS employee_name,
              e.emp_id AS employee_emp_id
       FROM leave_records lr
       LEFT JOIN employees e ON lr.employee_id = e.id
       ${where}
       ORDER BY lr.leave_date DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ),
  ]);

  const total = Number(countRow?.total ?? 0);

  return NextResponse.json<ApiResponse<{
    leaves: (LeaveRecord & { employee_name: string | null; employee_emp_id: string | null })[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }>>({
    success: true,
    data: {
      leaves: rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    },
  });
}

// ---------------------------------------------------------------------------
// POST /api/leaves — manager | super_admin
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 }); }

  const parsed = CreateLeaveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Validation error' },
      { status: 400 },
    );
  }

  const { employee_id, leave_date, leave_type, notes } = parsed.data;

  // ---- Company-wide holiday (employee_id omitted / null) ----
  if (employee_id === null || employee_id === undefined) {
    if (leave_type !== 'holiday') {
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'employee_id is required for non-holiday leave types' },
        { status: 400 },
      );
    }
    if (auth.role !== 'super_admin') {
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'Only super_admin can create company-wide holidays' },
        { status: 403 },
      );
    }

    // Bulk insert — one row per active employee; upsert is safe for re-runs
    await query(
      `INSERT INTO leave_records (employee_id, leave_date, leave_type, notes, created_by)
       SELECT id, ?, ?, ?, ?
       FROM employees
       WHERE is_active = TRUE
       ON DUPLICATE KEY UPDATE leave_type = VALUES(leave_type), notes = VALUES(notes)`,
      [leave_date, leave_type, notes ?? null, auth.id],
    );

    // Flip any existing attendance record to 'holiday'
    await query(
      `UPDATE attendance
       SET status = 'holiday'
       WHERE work_date = ?
         AND employee_id IN (SELECT id FROM employees WHERE is_active = TRUE)`,
      [leave_date],
    );

    await insertAuditLog({
      action: 'holiday_created',
      entity: 'attendance',
      performed_by: auth.id,
      details: { leave_date, leave_type, notes: notes ?? null, scope: 'all_employees' },
      ip_address: request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
    });

    return NextResponse.json<ApiResponse>(
      { success: true, message: `Holiday created for all active employees on ${leave_date}` },
      { status: 201 },
    );
  }

  // ---- Single-employee leave ----

  // Manager scope check
  if (auth.role === 'manager') {
    const emp = await queryOne<{ manager_id: number | null }>(
      'SELECT manager_id FROM employees WHERE id = ? AND is_active = TRUE',
      [employee_id],
    );
    if (!emp || emp.manager_id !== auth.id) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'Access denied: not in your team' },
        { status: 403 },
      );
    }
  }

  const result = await query(
    `INSERT INTO leave_records (employee_id, leave_date, leave_type, notes, created_by)
     VALUES (?, ?, ?, ?, ?)`,
    [employee_id, leave_date, leave_type, notes ?? null, auth.id],
  );
  const insertId = (result as unknown as { insertId: number }).insertId;

  // Flip existing attendance record status if one exists
  const newAttendanceStatus = leave_type === 'holiday' ? 'holiday' : 'leave';
  await query(
    `UPDATE attendance SET status = ? WHERE employee_id = ? AND work_date = ?`,
    [newAttendanceStatus, employee_id, leave_date],
  );

  await insertAuditLog({
    action: 'leave_created',
    entity: 'attendance',
    entity_id: insertId,
    performed_by: auth.id,
    details: { employee_id, leave_date, leave_type, notes: notes ?? null },
    ip_address: request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
  });

  const leaveRecord = await queryOne<LeaveRecord>(
    'SELECT * FROM leave_records WHERE id = ?',
    [insertId],
  );

  return NextResponse.json<ApiResponse<LeaveRecord>>(
    { success: true, data: leaveRecord! },
    { status: 201 },
  );
}

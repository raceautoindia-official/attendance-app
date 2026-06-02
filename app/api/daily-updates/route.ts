import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/lib/constants';
import type { ApiResponse } from '@/lib/types';

const UpsertSchema = z.object({
  work_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  update_text: z.string().min(1).max(1000),
});

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['employee', 'manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);
  const fromDate = searchParams.get('from_date');
  const toDate = searchParams.get('to_date');
  const employeeId = searchParams.get('employee_id');
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
  const limit = Math.min(Math.max(1, parseInt(searchParams.get('limit') ?? String(DEFAULT_PAGE_SIZE), 10)), MAX_PAGE_SIZE);
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (auth.role === 'employee') {
    conditions.push('d.employee_id = ?');
    params.push(auth.id);
  } else if (auth.role === 'manager') {
    conditions.push('e.manager_id = ?');
    params.push(auth.id);
  }
  if (employeeId && !Number.isNaN(parseInt(employeeId, 10))) {
    conditions.push('d.employee_id = ?');
    params.push(parseInt(employeeId, 10));
  }
  if (fromDate) {
    conditions.push('d.work_date >= ?');
    params.push(fromDate);
  }
  if (toDate) {
    conditions.push('d.work_date <= ?');
    params.push(toDate);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [countRow, rows] = await Promise.all([
    queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total
       FROM daily_work_updates d
       JOIN employees e ON e.id = d.employee_id
       ${where}`,
      params,
    ),
    query<{
      id: number;
      employee_id: number;
      employee_name: string;
      employee_emp_id: string;
      work_date: string;
      update_text: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT d.id, d.employee_id, d.work_date, d.update_text, d.created_at, d.updated_at,
              e.name AS employee_name, e.emp_id AS employee_emp_id
       FROM daily_work_updates d
       JOIN employees e ON e.id = d.employee_id
       ${where}
       ORDER BY d.work_date DESC, d.updated_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ),
  ]);

  const total = Number(countRow?.total ?? 0);
  return NextResponse.json<ApiResponse<{
    updates: typeof rows;
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }>>({
    success: true,
    data: {
      updates: rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    },
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['employee']);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = UpsertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>({ success: false, error: parsed.error.issues[0]?.message ?? 'Validation error' }, { status: 400 });
  }

  const { work_date, update_text } = parsed.data;
  await query(
    `INSERT INTO daily_work_updates (employee_id, work_date, update_text)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE update_text = VALUES(update_text), updated_at = CURRENT_TIMESTAMP`,
    [auth.id, work_date, update_text],
  );

  await insertAuditLog({
    action: 'daily_work_update_saved',
    entity: 'attendance',
    performed_by: auth.id,
    details: { work_date },
    ip_address: request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
  });

  return NextResponse.json<ApiResponse>({ success: true, message: 'Daily work update saved' });
}

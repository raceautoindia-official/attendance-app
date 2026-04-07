import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/lib/constants';
import type { ApiResponse, AttendanceRecord } from '@/lib/types';

// ---------------------------------------------------------------------------
// GET /api/attendance
// Paginated attendance list for managers and super_admins.
// Managers see only their team; super_admin sees everyone.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);

  // Pagination
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
  const limit = Math.min(
    Math.max(1, parseInt(searchParams.get('limit') ?? String(DEFAULT_PAGE_SIZE), 10)),
    MAX_PAGE_SIZE,
  );
  const offset = (page - 1) * limit;

  // Filters
  const date = searchParams.get('date');
  const fromDate = searchParams.get('from_date');
  const toDate = searchParams.get('to_date');
  const employeeId = searchParams.get('employee_id');
  const employeeSearch = searchParams.get('employee_search');
  const status = searchParams.get('status');

  // ---------------------------------------------------------------------------
  // Build WHERE clause dynamically
  // ---------------------------------------------------------------------------

  const conditions: string[] = [];
  const params: unknown[] = [];

  // Scope enforcement: managers can only see their own team
  if (auth.role === 'manager') {
    conditions.push(
      `a.employee_id IN (SELECT id FROM employees WHERE manager_id = ?)`,
    );
    params.push(auth.id);
  }

  // Date filters (exact date takes priority over range)
  if (date) {
    conditions.push('a.work_date = ?');
    params.push(date);
  } else {
    if (fromDate) {
      conditions.push('a.work_date >= ?');
      params.push(fromDate);
    }
    if (toDate) {
      conditions.push('a.work_date <= ?');
      params.push(toDate);
    }
  }

  if (employeeId) {
    conditions.push('a.employee_id = ?');
    params.push(parseInt(employeeId, 10));
  }

  if (employeeSearch) {
    conditions.push('(e.name LIKE ? OR e.emp_id LIKE ?)');
    params.push(`%${employeeSearch}%`, `%${employeeSearch}%`);
  }

  // Validate status value against allowed enum before injecting into SQL
  const validStatuses = [
    'present', 'late', 'early_departure', 'absent', 'leave', 'holiday',
  ];
  if (status && validStatuses.includes(status)) {
    conditions.push('a.status = ?');
    params.push(status);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // ---------------------------------------------------------------------------
  // Run count + data queries in parallel
  // ---------------------------------------------------------------------------

  const [countRow, rows] = await Promise.all([
    queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total
       FROM attendance a
       JOIN employees e ON a.employee_id = e.id
       ${whereClause}`,
      [...params],
    ),
    query<AttendanceRecord>(
      `SELECT a.*, e.name AS employee_name, e.emp_id
       FROM attendance a
       JOIN employees e ON a.employee_id = e.id
       ${whereClause}
       ORDER BY a.work_date DESC, a.clock_in_utc DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ),
  ]);

  const total = Number(countRow?.total ?? 0);
  const totalPages = Math.ceil(total / limit);

  return NextResponse.json<ApiResponse<{
    records: AttendanceRecord[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }>>({
    success: true,
    data: {
      records: rows,
      pagination: { page, limit, total, totalPages },
    },
  });
}

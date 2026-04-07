import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/lib/constants';
import type { ApiResponse } from '@/lib/types';

interface EmployeeSummary {
  id: number;
  emp_id: string;
  name: string;
  total_days_present: number;
  total_days_late: number;
  total_days_absent: number;
  total_days_leave: number;
  total_minutes_worked: number;
  days_with_hours: number;
}

// GET /api/reports/summary — manager | super_admin, paginated
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

  if (!fromDate || !toDate) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'from_date and to_date are required (YYYY-MM-DD)' },
      { status: 400 },
    );
  }

  const conditions: string[] = ['e.is_active = TRUE'];
  const conditionParams: unknown[] = [];

  if (auth.role === 'manager') {
    conditions.push('e.manager_id = ?');
    conditionParams.push(auth.id);
  }

  if (employeeId) {
    const eid = parseInt(employeeId, 10);
    if (!isNaN(eid)) {
      conditions.push('e.id = ?');
      conditionParams.push(eid);
    }
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const [countRow, rows] = await Promise.all([
    queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM employees e ${where}`,
      conditionParams,
    ),
    query<EmployeeSummary>(
      `SELECT
         e.id,
         e.emp_id,
         e.name,
         COALESCE(SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END), 0)            AS total_days_present,
         COALESCE(SUM(CASE WHEN a.status = 'late'    THEN 1 ELSE 0 END), 0)            AS total_days_late,
         COALESCE(SUM(CASE WHEN a.status = 'absent'  THEN 1 ELSE 0 END), 0)            AS total_days_absent,
         COALESCE(SUM(CASE WHEN a.status IN ('leave','holiday') THEN 1 ELSE 0 END), 0) AS total_days_leave,
         COALESCE(SUM(a.total_minutes), 0)                                              AS total_minutes_worked,
         COUNT(CASE WHEN a.total_minutes IS NOT NULL THEN 1 END)                        AS days_with_hours
       FROM employees e
       LEFT JOIN attendance a
         ON a.employee_id = e.id
         AND a.work_date BETWEEN ? AND ?
       ${where}
       GROUP BY e.id
       ORDER BY e.name ASC
       LIMIT ? OFFSET ?`,
      [fromDate, toDate, ...conditionParams, limit, offset],
    ),
  ]);

  const total = Number(countRow?.total ?? 0);

  return NextResponse.json<ApiResponse<{
    summary: EmployeeSummary[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
    period: { from_date: string; to_date: string };
  }>>({
    success: true,
    data: {
      summary: rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      period: { from_date: fromDate, to_date: toDate },
    },
  });
}

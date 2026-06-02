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

interface WorkingDaysRow {
  total_days: number;
  weekend_days: number;
  festive_holidays: number;
  total_working_days: number;
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
  const employeeFilterId =
    employeeId && !Number.isNaN(parseInt(employeeId, 10))
      ? parseInt(employeeId, 10)
      : null;

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

  if (employeeFilterId !== null) {
    conditions.push('e.id = ?');
    conditionParams.push(employeeFilterId);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const [countRow, rows, workingDaysRow, leaveDaysRow] = await Promise.all([
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
         (
           SELECT COUNT(DISTINCT lr.leave_date)
           FROM leave_records lr
           WHERE lr.employee_id = e.id
             AND lr.leave_date BETWEEN ? AND ?
             AND lr.leave_type <> 'holiday'
         ) +
         COALESCE(COUNT(DISTINCT CASE
           WHEN a.status = 'leave'
            AND NOT EXISTS (
              SELECT 1
              FROM leave_records lr2
              WHERE lr2.employee_id = e.id
                AND lr2.leave_date = a.work_date
                AND lr2.leave_type <> 'holiday'
            )
           THEN a.work_date
         END), 0)                                                                  AS total_days_leave,
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
      [fromDate, toDate, fromDate, toDate, ...conditionParams, limit, offset],
    ),
    queryOne<WorkingDaysRow>(
      `WITH RECURSIVE date_range AS (
         SELECT CAST(? AS DATE) AS d
         UNION ALL
         SELECT DATE_ADD(d, INTERVAL 1 DAY)
         FROM date_range
         WHERE d < CAST(? AS DATE)
       )
       SELECT
         COUNT(*) AS total_days,
         SUM(CASE WHEN DAYOFWEEK(dr.d) IN (1, 7) THEN 1 ELSE 0 END) AS weekend_days,
         SUM(CASE WHEN EXISTS (
           SELECT 1
           FROM leave_records lr
           WHERE lr.leave_date = dr.d
             AND lr.employee_id IS NULL
             AND lr.leave_type = 'holiday'
         ) THEN 1 ELSE 0 END) AS festive_holidays,
         SUM(
           CASE
             WHEN DAYOFWEEK(dr.d) IN (1, 7) THEN 0
             WHEN EXISTS (
               SELECT 1
               FROM leave_records lr
               WHERE lr.leave_date = dr.d
                 AND lr.employee_id IS NULL
                 AND lr.leave_type = 'holiday'
             ) THEN 0
             ELSE 1
           END
         ) AS total_working_days
       FROM date_range dr
      `,
      [fromDate, toDate],
    ),
    queryOne<{ total_leave_days: number }>(
      `SELECT COUNT(*) AS total_leave_days
       FROM leave_records lr
       JOIN employees e ON e.id = lr.employee_id
       WHERE lr.leave_date BETWEEN ? AND ?
         AND lr.leave_type <> 'holiday'
         AND e.is_active = TRUE
         ${auth.role === 'manager' ? 'AND e.manager_id = ?' : ''}
         ${employeeFilterId !== null ? 'AND e.id = ?' : ''}`,
      [
        fromDate,
        toDate,
        ...(auth.role === 'manager' ? [auth.id] : []),
        ...(employeeFilterId !== null ? [employeeFilterId] : []),
      ],
    ),
  ]);

  const total = Number(countRow?.total ?? 0);

  return NextResponse.json<ApiResponse<{
    summary: EmployeeSummary[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
    period: {
      from_date: string;
      to_date: string;
      total_days: number;
      weekend_days: number;
      festive_holidays: number;
      total_working_days: number;
      total_leave_days: number;
    };
  }>>({
    success: true,
    data: {
      summary: rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      period: {
        from_date: fromDate,
        to_date: toDate,
        total_days: Number(workingDaysRow?.total_days ?? 0),
        weekend_days: Number(workingDaysRow?.weekend_days ?? 0),
        festive_holidays: Number(workingDaysRow?.festive_holidays ?? 0),
        total_working_days: Number(workingDaysRow?.total_working_days ?? 0),
        total_leave_days: Number(leaveDaysRow?.total_leave_days ?? 0),
      },
    },
  });
}

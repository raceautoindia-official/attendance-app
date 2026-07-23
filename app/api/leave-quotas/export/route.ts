import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { getWorkDateIST } from '@/lib/attendance';

interface ExportRow {
  emp_id: string;
  employee_name: string;
  department: string | null;
  casual_total: number;
  sick_total: number;
  earned_total: number;
  casual_used: number;
  sick_used: number;
  earned_used: number;
  has_quota: number;
}

function escapeCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// GET /api/leave-quotas/export?year=YYYY — manager | super_admin
// Excel-ready CSV of every employee's yearly quota, used days and balance.
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const rawYear = request.nextUrl.searchParams.get('year');
  const parsedYear = rawYear ? parseInt(rawYear, 10) : NaN;
  const year = !isNaN(parsedYear) && parsedYear >= 2000 && parsedYear <= 2100
    ? parsedYear
    : Number(getWorkDateIST().slice(0, 4));

  const conditions: string[] = ['e.is_active = TRUE'];
  const params: unknown[] = [];
  if (auth.role === 'manager') {
    conditions.push('(e.manager_id = ? OR e.id = ?)');
    params.push(auth.id, auth.id);
  }

  let rows: ExportRow[];
  try {
    rows = await query<ExportRow>(
      `SELECT
         e.emp_id,
         e.name AS employee_name,
         e.department,
         COALESCE(q.casual_total, 0) AS casual_total,
         COALESCE(q.sick_total, 0)   AS sick_total,
         COALESCE(q.earned_total, 0) AS earned_total,
         COALESCE(u.casual_used, 0)  AS casual_used,
         COALESCE(u.sick_used, 0)    AS sick_used,
         COALESCE(u.earned_used, 0)  AS earned_used,
         IF(q.id IS NULL, 0, 1)      AS has_quota
       FROM employees e
       LEFT JOIN leave_quotas q
         ON q.employee_id = e.id AND q.year = ?
       LEFT JOIN (
         SELECT employee_id,
                SUM(leave_type = 'casual') AS casual_used,
                SUM(leave_type = 'sick')   AS sick_used,
                SUM(leave_type = 'earned') AS earned_used
         FROM leave_records
         WHERE employee_id IS NOT NULL
           AND YEAR(leave_date) = ?
         GROUP BY employee_id
       ) u ON u.employee_id = e.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY e.emp_id ASC`,
      [year, year, ...params],
    );
  } catch (error) {
    if ((error as { code?: string })?.code === 'ER_NO_SUCH_TABLE') {
      return NextResponse.json(
        {
          success: false,
          error: 'Leave quota table is missing. Run migration: database/migrations/2026-07-23_add_employee_details_documents_leave_quotas.sql',
        },
        { status: 503 },
      );
    }
    throw error;
  }

  const HEADERS = [
    'Employee ID',
    'Employee Name',
    'Department',
    'Casual Quota',
    'Casual Used',
    'Casual Remaining',
    'Sick Quota',
    'Sick Used',
    'Sick Remaining',
    'Earned Quota',
    'Earned Used',
    'Earned Remaining',
    'Total Quota',
    'Total Used',
    'Total Remaining',
    'Quota Set',
  ];

  const csvLines: string[] = [
    `Yearly Leave Report,${year}`,
    `Generated On,${escapeCsvField(getWorkDateIST())}`,
    `Employees,${rows.length}`,
    '',
    HEADERS.join(','),
  ];

  for (const row of rows) {
    const casualTotal = Number(row.casual_total);
    const sickTotal = Number(row.sick_total);
    const earnedTotal = Number(row.earned_total);
    const casualUsed = Number(row.casual_used);
    const sickUsed = Number(row.sick_used);
    const earnedUsed = Number(row.earned_used);
    const remaining = (total: number, used: number) => Math.max(0, total - used);

    csvLines.push(
      [
        escapeCsvField(row.emp_id),
        escapeCsvField(row.employee_name),
        escapeCsvField(row.department ?? ''),
        casualTotal,
        casualUsed,
        remaining(casualTotal, casualUsed),
        sickTotal,
        sickUsed,
        remaining(sickTotal, sickUsed),
        earnedTotal,
        earnedUsed,
        remaining(earnedTotal, earnedUsed),
        casualTotal + sickTotal + earnedTotal,
        casualUsed + sickUsed + earnedUsed,
        remaining(casualTotal, casualUsed) + remaining(sickTotal, sickUsed) + remaining(earnedTotal, earnedUsed),
        Number(row.has_quota) ? 'Yes' : 'No',
      ].join(','),
    );
  }

  // BOM so Excel detects UTF-8 (names with non-ASCII characters render right).
  const csv = String.fromCharCode(0xfeff) + csvLines.join('\r\n');
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="leave_quotas_${year}.csv"`,
    },
  });
}

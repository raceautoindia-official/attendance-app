import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { getWorkDateIST } from '@/lib/attendance';
import { hasPermissionTable, hasOnDutyColumn, timeOffOnly } from '@/lib/permissions';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// GET /api/leaves/monthly?month=YYYY-MM
//
// One row per employee for a month: leave taken by type, days worked on a
// company holiday, and approved permission hours.
//
// The leave list is a stream of individual records, which answers "what
// happened on the 14th" and never answers "how much leave has Nalini taken
// this month" — the question actually asked at the end of a month.
//
// CASUAL AND SICK LEAVE ARE NOT ABSENCE. They are counted in their own columns
// and excluded from the absent count, which is the whole point of recording
// them. Absent here means a working day with no clock-in and nothing excusing
// it.
// ---------------------------------------------------------------------------

interface MonthlyRow {
  employee_id: number;
  employee_name: string;
  emp_id: string;
  casual: number;
  sick: number;
  earned: number;
  other: number;
  total_leave: number;
  /** Company holidays this employee actually worked. */
  holidays_worked: number;
  holiday_minutes_worked: number;
  /** Days marked absent: no clock-in, no leave, a working day. */
  absent: number;
  present: number;
  permission_minutes: number;
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const monthParam = request.nextUrl.searchParams.get('month');
  const month = /^\d{4}-\d{2}$/.test(monthParam ?? '')
    ? (monthParam as string)
    : getWorkDateIST().slice(0, 7);

  const from = `${month}-01`;
  // Last day of the month, without any date arithmetic in JS: MySQL knows.
  const to = `${month}-31`;

  const scope = auth.role === 'manager' ? 'AND e.manager_id = ?' : '';
  const scopeParams = auth.role === 'manager' ? [auth.id] : [];

  const permissionsAvailable = await hasPermissionTable();
  const hasType = permissionsAvailable ? await hasOnDutyColumn() : false;
  const permissionExpr = permissionsAvailable
    ? `COALESCE((
         SELECT SUM(pr.minutes) FROM permission_requests pr
          WHERE pr.employee_id = e.id
            AND pr.status = 'approved'
            ${timeOffOnly(hasType, 'pr')}
            AND pr.permission_date BETWEEN ? AND ?
       ), 0)`
    : '0';
  const permissionParams = permissionsAvailable ? [from, to] : [];

  const rows = await query<MonthlyRow>(
    `SELECT
       e.id AS employee_id, e.name AS employee_name, e.emp_id,
       -- Leave taken, by type. Counted off leave_records rather than off the
       -- attendance status: a leave booked for a future date has no attendance
       -- row yet, and it is still leave that has been taken.
       COALESCE((SELECT COUNT(DISTINCT lr.leave_date) FROM leave_records lr
                  WHERE lr.employee_id = e.id AND lr.leave_type = 'casual'
                    AND lr.leave_date BETWEEN ? AND ?), 0) AS casual,
       COALESCE((SELECT COUNT(DISTINCT lr.leave_date) FROM leave_records lr
                  WHERE lr.employee_id = e.id AND lr.leave_type = 'sick'
                    AND lr.leave_date BETWEEN ? AND ?), 0) AS sick,
       COALESCE((SELECT COUNT(DISTINCT lr.leave_date) FROM leave_records lr
                  WHERE lr.employee_id = e.id AND lr.leave_type = 'earned'
                    AND lr.leave_date BETWEEN ? AND ?), 0) AS earned,
       COALESCE((SELECT COUNT(DISTINCT lr.leave_date) FROM leave_records lr
                  WHERE lr.employee_id = e.id AND lr.leave_type = 'other'
                    AND lr.leave_date BETWEEN ? AND ?), 0) AS other,
       -- Days the company was closed and this person came in anyway. A
       -- company-wide holiday has employee_id NULL, so it counts for everyone.
       COALESCE((SELECT COUNT(*) FROM attendance a2
                  WHERE a2.employee_id = e.id
                    AND a2.work_date BETWEEN ? AND ?
                    AND a2.clock_in_utc IS NOT NULL
                    AND EXISTS (SELECT 1 FROM leave_records lr2
                                 WHERE lr2.leave_date = a2.work_date
                                   AND lr2.leave_type = 'holiday'
                                   AND (lr2.employee_id = e.id OR lr2.employee_id IS NULL))
                ), 0) AS holidays_worked,
       COALESCE((SELECT SUM(COALESCE(a3.total_minutes, a3.banked_minutes, 0)) FROM attendance a3
                  WHERE a3.employee_id = e.id
                    AND a3.work_date BETWEEN ? AND ?
                    AND a3.clock_in_utc IS NOT NULL
                    AND EXISTS (SELECT 1 FROM leave_records lr3
                                 WHERE lr3.leave_date = a3.work_date
                                   AND lr3.leave_type = 'holiday'
                                   AND (lr3.employee_id = e.id OR lr3.employee_id IS NULL))
                ), 0) AS holiday_minutes_worked,
       -- Absent EXCLUDES anything with a leave record against it. An approved
       -- casual or sick day is not an absence, however the attendance row
       -- happens to be labelled.
       COALESCE((SELECT COUNT(*) FROM attendance a4
                  WHERE a4.employee_id = e.id
                    AND a4.work_date BETWEEN ? AND ?
                    AND a4.status = 'absent'
                    AND NOT EXISTS (SELECT 1 FROM leave_records lr4
                                     WHERE lr4.leave_date = a4.work_date
                                       AND (lr4.employee_id = e.id OR lr4.employee_id IS NULL))
                ), 0) AS absent,
       COALESCE((SELECT COUNT(*) FROM attendance a5
                  WHERE a5.employee_id = e.id
                    AND a5.work_date BETWEEN ? AND ?
                    AND a5.clock_in_utc IS NOT NULL), 0) AS present,
       ${permissionExpr} AS permission_minutes
     FROM employees e
     WHERE e.is_active = TRUE
       ${scope}
     ORDER BY e.name ASC`,
    [
      from, to, from, to, from, to, from, to,   // the four leave types
      from, to,                                  // holidays worked
      from, to,                                  // holiday minutes
      from, to,                                  // absent
      from, to,                                  // present
      ...permissionParams,
      ...scopeParams,
    ],
  );

  const employees = rows.map(r => ({
    ...r,
    casual: Number(r.casual), sick: Number(r.sick),
    earned: Number(r.earned), other: Number(r.other),
    total_leave: Number(r.casual) + Number(r.sick) + Number(r.earned) + Number(r.other),
    holidays_worked: Number(r.holidays_worked),
    holiday_minutes_worked: Number(r.holiday_minutes_worked),
    absent: Number(r.absent),
    present: Number(r.present),
    permission_minutes: Number(r.permission_minutes),
  }));

  return NextResponse.json<ApiResponse<{ month: string; employees: MonthlyRow[] }>>(
    { success: true, data: { month, employees } },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

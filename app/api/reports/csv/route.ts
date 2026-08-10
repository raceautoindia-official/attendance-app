import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { formatInTimeZone } from 'date-fns-tz';
import { TIMEZONE } from '@/lib/constants';
import {
  creditedMinutes,
  hasOnDutyColumn,
  hasPermissionTable,
  permissionMinutesSelect,
  timeOffOnly,
} from '@/lib/permissions';
import { getPeriodDays } from '@/lib/periodDays';
import { companyHolidays, weekdayCounts } from '@/lib/workingDays';
import {
  dayRequiredMinutesSelect,
  expectedMinutesFor,
  shiftsForEmployees,
  totalShiftMinutes,
} from '@/lib/shifts';
import type { AttendanceRecord } from '@/lib/types';

interface AttendanceRow extends AttendanceRecord {
  employee_name: string;
  employee_emp_id: string;
}

function escapeCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// GET /api/reports/csv — manager | super_admin
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);
  const fromDate = searchParams.get('from_date');
  const toDate = searchParams.get('to_date');
  const employeeId = searchParams.get('employee_id');
  const employeeFilterId =
    employeeId && !Number.isNaN(parseInt(employeeId, 10))
      ? parseInt(employeeId, 10)
      : null;

  if (!fromDate || !toDate) {
    return NextResponse.json(
      { success: false, error: 'from_date and to_date are required (YYYY-MM-DD)' },
      { status: 400 },
    );
  }

  const conditions: string[] = ['a.work_date BETWEEN ? AND ?', 'e.is_active = TRUE'];
  const params: unknown[] = [fromDate, toDate];

  if (auth.role === 'manager') {
    conditions.push('e.manager_id = ?');
    params.push(auth.id);
  }

  if (employeeFilterId !== null) {
    conditions.push('a.employee_id = ?');
    params.push(employeeFilterId);
  }

  const [permissionsAvailable, hasType] = await Promise.all([hasPermissionTable(), hasOnDutyColumn()]);
  const rows = await query<AttendanceRow>(
    `SELECT a.*,
            e.name   AS employee_name,
            e.emp_id AS employee_emp_id,
            ${permissionMinutesSelect(permissionsAvailable, 'a.employee_id', 'a.work_date', hasType)} AS permission_minutes,
            ${dayRequiredMinutesSelect('a.employee_id', 'a.work_date')} AS required_minutes
     FROM attendance a
     JOIN employees e ON a.employee_id = e.id
     LEFT JOIN employee_schedules es
       ON es.id = (
         SELECT es2.id
         FROM employee_schedules es2
         WHERE es2.employee_id = a.employee_id
           AND es2.effective_from <= a.work_date
           AND (es2.effective_to IS NULL OR es2.effective_to >= a.work_date)
         ORDER BY es2.effective_from DESC, es2.id DESC
         LIMIT 1
       )
     LEFT JOIN shifts s ON s.id = es.shift_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY a.work_date ASC, e.name ASC`,
    params,
  );

  const [periodRow, leaveRow] = await Promise.all([
    getPeriodDays(fromDate, toDate),
    queryOne<{ leave_days: number }>(
      `SELECT COUNT(*) AS leave_days
       FROM leave_records lr
       JOIN employees e ON e.id = lr.employee_id
       WHERE lr.leave_date BETWEEN ? AND ?
         AND lr.leave_type <> 'holiday'
         AND e.is_active = TRUE
         ${auth.role === 'manager' ? 'AND e.manager_id = ?' : ''}
         ${employeeFilterId !== null ? 'AND lr.employee_id = ?' : ''}`,
      [
        fromDate,
        toDate,
        ...(auth.role === 'manager' ? [auth.id] : []),
        ...(employeeFilterId !== null ? [employeeFilterId] : []),
      ],
    ),
  ]);

  // Counted off permission_requests, not off the attendance rows above: an
  // approved permission on a day with no attendance row (typically one booked
  // ahead) has no detail line, but still belongs in the period's total. This
  // keeps the figure equal to the on-screen report.
  const permissionTotalRow = permissionsAvailable
    ? await queryOne<{ minutes: number | null }>(
        `SELECT COALESCE(SUM(pr.minutes), 0) AS minutes
         FROM permission_requests pr
         JOIN employees e ON e.id = pr.employee_id
         WHERE pr.status = 'approved'
           ${timeOffOnly(hasType, 'pr')}
           AND pr.permission_date BETWEEN ? AND ?
           AND e.is_active = TRUE
           ${auth.role === 'manager' ? 'AND e.manager_id = ?' : ''}
           ${employeeFilterId !== null ? 'AND pr.employee_id = ?' : ''}`,
        [
          fromDate,
          toDate,
          ...(auth.role === 'manager' ? [auth.id] : []),
          ...(employeeFilterId !== null ? [employeeFilterId] : []),
        ],
      )
    : null;
  const permissionTotal = Number(permissionTotalRow?.minutes ?? 0);
  const workedTotal = rows.reduce((sum, r) => sum + Number(r.total_minutes ?? 0), 0);
  const creditedTotal = rows.reduce(
    (sum, r) =>
      sum +
      (creditedMinutes(
        r.total_minutes,
        Number(r.permission_minutes ?? 0),
        r.required_minutes == null ? undefined : Number(r.required_minutes),
      ) ?? 0),
    0,
  );
  // Working days already exclude weekly offs and company holidays. Expected
  // hours come from each employee's OWN shift length, never a flat 9h — an
  // employee with no schedule contributes nothing rather than a guess.
  const workingDays = Number(periodRow?.total_working_days ?? 0);
  const employeeCount = new Set(rows.map(r => r.employee_id)).size;
  const hm = (m: number) => `${Math.floor(m / 60)}h ${m % 60}m`;

  // Each employee's OWN shifts — a double-shift employee contributes BOTH
  // lengths, over the union of days those shifts work.
  const scopeEmployees = await query<{ id: number }>(
    `SELECT e.id FROM employees e
     WHERE e.is_active = TRUE
       ${auth.role === 'manager' ? 'AND e.manager_id = ?' : ''}
       ${employeeFilterId !== null ? 'AND e.id = ?' : ''}`,
    [
      ...(auth.role === 'manager' ? [auth.id] : []),
      ...(employeeFilterId !== null ? [employeeFilterId] : []),
    ],
  );
  const scopeShifts = await shiftsForEmployees(scopeEmployees.map(e => e.id), toDate);
  const dayCounts = weekdayCounts(fromDate, toDate);
  const holidayDates = await companyHolidays(fromDate, toDate);
  let expectedTotal = 0;
  let employeesWithShift = 0;
  for (const e of scopeEmployees) {
    const shifts = scopeShifts.get(e.id);
    if (totalShiftMinutes(shifts) == null) continue;
    employeesWithShift++;
    // Weekday by weekday — see expectedMinutesFor().
    expectedTotal += expectedMinutesFor(shifts!, dayCounts, holidayDates);
  }

  const HEADERS = [
    'Employee Name',
    'Employee ID',
    'Date',
    'Clock In (IST)',
    'Clock Out (IST)',
    'Hours Worked',
    'Permission Hours',
    'Hours Credited',
    'Status',
    'Auth Method',
    'Geofence Status',
  ];

  const csvLines: string[] = [
    'Attendance Report Summary',
    `From Date,${escapeCsvField(fromDate)}`,
    `To Date,${escapeCsvField(toDate)}`,
    `Total Calendar Days,${escapeCsvField(Number(periodRow?.total_days ?? 0))}`,
    `Weekly Off Days,${escapeCsvField(Number(periodRow?.weekend_days ?? 0))}`,
    `Holidays,${escapeCsvField(Number(periodRow?.festive_holidays ?? 0))}`,
    `Working Days (Excl. Weekly Off/Holiday),${escapeCsvField(workingDays)}`,
    `Leave Days (Selected Timeline),${escapeCsvField(Number(leaveRow?.leave_days ?? 0))}`,
    `Employees In Report,${escapeCsvField(employeeCount)}`,
    `Employees With A Shift Assigned,${escapeCsvField(employeesWithShift)}`,
    `Expected Hours (Each Employee's Own Shift x Working Days),${escapeCsvField(hm(expectedTotal))}`,
    `Total Hours Worked,${escapeCsvField(hm(workedTotal))}`,
    `Approved Permission Hours,${escapeCsvField(hm(permissionTotal))}`,
    `Total Hours Credited,${escapeCsvField(hm(creditedTotal))}`,
    '',
    'Absent = working day with no clock-in and no approved leave.',
    'Leave  = working day formally excused by an admin (casual/sick/earned).',
    '',
    HEADERS.join(','),
  ];

  for (const row of rows) {
    // work_date is always a string ("YYYY-MM-DD") from the DB
    const workDate = String(row.work_date).slice(0, 10);

    const clockIn = row.clock_in_utc
      ? formatInTimeZone(new Date(row.clock_in_utc as unknown as string), TIMEZONE, 'yyyy-MM-dd HH:mm:ss')
      : '';

    const clockOut = row.clock_out_utc
      ? formatInTimeZone(new Date(row.clock_out_utc as unknown as string), TIMEZONE, 'yyyy-MM-dd HH:mm:ss')
      : '';

    const hoursWorked =
      row.total_minutes != null
        ? `${Math.floor(row.total_minutes / 60)}h ${row.total_minutes % 60}m`
        : '';

    const permissionMinutes = Number(row.permission_minutes ?? 0);
    const permissionHours = permissionMinutes
      ? `${Math.floor(permissionMinutes / 60)}h ${permissionMinutes % 60}m`
      : '';

    const credited = creditedMinutes(
      row.total_minutes,
      permissionMinutes,
      row.required_minutes == null ? undefined : Number(row.required_minutes),
    );
    const hoursCredited =
      credited != null ? `${Math.floor(credited / 60)}h ${credited % 60}m` : '';

    csvLines.push(
      [
        escapeCsvField(row.employee_name),
        escapeCsvField(row.employee_emp_id),
        escapeCsvField(workDate),
        escapeCsvField(clockIn),
        escapeCsvField(clockOut),
        escapeCsvField(hoursWorked),
        escapeCsvField(permissionHours),
        escapeCsvField(hoursCredited),
        escapeCsvField(row.status),
        escapeCsvField(row.auth_method ?? ''),
        escapeCsvField(row.geofence_status ?? ''),
      ].join(','),
    );
  }

  const csv = csvLines.join('\r\n');
  const filename =
    `attendance_${fromDate}_to_${toDate}` +
    `_total-${Number(periodRow?.total_days ?? 0)}` +
    `_working-${Number(periodRow?.total_working_days ?? 0)}` +
    `_leave-${Number(leaveRow?.leave_days ?? 0)}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { formatInTimeZone } from 'date-fns-tz';
import { TIMEZONE } from '@/lib/constants';
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

  const rows = await query<AttendanceRow>(
    `SELECT a.*,
            e.name   AS employee_name,
            e.emp_id AS employee_emp_id
     FROM attendance a
     JOIN employees e ON a.employee_id = e.id
     WHERE ${conditions.join(' AND ')}
     ORDER BY a.work_date ASC, e.name ASC`,
    params,
  );

  const [periodRow, leaveRow] = await Promise.all([
    queryOne<{
      total_days: number;
      weekend_days: number;
      festive_holidays: number;
      working_days: number;
    }>(
      `WITH RECURSIVE date_range AS (
         SELECT CAST(? AS DATE) AS d
         UNION ALL
         SELECT DATE_ADD(d, INTERVAL 1 DAY)
         FROM date_range
         WHERE d < CAST(? AS DATE)
       )
       SELECT
         COUNT(*) AS total_days,
         SUM(CASE WHEN DAYOFWEEK(d) IN (1, 7) THEN 1 ELSE 0 END) AS weekend_days,
         SUM(CASE WHEN EXISTS (
               SELECT 1
               FROM leave_records lr
               WHERE lr.leave_date = d
                 AND lr.employee_id IS NULL
                 AND lr.leave_type = 'holiday'
             ) THEN 1 ELSE 0 END) AS festive_holidays,
         SUM(
           CASE
             WHEN DAYOFWEEK(d) IN (1, 7) THEN 0
             WHEN EXISTS (
               SELECT 1
               FROM leave_records lr
               WHERE lr.leave_date = d
                 AND lr.employee_id IS NULL
                 AND lr.leave_type = 'holiday'
             ) THEN 0
             ELSE 1
           END
         ) AS working_days
       FROM date_range`,
      [fromDate, toDate],
    ),
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

  const HEADERS = [
    'Employee Name',
    'Employee ID',
    'Date',
    'Clock In (IST)',
    'Clock Out (IST)',
    'Hours Worked',
    'Status',
    'Auth Method',
    'Geofence Status',
  ];

  const csvLines: string[] = [
    'Attendance Report Summary',
    `From Date,${escapeCsvField(fromDate)}`,
    `To Date,${escapeCsvField(toDate)}`,
    `Total Days (Selected Timeline),${escapeCsvField(Number(periodRow?.total_days ?? 0))}`,
    `Weekend Days,${escapeCsvField(Number(periodRow?.weekend_days ?? 0))}`,
    `Festive Holiday Days,${escapeCsvField(Number(periodRow?.festive_holidays ?? 0))}`,
    `Working Days (Excl. Weekend/Festive),${escapeCsvField(Number(periodRow?.working_days ?? 0))}`,
    `Leave Days (Selected Timeline),${escapeCsvField(Number(leaveRow?.leave_days ?? 0))}`,
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

    csvLines.push(
      [
        escapeCsvField(row.employee_name),
        escapeCsvField(row.employee_emp_id),
        escapeCsvField(workDate),
        escapeCsvField(clockIn),
        escapeCsvField(clockOut),
        escapeCsvField(hoursWorked),
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
    `_working-${Number(periodRow?.working_days ?? 0)}` +
    `_leave-${Number(leaveRow?.leave_days ?? 0)}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

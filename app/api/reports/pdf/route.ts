import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { formatInTimeZone } from 'date-fns-tz';
import { TIMEZONE } from '@/lib/constants';
import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
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

interface EmployeeTotals {
  name: string;
  emp_id: string;
  present: number;
  late: number;
  absent: number;
  leave: number;
  minutes: number;
  /** Approved permission minutes in the period */
  permissionMinutes: number;
  /** Worked minutes topped up by permission, capped at the shift length per day */
  creditedMinutes: number;
}

function hm(minutes: number): string {
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// GET /api/reports/pdf — manager | super_admin
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

  // Build per-employee summary
  const summaryMap = new Map<number, EmployeeTotals>();
  for (const row of rows) {
    if (!summaryMap.has(row.employee_id)) {
      summaryMap.set(row.employee_id, {
        name: row.employee_name,
        emp_id: row.employee_emp_id,
        present: 0, late: 0, absent: 0, leave: 0, minutes: 0,
        permissionMinutes: 0, creditedMinutes: 0,
      });
    }
    const s = summaryMap.get(row.employee_id)!;
    if (row.status === 'present') s.present++;
    else if (row.status === 'late') s.late++;
    else if (row.status === 'absent') s.absent++;
    else if (row.status === 'leave' || row.status === 'holiday') s.leave++;
    if (row.total_minutes) s.minutes += row.total_minutes;
    s.permissionMinutes += Number(row.permission_minutes ?? 0);
    s.creditedMinutes += creditedMinutes(
      row.total_minutes,
      Number(row.permission_minutes ?? 0),
      row.required_minutes == null ? undefined : Number(row.required_minutes),
    ) ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Build PDF
  // ---------------------------------------------------------------------------

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const generated = formatInTimeZone(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss');

  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text('Attendance Report', 14, 16);

  // Period breakdown and the hours those working days imply, so the report
  // stands on its own: calendar days -> weekly offs + holidays -> working days.
  const workingDays = Number(periodRow?.total_working_days ?? 0);
  // Expected hours use each employee's OWN shift length, never a flat 9h.
  // Employees with no schedule contribute nothing rather than a guess.
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
  const employeeCount = summaryMap.size;
  const workedTotal = Array.from(summaryMap.values()).reduce((s, e) => s + e.minutes, 0);
  const creditedTotal = Array.from(summaryMap.values()).reduce((s, e) => s + e.creditedMinutes, 0);

  // Counted off permission_requests, not off the attendance rows: an approved
  // permission on a day with no attendance row (typically one booked ahead) has
  // no detail line but still belongs in the period total, and the on-screen
  // report counts it. Summing the per-employee column would silently drop it.
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

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(`Period: ${fromDate} to ${toDate}`, 14, 23);
  doc.text(`Generated: ${generated} IST`, 14, 29);
  doc.text(`Calendar Days: ${Number(periodRow?.total_days ?? 0)}`, 85, 23);
  doc.text(`Weekly Offs: ${Number(periodRow?.weekend_days ?? 0)}`, 85, 29);
  doc.text(`Holidays: ${Number(periodRow?.festive_holidays ?? 0)}`, 130, 23);
  doc.text(`Working Days: ${workingDays}`, 130, 29);
  doc.text(`Leave Days: ${Number(leaveRow?.leave_days ?? 0)}`, 175, 23);
  doc.text(`Employees: ${employeeCount}`, 175, 29);
  doc.text(`Expected Hours: ${hm(expectedTotal)}`, 220, 23);
  doc.text(`With Shift: ${employeesWithShift}/${employeeCount}`, 220, 29);

  doc.setFontSize(9);
  doc.text(
    `Total Worked: ${hm(workedTotal)}   |   Approved Permission: ${hm(permissionTotal)}   |   Total Credited: ${hm(creditedTotal)}`,
    14, 36,
  );

  // Summary table
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('Summary', 14, 44);

  const summaryBody = Array.from(summaryMap.values()).map(s => [
    s.name,
    s.emp_id,
    String(s.present),
    String(s.late),
    String(s.absent),
    String(s.leave),
    hm(s.minutes),
    hm(s.permissionMinutes),
    hm(s.creditedMinutes),
  ]);

  autoTable(doc, {
    head: [[
      'Employee', 'ID', 'Present', 'Late', 'Absent', 'Leave',
      'Worked Hours', 'Permission', 'Credited Hours',
    ]],
    body: summaryBody,
    startY: 48,
    theme: 'striped',
    headStyles: { fillColor: [41, 128, 185], fontSize: 9, fontStyle: 'bold' },
    styles: { fontSize: 9 },
    columnStyles: {
      2: { halign: 'center' },
      3: { halign: 'center' },
      4: { halign: 'center' },
      5: { halign: 'center' },
      6: { halign: 'right' },
      7: { halign: 'right' },
      8: { halign: 'right' },
    },
  });

  // Detail table — on new page if less than 40 mm remain
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const summaryEndY: number = (doc as any).lastAutoTable?.finalY ?? 48;
  const pageHeight = doc.internal.pageSize.getHeight();

  let detailStartY: number;
  if (pageHeight - summaryEndY < 40) {
    doc.addPage();
    detailStartY = 14;
  } else {
    detailStartY = summaryEndY + 12;
  }

  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('Detail', 14, detailStartY - 4);

  const detailBody = rows.map(row => {
    const workDate = String(row.work_date).slice(0, 10);

    const clockIn = row.clock_in_utc
      ? formatInTimeZone(new Date(row.clock_in_utc as unknown as string), TIMEZONE, 'HH:mm')
      : '—';
    const clockOut = row.clock_out_utc
      ? formatInTimeZone(new Date(row.clock_out_utc as unknown as string), TIMEZONE, 'HH:mm')
      : '—';
    const hours = row.total_minutes != null ? hm(row.total_minutes) : '—';

    const permissionMinutes = Number(row.permission_minutes ?? 0);
    const credited = creditedMinutes(
      row.total_minutes,
      permissionMinutes,
      row.required_minutes == null ? undefined : Number(row.required_minutes),
    );

    return [
      workDate,
      row.employee_name,
      row.employee_emp_id,
      clockIn,
      clockOut,
      hours,
      permissionMinutes ? hm(permissionMinutes) : '—',
      credited != null ? hm(credited) : '—',
      row.status,
      row.auth_method ?? '—',
      row.geofence_status ?? '—',
    ];
  });

  autoTable(doc, {
    head: [[
      'Date', 'Employee', 'ID', 'In (IST)', 'Out (IST)', 'Hours',
      'Permission', 'Credited', 'Status', 'Auth', 'Geofence',
    ]],
    body: detailBody,
    startY: detailStartY,
    theme: 'striped',
    headStyles: { fillColor: [41, 128, 185], fontSize: 8, fontStyle: 'bold' },
    styles: { fontSize: 8 },
  });

  const totalPages = doc.getNumberOfPages();
  const footer = `Timeline: calendar ${Number(periodRow?.total_days ?? 0)} | weekly off ${Number(periodRow?.weekend_days ?? 0)} | holidays ${Number(periodRow?.festive_holidays ?? 0)} | working ${workingDays} | leave ${Number(leaveRow?.leave_days ?? 0)}`;
  const legend = 'Absent = working day with no clock-in and no approved leave.   Leave = working day formally excused by an admin.   Credited = worked + approved permission, capped at the shift length.';
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.text(footer, 14, 200);
    doc.text(legend, 14, 205);
    doc.text(`Page ${i}/${totalPages}`, 280, 205, { align: 'right' });
  }

  const buffer = Buffer.from(doc.output('arraybuffer'));
  const filename =
    `attendance_${fromDate}_to_${toDate}` +
    `_total-${Number(periodRow?.total_days ?? 0)}` +
    `_working-${Number(periodRow?.total_working_days ?? 0)}` +
    `_leave-${Number(leaveRow?.leave_days ?? 0)}.pdf`;

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

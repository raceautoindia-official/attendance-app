import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { formatInTimeZone } from 'date-fns-tz';
import { TIMEZONE } from '@/lib/constants';
import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
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

  // Build per-employee summary
  const summaryMap = new Map<number, EmployeeTotals>();
  for (const row of rows) {
    if (!summaryMap.has(row.employee_id)) {
      summaryMap.set(row.employee_id, {
        name: row.employee_name,
        emp_id: row.employee_emp_id,
        present: 0, late: 0, absent: 0, leave: 0, minutes: 0,
      });
    }
    const s = summaryMap.get(row.employee_id)!;
    if (row.status === 'present') s.present++;
    else if (row.status === 'late') s.late++;
    else if (row.status === 'absent') s.absent++;
    else if (row.status === 'leave' || row.status === 'holiday') s.leave++;
    if (row.total_minutes) s.minutes += row.total_minutes;
  }

  // ---------------------------------------------------------------------------
  // Build PDF
  // ---------------------------------------------------------------------------

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const generated = formatInTimeZone(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss');

  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text('Attendance Report', 14, 16);

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(`Period: ${fromDate} to ${toDate}`, 14, 23);
  doc.text(`Generated: ${generated} IST`, 14, 29);
  doc.text(`Total Days: ${Number(periodRow?.total_days ?? 0)}`, 95, 23);
  doc.text(`Working Days: ${Number(periodRow?.working_days ?? 0)}`, 95, 29);
  doc.text(`Leave Days: ${Number(leaveRow?.leave_days ?? 0)}`, 150, 23);
  doc.text(`Festive Holidays: ${Number(periodRow?.festive_holidays ?? 0)}`, 150, 29);

  // Summary table
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('Summary', 14, 39);

  const summaryBody = Array.from(summaryMap.values()).map(s => [
    s.name,
    s.emp_id,
    String(s.present),
    String(s.late),
    String(s.absent),
    String(s.leave),
    `${Math.floor(s.minutes / 60)}h ${s.minutes % 60}m`,
  ]);

  autoTable(doc, {
    head: [['Employee', 'ID', 'Present', 'Late', 'Absent', 'Leave', 'Total Hours']],
    body: summaryBody,
    startY: 43,
    theme: 'striped',
    headStyles: { fillColor: [41, 128, 185], fontSize: 9, fontStyle: 'bold' },
    styles: { fontSize: 9 },
    columnStyles: {
      2: { halign: 'center' },
      3: { halign: 'center' },
      4: { halign: 'center' },
      5: { halign: 'center' },
      6: { halign: 'right' },
    },
  });

  // Detail table — on new page if less than 40 mm remain
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const summaryEndY: number = (doc as any).lastAutoTable?.finalY ?? 43;
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
    const hours =
      row.total_minutes != null
        ? `${Math.floor(row.total_minutes / 60)}h ${row.total_minutes % 60}m`
        : '—';

    return [
      workDate,
      row.employee_name,
      row.employee_emp_id,
      clockIn,
      clockOut,
      hours,
      row.status,
      row.auth_method ?? '—',
      row.geofence_status ?? '—',
    ];
  });

  autoTable(doc, {
    head: [['Date', 'Employee', 'ID', 'In (IST)', 'Out (IST)', 'Hours', 'Status', 'Auth', 'Geofence']],
    body: detailBody,
    startY: detailStartY,
    theme: 'striped',
    headStyles: { fillColor: [41, 128, 185], fontSize: 8, fontStyle: 'bold' },
    styles: { fontSize: 8 },
  });

  const totalPages = doc.getNumberOfPages();
  const footer = `Timeline: total ${Number(periodRow?.total_days ?? 0)} | working ${Number(periodRow?.working_days ?? 0)} | leave ${Number(leaveRow?.leave_days ?? 0)} | festive ${Number(periodRow?.festive_holidays ?? 0)}`;
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.text(footer, 14, 205);
    doc.text(`Page ${i}/${totalPages}`, 280, 205, { align: 'right' });
  }

  const buffer = Buffer.from(doc.output('arraybuffer'));
  const filename =
    `attendance_${fromDate}_to_${toDate}` +
    `_total-${Number(periodRow?.total_days ?? 0)}` +
    `_working-${Number(periodRow?.working_days ?? 0)}` +
    `_leave-${Number(leaveRow?.leave_days ?? 0)}.pdf`;

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

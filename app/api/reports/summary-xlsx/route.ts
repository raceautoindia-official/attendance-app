import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { requireAuth } from '@/lib/auth';
import { computeSummaryReport } from '@/lib/reportSummary';

// ---------------------------------------------------------------------------
// GET /api/reports/summary-xlsx — manager | super_admin
//
// A real .xlsx of the Summary tab: one row per employee, same figures as the
// on-screen table (same computeSummaryReport() the JSON API uses, so this can
// never disagree with what an admin is looking at). Unpaginated — every
// employee in scope, in one file, which is the point of downloading it rather
// than reading the page.
//
// Leave is left out on purpose, matching the on-screen table: Absent already
// carries the "unexplained missing day" signal this report is built around,
// and the drill-down for Leave lives only in the UI (a spreadsheet has nowhere
// to click through to which days), so a bare count here would raise more
// questions than it answers. The per-day CSV export still has Leave, day by
// day, with a type — this file's exclusion applies to the summary view only.
// ---------------------------------------------------------------------------

function hm(m: number): string {
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);
  const fromDate = searchParams.get('from_date');
  const toDate = searchParams.get('to_date');
  const employeeId = searchParams.get('employee_id');
  const employeeFilterId =
    employeeId && !Number.isNaN(parseInt(employeeId, 10)) ? parseInt(employeeId, 10) : null;

  if (!fromDate || !toDate) {
    return NextResponse.json(
      { success: false, error: 'from_date and to_date are required (YYYY-MM-DD)' },
      { status: 400 },
    );
  }

  const { summary, period, totals } = await computeSummaryReport({
    fromDate,
    toDate,
    employeeFilterId,
    managerId: auth.role === 'manager' ? auth.id : null,
    // No page/limit: every employee in scope, in one sheet.
  });

  // Same shape as the on-screen table, minus Leave — see the note above.
  const HEADERS = [
    'Employee', 'Employee ID', 'Work Status', 'Work Updates (days)',
    'Calendar Days', 'Working Days', 'Weekly Offs', 'Holidays',
    'Present', 'Late (days)', 'Late (h m)', 'Absent',
    'Worked Hours', 'Permission', 'Credited Hours', 'Overtime',
    'Expected Hours', 'Avg / Day', 'Attendance %',
  ];

  const dataRows = summary.map(r => {
    const credited = r.total_minutes_credited ?? r.total_minutes_worked;
    return [
      r.name,
      r.emp_id,
      r.work_mode === 'off_site' ? 'Off-site' : 'On-site',
      r.daily_updates_count || '',
      r.calendar_days,
      r.working_days,
      r.weekly_off_days,
      r.company_holidays,
      r.total_days_present,
      r.total_days_late,
      r.late_minutes ? hm(r.late_minutes) : '',
      r.total_days_absent,
      hm(r.total_minutes_worked),
      r.total_permission_minutes ? hm(r.total_permission_minutes) : '',
      hm(credited),
      r.total_overtime_minutes > 0 ? hm(r.total_overtime_minutes) : '',
      r.expected_minutes != null ? hm(r.expected_minutes) : 'No shift',
      r.days_with_hours > 0 ? hm(Math.round(credited / r.days_with_hours)) : '',
      r.attendance_percentage != null ? `${r.attendance_percentage}%` : '',
    ];
  });

  // A small period-summary block above the table, same numbers the page's own
  // "Period" card shows, so the file stands on its own without the screen.
  const summaryBlock: (string | number)[][] = [
    ['Attendance Summary Report'],
    ['From', fromDate, 'To', toDate],
    [],
    ['Calendar Days', period.total_days, 'Holidays', period.festive_holidays, 'Weekly Offs', period.weekend_days],
    ['Working Days', period.total_working_days, 'Leave Days (all employees)', period.total_leave_days],
    ['Employees', totals.employees, 'With a shift assigned', totals.employees_with_shift],
    ['Expected Hours', hm(totals.expected_minutes), 'Worked Hours', hm(totals.minutes_worked)],
    ['Permission Hours', hm(totals.permission_minutes), 'Credited Hours', hm(totals.minutes_credited)],
    [],
  ];

  const sheetData = [...summaryBlock, HEADERS, ...dataRows];
  const worksheet = XLSX.utils.aoa_to_sheet(sheetData);

  // Column widths sized to the header text so nothing renders truncated on
  // first open — a spreadsheet nobody has to manually widen before reading.
  worksheet['!cols'] = HEADERS.map(h => ({ wch: Math.max(h.length + 2, 10) }));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Summary');

  const buffer = Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  const filename = `attendance_summary_${fromDate}_to_${toDate}.xlsx`;

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { overtimeMinutes, lateMinutes, breakMinutes } from '@/lib/attendance';
import {
  hasSessionColumns,
  hasFirstClockInColumn,
  hasDailyUpdatesTable,
} from '@/lib/employeeDetails';
import { hasPermissionTable, hasOnDutyColumn, timeOffOnly } from '@/lib/permissions';
import { shiftsForEmployees, workingWeekdays } from '@/lib/shifts';
import { WEEKLY_OFF_DAYS } from '@/lib/constants';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// GET /api/reports/daily?from_date=&to_date=&employee_id=
//
// Day by day, per employee, for a period: what time they came in and left, the
// break, the hours, how late, overtime, permission, leave, what the day counts
// as, and what they said they worked on.
//
// EVERY DAY IN THE RANGE IS A ROW, not only the days with an attendance record.
// A day nobody clocked in has no attendance row at all until the end-of-day job
// writes one, and a weekly off never gets one — so a report built from
// attendance rows silently skips exactly the days somebody is asking about.
// The calendar is walked here instead, and each day is labelled for what it is.
// ---------------------------------------------------------------------------

interface DailyRow {
  employee_id: number;
  employee_name: string;
  emp_id: string;
  /** YYYY-MM-DD */
  date: string;
  /** Mon, Tue, … — the weekday of the date itself. */
  day: string;
  check_in_utc: string | null;
  check_out_utc: string | null;
  break_minutes: number | null;
  worked_minutes: number | null;
  late_minutes: number | null;
  overtime_minutes: number;
  permission_minutes: number;
  leave_type: string | null;
  /** present | late | absent | leave | holiday | early_departure | weekly_off */
  day_status: string;
  work_update: string | null;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Every date from `from` to `to` inclusive, as YYYY-MM-DD. */
function dateRange(from: string, to: string, cap: number): string[] {
  const out: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return out;
  for (let t = start; t <= end && out.length < cap; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const sp = request.nextUrl.searchParams;
  const isDate = (v: string | null) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const fromDate = sp.get('from_date');
  const toDate = sp.get('to_date');
  if (!isDate(fromDate) || !isDate(toDate)) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'from_date and to_date are required (YYYY-MM-DD)' },
      { status: 400 },
    );
  }
  const from = fromDate as string;
  const to = toDate as string;

  const employeeParam = sp.get('employee_id');
  const employeeFilterId = employeeParam && !Number.isNaN(parseInt(employeeParam, 10))
    ? parseInt(employeeParam, 10)
    : null;

  const dates = dateRange(from, to, 366);
  if (!dates.length) {
    return NextResponse.json<ApiResponse<{ rows: DailyRow[]; truncated: boolean }>>(
      { success: true, data: { rows: [], truncated: false } },
    );
  }

  const scope = auth.role === 'manager' ? 'AND e.manager_id = ?' : '';
  const scopeParams = auth.role === 'manager' ? [auth.id] : [];
  const empFilter = employeeFilterId !== null ? 'AND e.id = ?' : '';
  const empParams = employeeFilterId !== null ? [employeeFilterId] : [];

  const employees = await query<{ id: number; name: string; emp_id: string }>(
    `SELECT e.id, e.name, e.emp_id
       FROM employees e
      WHERE e.is_active = TRUE ${scope} ${empFilter}
      ORDER BY e.name ASC`,
    [...scopeParams, ...empParams],
  );
  if (!employees.length) {
    return NextResponse.json<ApiResponse<{ rows: DailyRow[]; truncated: boolean }>>(
      { success: true, data: { rows: [], truncated: false } },
    );
  }

  const empIds = employees.map(e => e.id);
  const idPh = empIds.map(() => '?').join(',');

  const [sessionCols, firstInCol, updatesTable, permissionsAvailable] = await Promise.all([
    hasSessionColumns(),
    hasFirstClockInColumn(),
    hasDailyUpdatesTable(),
    hasPermissionTable(),
  ]);
  const hasType = permissionsAvailable ? await hasOnDutyColumn() : false;

  // Attendance, with the shift in force on each row's own date — the lateness
  // deadline belongs to the day, not to today's roster.
  const attendance = await query<{
    employee_id: number; work_date: string;
    clock_in_utc: string | null; clock_out_utc: string | null;
    first_clock_in_utc: string | null;
    total_minutes: number | null; banked_minutes: number | null;
    status: string;
    shift_start_time: string | null; shift_grace_minutes: number | null; shift_type: string | null;
  }>(
    `SELECT a.employee_id, DATE_FORMAT(a.work_date, '%Y-%m-%d') AS work_date,
            a.clock_in_utc, a.clock_out_utc,
            ${firstInCol ? 'a.first_clock_in_utc' : 'NULL'} AS first_clock_in_utc,
            a.total_minutes,
            ${sessionCols ? 'a.banked_minutes' : '0'} AS banked_minutes,
            a.status,
            s.start_time AS shift_start_time, s.grace_minutes AS shift_grace_minutes,
            s.type AS shift_type
       FROM attendance a
       LEFT JOIN employee_schedules es ON es.id = (
         SELECT es2.id FROM employee_schedules es2
          WHERE es2.employee_id = a.employee_id
            AND es2.effective_from <= a.work_date
            AND (es2.effective_to IS NULL OR es2.effective_to >= a.work_date)
          ORDER BY es2.effective_from DESC, es2.id DESC LIMIT 1)
       LEFT JOIN shifts s ON s.id = es.shift_id
      WHERE a.work_date BETWEEN ? AND ?
        AND a.employee_id IN (${idPh})`,
    [from, to, ...empIds],
  );

  // A company-wide holiday has employee_id NULL and belongs to everybody.
  const leaves = await query<{ employee_id: number | null; leave_date: string; leave_type: string }>(
    `SELECT lr.employee_id, DATE_FORMAT(lr.leave_date, '%Y-%m-%d') AS leave_date, lr.leave_type
       FROM leave_records lr
      WHERE lr.leave_date BETWEEN ? AND ?
        AND (lr.employee_id IS NULL OR lr.employee_id IN (${idPh}))`,
    [from, to, ...empIds],
  );

  const permissions = permissionsAvailable
    ? await query<{ employee_id: number; permission_date: string; minutes: number }>(
        `SELECT pr.employee_id,
                DATE_FORMAT(pr.permission_date, '%Y-%m-%d') AS permission_date,
                SUM(pr.minutes) AS minutes
           FROM permission_requests pr
          WHERE pr.status = 'approved'
            ${timeOffOnly(hasType, 'pr')}
            AND pr.permission_date BETWEEN ? AND ?
            AND pr.employee_id IN (${idPh})
          GROUP BY pr.employee_id, pr.permission_date`,
        [from, to, ...empIds],
      )
    : [];

  const updates = updatesTable
    ? await query<{ employee_id: number; work_date: string; update_text: string }>(
        `SELECT dwu.employee_id, DATE_FORMAT(dwu.work_date, '%Y-%m-%d') AS work_date,
                GROUP_CONCAT(dwu.update_text ORDER BY dwu.created_at ASC SEPARATOR ' | ') AS update_text
           FROM daily_work_updates dwu
          WHERE dwu.work_date BETWEEN ? AND ?
            AND dwu.employee_id IN (${idPh})
          GROUP BY dwu.employee_id, dwu.work_date`,
        [from, to, ...empIds],
      )
    : [];

  // Which weekdays each employee's own shift works — a Saturday is a working
  // day on some shifts and an off day on others.
  const shifts = await shiftsForEmployees(empIds, to);

  const key = (id: number, d: string) => `${id}|${d}`;
  const attByKey = new Map(attendance.map(a => [key(a.employee_id, a.work_date), a]));
  const permByKey = new Map(permissions.map(p => [key(p.employee_id, p.permission_date), Number(p.minutes)]));
  const updByKey = new Map(updates.map(u => [key(u.employee_id, u.work_date), u.update_text]));
  const leaveByKey = new Map<string, string>();
  for (const l of leaves) {
    // A personal record beats a company-wide one: it is the more specific fact
    // about that person's day.
    if (l.employee_id === null) {
      for (const e of employees) {
        const k = key(e.id, l.leave_date);
        if (!leaveByKey.has(k)) leaveByKey.set(k, l.leave_type);
      }
    } else {
      leaveByKey.set(key(l.employee_id, l.leave_date), l.leave_type);
    }
  }

  const MAX_ROWS = 5000;
  const rows: DailyRow[] = [];
  let truncated = false;

  for (const e of employees) {
    const own = shifts.get(e.id) ?? [];
    const worksOn = own.length ? new Set(workingWeekdays(own)) : null;

    for (const d of dates) {
      if (rows.length >= MAX_ROWS) { truncated = true; break; }
      const weekday = WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()];
      const a = attByKey.get(key(e.id, d));
      const leaveType = leaveByKey.get(key(e.id, d)) ?? null;
      // No shift assigned falls back to the company weekly-off rule, the same
      // fallback the end-of-day absent job uses.
      const isWorkingDay = worksOn ? worksOn.has(weekday) : !WEEKLY_OFF_DAYS.includes(weekday);

      const banked = Number(a?.banked_minutes ?? 0);
      const worked = a?.total_minutes ?? (banked > 0 ? banked : null);
      const firstIn = a?.first_clock_in_utc ?? a?.clock_in_utc ?? null;

      const day_status = a?.clock_in_utc
        ? a.status
        : leaveType === 'holiday' ? 'holiday'
          : leaveType ? 'leave'
            : !isWorkingDay ? 'weekly_off'
              : a?.status ?? 'absent';

      rows.push({
        employee_id: e.id,
        employee_name: e.name,
        emp_id: e.emp_id,
        date: d,
        day: weekday,
        check_in_utc: firstIn,
        check_out_utc: a?.clock_out_utc ?? null,
        break_minutes: breakMinutes(
          firstIn ? new Date(firstIn) : null,
          a?.clock_in_utc ? new Date(a.clock_in_utc) : null,
          a?.clock_out_utc ? new Date(a.clock_out_utc) : null,
          worked, banked,
        ),
        worked_minutes: worked,
        late_minutes: lateMinutes(
          firstIn ? new Date(firstIn) : null,
          a?.shift_start_time, a?.shift_grace_minutes, a?.shift_type,
        ),
        overtime_minutes: overtimeMinutes(worked),
        permission_minutes: permByKey.get(key(e.id, d)) ?? 0,
        leave_type: leaveType,
        day_status,
        work_update: updByKey.get(key(e.id, d)) ?? null,
      });
    }
    if (truncated) break;
  }

  return NextResponse.json<ApiResponse<{
    rows: DailyRow[]; truncated: boolean; from_date: string; to_date: string;
  }>>(
    { success: true, data: { rows, truncated, from_date: from, to_date: to } },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

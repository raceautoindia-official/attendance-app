import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { getWorkDateIST, overtimeMinutes, lateMinutes, breakMinutes } from '@/lib/attendance';
import { hasSessionColumns, hasOutOfFenceReasonColumn, hasFirstClockInColumn } from '@/lib/employeeDetails';
import { creditedMinutes, hasPermissionTable, permissionMinutesSelect } from '@/lib/permissions';
import { dayRequiredMinutesSelect } from '@/lib/shifts';
import { WEEKLY_OFF_DAYS } from '@/lib/constants';
import { formatInTimeZone } from 'date-fns-tz';
import type { ApiResponse, DayAttendanceRow } from '@/lib/types';

// ---------------------------------------------------------------------------
// GET /api/attendance/day?date=YYYY-MM-DD
//
// EVERY active employee for one work day — not only the ones with a row.
//
// /api/attendance lists attendance RECORDS, so somebody who has not clocked in
// simply is not in it: no row exists until they clock in, or until the
// end-of-day job writes an absent one that night. The admin's day view was
// therefore missing exactly the people it most needed to show, and shrank as
// the morning went on rather than filling up.
//
// This starts from the EMPLOYEE and joins the day onto them, so the list is
// always the whole workforce and a missing day is visible as a missing day.
//
// Not paginated on purpose: it is one row per employee, and the whole point is
// that the caller has all of them. That also makes filtering in the browser
// honest — there is no page two for a filter to miss.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const param = request.nextUrl.searchParams.get('date');
  const workDate = /^\d{4}-\d{2}-\d{2}$/.test(param ?? '') ? (param as string) : getWorkDateIST();

  const [permissionsAvailable, sessionCols, reasonCol, firstInCol] = await Promise.all([
    hasPermissionTable(),
    hasSessionColumns(),
    hasOutOfFenceReasonColumn(),
    hasFirstClockInColumn(),
  ]);
  // These helpers are normally handed COLUMN names (a.employee_id, a.work_date)
  // and so need no parameters. Here the date is a constant, so it goes in as a
  // placeholder — and each helper expands to a DIFFERENT number of them: the
  // required-minutes expression alone contains five. Counting them is the only
  // way to stay in step; a hand-written number was wrong the first time and
  // would be wrong again the next time either helper changes.
  const permissionExpr = permissionMinutesSelect(permissionsAvailable, 'e.id', '?');
  const requiredExpr = dayRequiredMinutesSelect('e.id', '?');
  const fill = (expr: string, value: unknown) =>
    Array((expr.match(/\?/g) ?? []).length).fill(value);

  // Was this person even due in today? Without it, every employee reads as
  // ABSENT on a Sunday — and the "Not In Yet" card, which does apply the rule,
  // would say nobody is missing while the table underneath listed the whole
  // company as absent. Same rule as the end-of-day job: the shift's own
  // working days, falling back to the company weekly-off for anyone with no
  // shift. The weekday belongs to the DATE, so it is read in UTC off a UTC
  // anchor rather than through a timezone that could name yesterday.
  const weekdayAbbr = formatInTimeZone(new Date(`${workDate}T00:00:00Z`), 'UTC', 'EEE');
  const isCompanyOffDay = WEEKLY_OFF_DAYS.includes(weekdayAbbr);

  // Managers see their own team, super admins see everyone — the same scoping
  // /api/attendance applies, enforced here rather than trusted from the caller.
  const scope = auth.role === 'manager' ? 'AND e.manager_id = ?' : '';
  const scopeParams = auth.role === 'manager' ? [auth.id] : [];

  // The SELECT shape, not the response shape: it carries the raw columns the
  // derivation needs (total_minutes, the shift's start and grace) which the
  // response then turns into worked / late / break and drops.
  const rows = await query<Omit<DayAttendanceRow, 'status' | 'geofence_status'> & {
    status: DayAttendanceRow['status'] | null;
    geofence_status: DayAttendanceRow['geofence_status'];
    total_minutes: number | null;
    expected_today: number | boolean | null;
    shift_start_time: string | null;
    shift_grace_minutes: number | null;
    shift_type: string | null;
    banked_minutes: number | null;
    leave_type: string | null;
  }>(
    `SELECT
       e.id   AS employee_id,
       e.name AS employee_name,
       e.emp_id,
       e.role,
       a.id   AS attendance_id,
       a.clock_in_utc,
       a.clock_out_utc,
       a.total_minutes,
       a.status,
       a.geofence_status,
       ${firstInCol ? 'a.first_clock_in_utc,' : 'NULL AS first_clock_in_utc,'}
       ${reasonCol ? 'a.out_of_fence_reason,' : 'NULL AS out_of_fence_reason,'}
       ${sessionCols ? 'a.banked_minutes, a.session_count,' : '0 AS banked_minutes, 1 AS session_count,'}
       -- Whether a fence applies to this person AT ALL. Without it the Geofence
       -- column cannot tell "switched off for them" apart from "no reading yet",
       -- and it showed a blank for both.
       COALESCE(es.geofencing_enabled, FALSE) AS geofencing_enabled,
       l.name AS location_name,
       l.radius_meters AS location_radius_m,
       s.start_time AS shift_start_time,
       s.grace_minutes AS shift_grace_minutes,
       s.type AS shift_type,
       ${permissionExpr} AS permission_minutes,
       ${requiredExpr} AS required_minutes,
       (SELECT lr.leave_type
          FROM leave_records lr
         WHERE lr.leave_date = ?
           AND (lr.employee_id = e.id OR lr.employee_id IS NULL)
         ORDER BY (lr.employee_id IS NULL) ASC
         LIMIT 1) AS leave_type,
       (
         (s.id IS NOT NULL AND JSON_CONTAINS(s.working_days, JSON_QUOTE(?)))
         OR (s.id IS NULL AND ? = FALSE)
       ) AS expected_today
     FROM employees e
     LEFT JOIN attendance a ON a.employee_id = e.id AND a.work_date = ?
     LEFT JOIN employee_schedules es
       ON es.id = (
         SELECT es2.id FROM employee_schedules es2
         WHERE es2.employee_id = e.id
           AND es2.effective_from <= ?
           AND (es2.effective_to IS NULL OR es2.effective_to >= ?)
         ORDER BY es2.effective_from DESC, es2.id DESC
         LIMIT 1
       )
     LEFT JOIN shifts s ON s.id = es.shift_id
     LEFT JOIN locations l ON l.id = es.location_id AND l.is_active = TRUE
     WHERE e.is_active = TRUE
       ${scope}
     ORDER BY e.name ASC`,
    [
      ...fill(permissionExpr, workDate),   // permission_minutes
      ...fill(requiredExpr, workDate),     // required_minutes
      workDate,                            // leave / holiday for the day
      weekdayAbbr, isCompanyOffDay,        // expected_today
      workDate,                            // attendance join
      workDate, workDate,                  // the schedule in force that day
      ...scopeParams,
    ],
  );

  const employees = rows.map(r => {
    const banked = Number(r.banked_minutes ?? 0);
    const worked = r.total_minutes ?? (banked > 0 ? banked : null);
    const firstIn = r.first_clock_in_utc ?? r.clock_in_utc;
    const permission = Number(r.permission_minutes ?? 0);
    const required = r.required_minutes == null ? undefined : Number(r.required_minutes);

    // The status of a day with no row at all. The row is only written when they
    // clock in, or that night by the end-of-day job — so until then the day has
    // to be described rather than read.
    const expected = !!Number(r.expected_today ?? 0);
    const status = r.status
      ?? (r.leave_type === 'holiday' ? 'holiday' : r.leave_type ? 'leave' : 'absent');

    return {
      employee_id: r.employee_id,
      employee_name: r.employee_name,
      emp_id: r.emp_id,
      role: r.role,
      attendance_id: r.attendance_id ?? null,
      clock_in_utc: r.clock_in_utc ?? null,
      clock_out_utc: r.clock_out_utc ?? null,
      first_clock_in_utc: firstIn ?? null,
      status,
      // 'not_required' is the honest answer for someone with no fence, and
      // NULL for someone who has not clocked in yet — there is no reading to
      // report, which is different from a reading of "outside".
      geofence_status: r.attendance_id ? (r.geofence_status ?? 'not_required') : null,
      geofencing_enabled: !!r.geofencing_enabled,
      location_name: r.location_name ?? null,
      location_radius_m: r.location_radius_m == null ? null : Number(r.location_radius_m),
      out_of_fence_reason: r.out_of_fence_reason ?? null,
      worked_minutes: worked,
      credited_minutes: creditedMinutes(worked, permission, required),
      required_minutes: required ?? null,
      permission_minutes: permission,
      overtime_minutes: overtimeMinutes(worked),
      late_minutes: lateMinutes(
        firstIn ? new Date(firstIn) : null,
        r.shift_start_time,
        r.shift_grace_minutes,
        r.shift_type,
      ),
      break_minutes: breakMinutes(
        firstIn ? new Date(firstIn) : null,
        r.clock_in_utc ? new Date(r.clock_in_utc) : null,
        r.clock_out_utc ? new Date(r.clock_out_utc) : null,
        worked,
        banked,
      ),
      session_count: Number(r.session_count ?? 1),
      expected_today: expected,
    };
  });

  return NextResponse.json<ApiResponse<{ work_date: string; employees: DayAttendanceRow[] }>>(
    { success: true, data: { work_date: workDate, employees } },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

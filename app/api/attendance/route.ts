import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/lib/constants';
import { hasSessionColumns, hasOutOfFenceReasonColumn, hasFirstClockInColumn } from '@/lib/employeeDetails';
import {
  creditedMinutes,
  hasPermissionTable,
  permissionMinutesSelect,
} from '@/lib/permissions';
import { dayRequiredMinutesSelect } from '@/lib/shifts';
import type { ApiResponse, AttendanceRecord } from '@/lib/types';

// ---------------------------------------------------------------------------
// GET /api/attendance
// Paginated attendance list.
// employee: own records, manager: team records, super_admin: all records.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['employee', 'manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);

  // Pagination
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
  const limit = Math.min(
    Math.max(1, parseInt(searchParams.get('limit') ?? String(DEFAULT_PAGE_SIZE), 10)),
    MAX_PAGE_SIZE,
  );
  const offset = (page - 1) * limit;

  // Filters
  const date = searchParams.get('date');
  const fromDate = searchParams.get('from_date');
  const toDate = searchParams.get('to_date');
  const employeeId = searchParams.get('employee_id');
  const employeeSearch = searchParams.get('employee_search');
  const status = searchParams.get('status');

  // ---------------------------------------------------------------------------
  // Build WHERE clause dynamically
  // ---------------------------------------------------------------------------

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (auth.role === 'employee') {
    conditions.push('a.employee_id = ?');
    params.push(auth.id);
  } else if (auth.role === 'manager') {
    // Scope enforcement: managers can only see their own team
    conditions.push(
      `a.employee_id IN (SELECT id FROM employees WHERE manager_id = ?)`,
    );
    params.push(auth.id);
  }

  // Date filters (exact date takes priority over range)
  if (date) {
    conditions.push('a.work_date = ?');
    params.push(date);
  } else {
    if (fromDate) {
      conditions.push('a.work_date >= ?');
      params.push(fromDate);
    }
    if (toDate) {
      conditions.push('a.work_date <= ?');
      params.push(toDate);
    }
  }

  if (employeeId) {
    conditions.push('a.employee_id = ?');
    params.push(parseInt(employeeId, 10));
  }

  if (employeeSearch) {
    conditions.push('(e.name LIKE ? OR e.emp_id LIKE ?)');
    params.push(`%${employeeSearch}%`, `%${employeeSearch}%`);
  }

  // Validate status value against allowed enum before injecting into SQL
  const validStatuses = [
    'present', 'late', 'early_departure', 'absent', 'leave', 'holiday',
  ];
  if (status && validStatuses.includes(status)) {
    conditions.push('a.status = ?');
    params.push(status);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // ---------------------------------------------------------------------------
  // Run count + data queries in parallel
  // ---------------------------------------------------------------------------

  // Approved permission hours for the row's date, plus what the day's shift
  // requires — together they give the credited hours (see creditedMinutes()).
  const [permissionsAvailable, sessionCols, reasonCol, firstInCol] = await Promise.all([
    hasPermissionTable(),
    hasSessionColumns(),
    hasOutOfFenceReasonColumn(),
    hasFirstClockInColumn(),
  ]);
  const permissionExpr = permissionMinutesSelect(
    permissionsAvailable,
    'a.employee_id',
    'a.work_date',
  );

  const [countRow, rows] = await Promise.all([
    queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total
       FROM attendance a
       JOIN employees e ON a.employee_id = e.id
       ${whereClause}`,
      [...params],
    ),
    query<AttendanceRecord>(
      `SELECT a.id, a.employee_id, DATE_FORMAT(a.work_date, '%Y-%m-%d') AS work_date,
              a.clock_in_utc, a.clock_out_utc, a.clock_in_lat, a.clock_in_lng,
              a.clock_out_lat, a.clock_out_lng, a.ip_address, a.geofence_status,
              a.auth_method, a.total_minutes, a.status, a.notes, a.edited_by, a.edited_at,
              ${reasonCol ? 'a.out_of_fence_reason,' : 'NULL AS out_of_fence_reason,'}
              ${firstInCol ? 'a.first_clock_in_utc,' : 'NULL AS first_clock_in_utc,'}
              ${sessionCols ? 'a.banked_minutes, a.session_count,' : '0 AS banked_minutes, 1 AS session_count,'}
              e.name AS employee_name, e.emp_id,
              l.name AS location_name, l.address AS location_address,
              ${permissionExpr} AS permission_minutes,
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
       LEFT JOIN locations l ON l.id = es.location_id
       ${whereClause}
       ORDER BY a.work_date DESC, a.clock_in_utc DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ),
  ]);

  const records = rows.map(r => {
    const permission = Number(r.permission_minutes ?? 0);
    // A required of 0 is meaningful — the employee is scheduled, but this
    // weekday isn't one their shift works, so nothing is demanded of them.
    // Only a missing value falls back to the standard shift.
    const required = r.required_minutes == null ? undefined : Number(r.required_minutes);
    // Multi-session days carry minutes from finished sessions in banked_minutes
    // while a later session is open (total_minutes is NULL until it closes) —
    // credit those so a plant employee's hours aren't shown as blank mid-day.
    const banked = Number(r.banked_minutes ?? 0);
    const worked = r.total_minutes ?? (banked > 0 ? banked : null);
    // Hours beyond what the day asked for. Reported separately from credited
    // minutes, which cap at the rostered day — overtime is precisely the part
    // that cap hides, and it is the reason a day can read more than a shift.
    const overtime = worked != null && required != null && worked > required
      ? worked - required
      : 0;
    return {
      ...r,
      banked_minutes: banked,
      session_count: Number(r.session_count ?? 1),
      permission_minutes: permission,
      required_minutes: required,
      credited_minutes: creditedMinutes(worked, permission, required),
      worked_minutes: worked,
      overtime_minutes: overtime,
    };
  });

  const total = Number(countRow?.total ?? 0);
  const totalPages = Math.ceil(total / limit);

  return NextResponse.json<ApiResponse<{
    records: AttendanceRecord[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }>>(
    {
      success: true,
      data: {
        records,
        pagination: { page, limit, total, totalPages },
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

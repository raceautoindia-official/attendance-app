import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool, query, queryOne, insertAuditLog } from '@/lib/db';
import { sendPermissionRequestAlert } from '@/lib/mailer';
import { requireAuth } from '@/lib/auth';
import { getClientIp, getWorkDateIST } from '@/lib/attendance';
import { formatInTimeZone } from 'date-fns-tz';
import { TIMEZONE } from '@/lib/constants';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  PERMISSION_MAX_FUTURE_DAYS,
  PERMISSION_MAX_MINUTES_PER_MONTH,
  PERMISSION_MAX_MINUTES_PER_REQUEST,
  PERMISSION_MAX_PAST_DAYS,
  PERMISSION_MIN_MINUTES,
} from '@/lib/constants';
import {
  canReviewEmployee,
  durationMinutes,
  formatMinutes,
  getMonthlyBalance,
  hasOnDutyColumn,
  hasPermissionTable,
  missingPermissionTableError,
  monthBounds,
  timeOffOnly,
  toSqlTime,
} from '@/lib/permissions';
import type { ApiResponse, PermissionRequest } from '@/lib/types';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const CreatePermissionSchema = z.object({
  // Admins only — when omitted the request is filed for the caller.
  employee_id: z.number().int().positive().optional(),
  // 'permission' = paid time off. 'on_duty' = official work away from the site:
  // no quota, no credited hours, and the geofence must not clock them out.
  request_type: z.enum(['permission', 'on_duty']).default('permission'),
  permission_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'permission_date must be YYYY-MM-DD'),
  start_time: z.string().min(4, 'start_time is required'),
  end_time: z.string().min(4, 'end_time is required'),
  reason: z.string().max(500).nullable().optional(),
});

function badRequest(error: string, status = 400) {
  return NextResponse.json<ApiResponse>({ success: false, error }, { status });
}

/** Days between two YYYY-MM-DD dates (b - a), calendar days, sign preserved. */
function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000,
  );
}

// ---------------------------------------------------------------------------
// GET /api/permissions
// employee -> own requests | manager -> own + team | super_admin -> everyone
// Filters: status, from_date, to_date, employee_id. Paginated.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['employee', 'manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  if (!(await hasPermissionTable())) {
    // Not an error for the clients — the feature simply has no data yet.
    return NextResponse.json<ApiResponse<{
      permissions: PermissionRequest[];
      pagination: { page: number; limit: number; total: number; totalPages: number };
      migration_pending: boolean;
    }>>({
      success: true,
      data: {
        permissions: [],
        pagination: { page: 1, limit: DEFAULT_PAGE_SIZE, total: 0, totalPages: 0 },
        migration_pending: true,
      },
    });
  }

  const { searchParams } = new URL(request.url);

  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
  const limit = Math.min(
    Math.max(1, parseInt(searchParams.get('limit') ?? String(DEFAULT_PAGE_SIZE), 10)),
    MAX_PAGE_SIZE,
  );
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (auth.role === 'employee') {
    conditions.push('pr.employee_id = ?');
    params.push(auth.id);
  } else if (auth.role === 'manager') {
    conditions.push(
      '(pr.employee_id = ? OR pr.employee_id IN (SELECT id FROM employees WHERE manager_id = ?))',
    );
    params.push(auth.id, auth.id);
  }

  const status = searchParams.get('status');
  if (status && ['pending', 'approved', 'rejected', 'cancelled'].includes(status)) {
    conditions.push('pr.status = ?');
    params.push(status);
  }

  const fromDate = searchParams.get('from_date');
  const toDate = searchParams.get('to_date');
  if (fromDate) {
    conditions.push('pr.permission_date >= ?');
    params.push(fromDate);
  }
  if (toDate) {
    conditions.push('pr.permission_date <= ?');
    params.push(toDate);
  }

  const employeeId = searchParams.get('employee_id');
  if (employeeId && auth.role !== 'employee') {
    const eid = parseInt(employeeId, 10);
    if (!Number.isNaN(eid)) {
      conditions.push('pr.employee_id = ?');
      params.push(eid);
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // The deployment timezone as a CONVERT_TZ offset string, e.g. "+05:30".
  const tzOffset = formatInTimeZone(new Date(), TIMEZONE, 'xxx');

  const [countRow, rows, pendingRow] = await Promise.all([
    queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM permission_requests pr ${where}`,
      [...params],
    ),
    // The deployment timezone as a CONVERT_TZ offset (e.g. "+05:30").
    // Hard-coding the offset was the one place this file assumed India; the
    // named-zone form of CONVERT_TZ needs tz tables MySQL often lacks, so the
    // offset is computed here instead. Taken at request time, which is exact
    // except for rows filed within an hour of a DST change - day-granularity
    // backdating flags can carry that.
    query<PermissionRequest>(
      `SELECT pr.id, pr.employee_id,
              ${await hasOnDutyColumn() ? 'pr.request_type' : "'permission' AS request_type"},
              DATE_FORMAT(pr.permission_date, '%Y-%m-%d') AS permission_date,
              pr.start_time, pr.end_time, pr.minutes, pr.reason, pr.status,
              pr.requested_by, pr.reviewed_by, pr.reviewed_at, pr.review_notes,
              pr.created_at, pr.updated_at,
              -- Filed after the date it covers. Approvers should see that
              -- plainly rather than having to compare two dates themselves.
              -- created_at is UTC while permission_date is an IST calendar day,
              -- so convert first: between midnight and 05:30 IST the raw UTC
              -- date is still the previous day, and a late filing in that
              -- window would not have been flagged.
              (DATE(CONVERT_TZ(pr.created_at, '+00:00', ?)) > pr.permission_date) AS is_backdated,
              DATEDIFF(DATE(CONVERT_TZ(pr.created_at, '+00:00', ?)), pr.permission_date) AS days_late,
              e.name   AS employee_name,
              e.emp_id AS employee_emp_id,
              r.name   AS reviewed_by_name
       FROM permission_requests pr
       JOIN employees e ON e.id = pr.employee_id
       LEFT JOIN employees r ON r.id = pr.reviewed_by
       ${where}
       ORDER BY pr.permission_date DESC, pr.start_time DESC, pr.id DESC
       LIMIT ? OFFSET ?`,
      [tzOffset, tzOffset, ...params, limit, offset],
    ),
    // Badge count for the admin queue — same scope, ignoring the other filters.
    auth.role === 'employee'
      ? Promise.resolve(null)
      : queryOne<{ total: number }>(
          `SELECT COUNT(*) AS total
           FROM permission_requests pr
           WHERE pr.status = 'pending'
             ${auth.role === 'manager'
               ? 'AND pr.employee_id IN (SELECT id FROM employees WHERE manager_id = ?)'
               : ''}`,
          auth.role === 'manager' ? [auth.id] : [],
        ),
  ]);

  const total = Number(countRow?.total ?? 0);

  // TOTAL PERMISSION HOURS PER EMPLOYEE, over the same filter.
  //
  // The list is a page of individual requests, which never answers "how much
  // has this person taken" — the question a monthly review actually asks. Only
  // APPROVED minutes are totalled: a pending or rejected request is not time
  // anybody has had.
  //
  // Deliberately NOT limited to the current page: the totals are for the
  // filter, so page two does not report different numbers from page one.
  const totalsRows = await query<{
    employee_id: number; employee_name: string; emp_id: string;
    approved_minutes: number; approved_count: number;
    pending_count: number; rejected_count: number;
  }>(
    `SELECT pr.employee_id,
            e.name AS employee_name, e.emp_id,
            COALESCE(SUM(CASE WHEN pr.status = 'approved' THEN pr.minutes ELSE 0 END), 0) AS approved_minutes,
            COALESCE(SUM(pr.status = 'approved'), 0) AS approved_count,
            COALESCE(SUM(pr.status = 'pending'), 0)  AS pending_count,
            COALESCE(SUM(pr.status = 'rejected'), 0) AS rejected_count
       FROM permission_requests pr
       JOIN employees e ON e.id = pr.employee_id
       ${where}
      GROUP BY pr.employee_id, e.name, e.emp_id
      ORDER BY approved_minutes DESC, e.name ASC`,
    params,
  );
  const employee_totals = totalsRows.map(t => ({
    employee_id: t.employee_id,
    employee_name: t.employee_name,
    emp_id: t.emp_id,
    approved_minutes: Number(t.approved_minutes),
    approved_count: Number(t.approved_count),
    pending_count: Number(t.pending_count),
    rejected_count: Number(t.rejected_count),
  }));

  return NextResponse.json<ApiResponse<{
    permissions: PermissionRequest[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
    pending_count: number;
    employee_totals: typeof employee_totals;
  }>>(
    {
      success: true,
      data: {
        permissions: rows.map(r => ({ ...r, minutes: Number(r.minutes) })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        pending_count: Number(pendingRow?.total ?? 0),
        employee_totals,
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

// ---------------------------------------------------------------------------
// POST /api/permissions — apply for permission hours.
// Employees file for themselves (status pending). An admin filing for someone
// they may review records it already approved, like "Mark Leave" does.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['employee', 'manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  if (!(await hasPermissionTable())) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: missingPermissionTableError() },
      { status: 503 },
    );
  }

  let body: unknown;
  try { body = await request.json(); }
  catch { return badRequest('Invalid JSON body'); }

  const parsed = CreatePermissionSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? 'Validation error');
  }

  const { permission_date, reason } = parsed.data;
  const targetEmployeeId = parsed.data.employee_id ?? auth.id;
  const hasTypeColumn = await hasOnDutyColumn();
  if (parsed.data.request_type === 'on_duty' && !hasTypeColumn) {
    return badRequest(
      'On-duty requests need migration: database/migrations/2026-08-07_add_on_duty_requests.sql',
      503,
    );
  }
  const requestType = parsed.data.request_type;

  // --- Who may file for whom -------------------------------------------------
  if (targetEmployeeId !== auth.id) {
    if (auth.role === 'employee') {
      return badRequest('You can only apply for your own permission hours', 403);
    }
    if (!(await canReviewEmployee(auth, targetEmployeeId))) {
      return badRequest('Access denied: not in your team', 403);
    }
  }

  const employee = await queryOne<{ id: number; name: string; emp_id: string; is_active: number }>(
    'SELECT id, name, emp_id, is_active FROM employees WHERE id = ?',
    [targetEmployeeId],
  );
  if (!employee || !Number(employee.is_active)) {
    return badRequest('Employee not found or inactive', 404);
  }

  // --- Times -----------------------------------------------------------------
  const startSql = toSqlTime(parsed.data.start_time);
  const endSql = toSqlTime(parsed.data.end_time);
  if (!startSql || !endSql) {
    return badRequest('start_time and end_time must be HH:MM (24-hour)');
  }

  const minutes = durationMinutes(startSql, endSql);
  if (minutes === null) {
    return badRequest('end_time must be later than start_time on the same day');
  }
  if (minutes < PERMISSION_MIN_MINUTES) {
    return badRequest(`Must be at least ${formatMinutes(PERMISSION_MIN_MINUTES)}`);
  }
  // On duty is a working assignment, not time off: it can last the whole day
  // and is not measured against the monthly time-off entitlement.
  const isOnDuty = requestType === 'on_duty';
  if (!isOnDuty && minutes > PERMISSION_MAX_MINUTES_PER_REQUEST) {
    return badRequest(
      `A single permission cannot exceed ${formatMinutes(PERMISSION_MAX_MINUTES_PER_REQUEST)}`,
    );
  }

  // --- Date window -----------------------------------------------------------
  const today = getWorkDateIST();
  const offsetDays = daysBetween(today, permission_date);
  if (offsetDays < -PERMISSION_MAX_PAST_DAYS) {
    return badRequest(`Permission cannot be dated more than ${PERMISSION_MAX_PAST_DAYS} days in the past`);
  }
  if (offsetDays > PERMISSION_MAX_FUTURE_DAYS) {
    return badRequest(`Permission cannot be dated more than ${PERMISSION_MAX_FUTURE_DAYS} days ahead`);
  }
  // Time off claimed after the fact has to say why. Without a reason a short
  // day can be covered retrospectively with nothing on the record explaining
  // it, which is what makes backdating worth watching in the first place.
  if (offsetDays < 0 && !reason?.trim()) {
    return badRequest('A reason is required when claiming permission for a past date');
  }

  // Admin filing on behalf of someone they may review — record it approved.
  const autoApprove =
    targetEmployeeId !== auth.id && (auth.role === 'manager' || auth.role === 'super_admin');
  const status = autoApprove ? 'approved' : 'pending';

  // --- Overlap + entitlement, checked and written ATOMICALLY -----------------
  // Checking then inserting on separate round-trips lets simultaneous requests
  // each see "there is room" and all commit, blowing past the monthly cap and
  // storing duplicate overlapping windows. Taking a row lock on the employee
  // serialises every permission write for that one person (and nobody else),
  // so the checks below are made against state that cannot change underneath us.
  const { from: monthFrom, to: monthTo } = monthBounds(permission_date);
  const conn = await pool.getConnection();
  let insertId: number;
  try {
    await conn.beginTransaction();
    await conn.query('SELECT id FROM employees WHERE id = ? FOR UPDATE', [targetEmployeeId]);

    // Two windows overlap when each starts before the other ends.
    const [overlapRows] = await conn.query(
      `SELECT id, start_time, end_time
       FROM permission_requests
       WHERE employee_id = ?
         AND permission_date = ?
         AND status IN ('pending', 'approved')
         AND start_time < ?
         AND end_time > ?
       LIMIT 1`,
      [targetEmployeeId, permission_date, endSql, startSql],
    );
    const overlapping = (overlapRows as { start_time: string; end_time: string }[])[0];
    if (overlapping) {
      await conn.rollback();
      return badRequest(
        `This overlaps an existing request on ${permission_date} (${overlapping.start_time.slice(0, 5)}–${overlapping.end_time.slice(0, 5)})`,
        409,
      );
    }

    // Only time off is measured against the monthly entitlement — on-duty is
    // work, and capping it at two hours a month would be nonsense.
    if (!isOnDuty) {
      const [usageRows] = await conn.query(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'approved' THEN minutes ELSE 0 END), 0) AS used,
           COALESCE(SUM(CASE WHEN status = 'pending'  THEN minutes ELSE 0 END), 0) AS pending
         FROM permission_requests
         WHERE employee_id = ?
           AND permission_date BETWEEN ? AND ?
           AND status IN ('approved', 'pending')
           ${timeOffOnly(hasTypeColumn)}`,
        [targetEmployeeId, monthFrom, monthTo],
      );
      const usage = (usageRows as { used: number; pending: number }[])[0];
      const remaining =
        PERMISSION_MAX_MINUTES_PER_MONTH - Number(usage?.used ?? 0) - Number(usage?.pending ?? 0);
      if (minutes > remaining) {
        await conn.rollback();
        return badRequest(
          remaining <= 0
            ? `Monthly permission limit of ${formatMinutes(PERMISSION_MAX_MINUTES_PER_MONTH)} is already used up for ${permission_date.slice(0, 7)}`
            : `Only ${formatMinutes(remaining)} of permission is left for ${permission_date.slice(0, 7)}`,
          409,
        );
      }
    }

    const [result] = await conn.query(
      `INSERT INTO permission_requests
         (employee_id, ${hasTypeColumn ? 'request_type, ' : ''}permission_date,
          start_time, end_time, minutes, reason,
          status, requested_by, reviewed_by, reviewed_at)
       VALUES (?, ${hasTypeColumn ? '?, ' : ''}?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        targetEmployeeId,
        ...(hasTypeColumn ? [requestType] : []),
        permission_date,
        startSql,
        endSql,
        minutes,
        reason ?? null,
        status,
        auth.id,
        autoApprove ? auth.id : null,
        autoApprove ? new Date() : null,
      ],
    );
    insertId = (result as unknown as { insertId: number }).insertId;
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }

  // Tell the admins something is waiting. Non-fatal: a mail failure must never
  // lose the request itself, which is already committed.
  if (!autoApprove) {
    try {
      const admins = await query<{ email: string | null }>(
        `SELECT email FROM employees
         WHERE is_active = TRUE AND email IS NOT NULL
           AND (role = 'super_admin'
                OR id = (SELECT manager_id FROM employees WHERE id = ?))`,
        [targetEmployeeId],
      );
      await Promise.all(
        admins
          .map(a => a.email)
          .filter((e): e is string => !!e)
          .map(email =>
            sendPermissionRequestAlert(email, {
              employeeName: employee.name,
              empId: (employee as unknown as { emp_id?: string }).emp_id ?? '',
              requestType: requestType,
              date: permission_date,
              startTime: startSql,
              endTime: endSql,
              minutes,
              reason: reason ?? null,
            }),
          ),
      );
    } catch {
      // mail is best-effort; the admin queue still shows the request
    }
  }

  await insertAuditLog({
    action: autoApprove ? 'permission_created_approved' : 'permission_requested',
    entity: 'permission_request',
    entity_id: insertId,
    performed_by: auth.id,
    details: {
      employee_id: targetEmployeeId,
      permission_date,
      start_time: startSql,
      end_time: endSql,
      minutes,
      status,
      reason: reason ?? null,
    },
    ip_address: getClientIp(request),
  });

  const created = await queryOne<PermissionRequest>(
    `SELECT pr.*, DATE_FORMAT(pr.permission_date, '%Y-%m-%d') AS permission_date,
            e.name AS employee_name, e.emp_id AS employee_emp_id
     FROM permission_requests pr
     JOIN employees e ON e.id = pr.employee_id
     WHERE pr.id = ?`,
    [insertId],
  );

  return NextResponse.json<ApiResponse<{
    permission: PermissionRequest;
    balance: Awaited<ReturnType<typeof getMonthlyBalance>>;
  }>>(
    {
      success: true,
      message: autoApprove
        ? `Permission of ${formatMinutes(minutes)} recorded and approved`
        : `Permission of ${formatMinutes(minutes)} submitted for approval`,
      data: {
        permission: created!,
        balance: await getMonthlyBalance(targetEmployeeId, permission_date),
      },
    },
    { status: 201 },
  );
}

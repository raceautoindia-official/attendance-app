import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/lib/constants';
import { hasPermissionTable, hasOnDutyColumn } from '@/lib/permissions';
import type { ApiResponse, LeaveRecord } from '@/lib/types';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function normalizeDate(value: string): string | null {
  const ymd = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) return value;
  const dmy = value.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return null;
}

const CreateLeaveSchema = z.object({
  // null / omitted = company-wide holiday (all active employees)
  employee_id: z.number().int().positive().nullable().optional(),
  leave_date: z.string().min(1, 'leave_date is required'),
  leave_type: z.enum(['casual', 'sick', 'earned', 'holiday', 'other']),
  notes: z.string().max(500).nullable().optional(),
});

// ---------------------------------------------------------------------------
// GET /api/leaves — manager | super_admin, paginated
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);

  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
  const limit = Math.min(
    Math.max(1, parseInt(searchParams.get('limit') ?? String(DEFAULT_PAGE_SIZE), 10)),
    MAX_PAGE_SIZE,
  );
  const offset = (page - 1) * limit;

  const fromDate = searchParams.get('from_date');
  const toDate = searchParams.get('to_date');
  const employeeId = searchParams.get('employee_id');

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (auth.role === 'manager') {
    // Can see their team's leaves AND company-wide holidays (employee_id IS NULL)
    conditions.push(
      '(lr.employee_id IN (SELECT id FROM employees WHERE manager_id = ?) OR lr.employee_id IS NULL)',
    );
    params.push(auth.id);
  }

  if (fromDate) {
    conditions.push('lr.leave_date >= ?');
    params.push(fromDate);
  }
  if (toDate) {
    conditions.push('lr.leave_date <= ?');
    params.push(toDate);
  }
  if (employeeId) {
    const eid = parseInt(employeeId, 10);
    if (!isNaN(eid)) {
      conditions.push('lr.employee_id = ?');
      params.push(eid);
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [countRow, rows] = await Promise.all([
    queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM leave_records lr ${where}`,
      [...params],
    ),
    query<LeaveRecord & { employee_name: string | null; employee_emp_id: string | null }>(
      `SELECT lr.*,
              DATE_FORMAT(lr.leave_date, '%Y-%m-%d') AS leave_date,
              e.name   AS employee_name,
              e.emp_id AS employee_emp_id
       FROM leave_records lr
       LEFT JOIN employees e ON lr.employee_id = e.id
       ${where}
       ORDER BY lr.leave_date DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ),
  ]);

  const total = Number(countRow?.total ?? 0);

  // ---------------------------------------------------------------------------
  // WHO ACTUALLY WORKED on these dates, and what they had approved.
  //
  // A leave record says the day was excused; it does not say nobody came in.
  // People do work on holidays, and until now the day simply read "holiday"
  // with the hours buried in an attendance row nobody looked at. For a
  // company-wide holiday (employee_id NULL) this is a LIST — that is the case
  // worth seeing.
  // ---------------------------------------------------------------------------
  const dates = Array.from(new Set(rows.map(r => String(r.leave_date))));
  type WorkedRow = {
    work_date: string; employee_id: number; employee_name: string; emp_id: string;
    clock_in_utc: string | null; clock_out_utc: string | null;
    worked_minutes: number | null;
  };
  type PermRow = {
    permission_date: string; employee_id: number; request_type: string;
    start_time: string; end_time: string; minutes: number;
    status: string; reason: string | null;
  };
  let worked: WorkedRow[] = [];
  let perms: PermRow[] = [];
  if (dates.length) {
    const ph = dates.map(() => '?').join(',');
    const scope = auth.role === 'manager' ? 'AND e.manager_id = ?' : '';
    const scopeParams = auth.role === 'manager' ? [auth.id] : [];
    worked = await query<WorkedRow>(
      `SELECT DATE_FORMAT(a.work_date, '%Y-%m-%d') AS work_date, a.employee_id,
              e.name AS employee_name, e.emp_id,
              a.clock_in_utc, a.clock_out_utc,
              COALESCE(a.total_minutes, a.banked_minutes) AS worked_minutes
         FROM attendance a
         JOIN employees e ON e.id = a.employee_id
        WHERE a.work_date IN (${ph})
          AND a.clock_in_utc IS NOT NULL
          ${scope}
        ORDER BY e.name ASC`,
      [...dates, ...scopeParams],
    );
    if (await hasPermissionTable()) {
      const hasType = await hasOnDutyColumn();
      perms = await query<PermRow>(
        `SELECT DATE_FORMAT(pr.permission_date, '%Y-%m-%d') AS permission_date,
                pr.employee_id,
                ${hasType ? 'pr.request_type' : "'permission' AS request_type"},
                pr.start_time, pr.end_time, pr.minutes, pr.status, pr.reason
           FROM permission_requests pr
           JOIN employees e ON e.id = pr.employee_id
          WHERE pr.permission_date IN (${ph})
            ${scope}
          ORDER BY pr.start_time ASC`,
        [...dates, ...scopeParams],
      );
    }
  }

  const leaves = rows.map(r => {
    const date = String(r.leave_date);
    // A company-wide holiday belongs to everybody, so everyone who worked that
    // date is attached to it. A personal leave only carries that one person's.
    const mine = (id: number) => r.employee_id === null || r.employee_id === id;
    return {
      ...r,
      worked_on_day: worked
        .filter(w => w.work_date === date && mine(w.employee_id))
        .map(w => ({
          employee_id: w.employee_id,
          employee_name: w.employee_name,
          emp_id: w.emp_id,
          clock_in_utc: w.clock_in_utc,
          clock_out_utc: w.clock_out_utc,
          worked_minutes: w.worked_minutes == null ? null : Number(w.worked_minutes),
        })),
      permissions: perms
        .filter(pm => pm.permission_date === date && mine(pm.employee_id))
        .map(pm => ({
          employee_id: pm.employee_id,
          request_type: pm.request_type,
          start_time: pm.start_time,
          end_time: pm.end_time,
          minutes: Number(pm.minutes ?? 0),
          status: pm.status,
          reason: pm.reason,
        })),
    };
  });

  return NextResponse.json<ApiResponse<{
    leaves: typeof leaves;
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }>>({
    success: true,
    data: {
      leaves,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    },
  });
}

// ---------------------------------------------------------------------------
// POST /api/leaves — manager | super_admin
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 }); }

  const parsed = CreateLeaveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Validation error' },
      { status: 400 },
    );
  }

  const { employee_id, leave_date, leave_type, notes } = parsed.data;
  const normalizedLeaveDate = normalizeDate(leave_date);
  if (!normalizedLeaveDate) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'leave_date must be YYYY-MM-DD' },
      { status: 400 },
    );
  }

  const leaveRecordsMeta = await query<{
    column_name: string;
    is_nullable: 'YES' | 'NO';
  }>(
    `SELECT COLUMN_NAME AS column_name, IS_NULLABLE AS is_nullable
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'leave_records'`,
  );
  const metaByColumn = new Map(
    leaveRecordsMeta.map(m => [m.column_name, m.is_nullable] as const),
  );
  const hasCreatedBy = metaByColumn.has('created_by');
  const employeeIdAllowsNull = metaByColumn.get('employee_id') === 'YES';
  const leaveTypeMeta = await queryOne<{ column_type: string }>(
    `SELECT COLUMN_TYPE AS column_type
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'leave_records'
       AND COLUMN_NAME = 'leave_type'`,
  );
  const leaveTypeSupportsHoliday = (leaveTypeMeta?.column_type ?? '').includes("'holiday'");
  const holidayLeaveType = leaveTypeSupportsHoliday ? 'holiday' : 'other';

  const attendanceStatusMeta = await queryOne<{ column_type: string }>(
    `SELECT COLUMN_TYPE AS column_type
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'attendance'
       AND COLUMN_NAME = 'status'`,
  );
  const attendanceStatusSupportsHoliday = (attendanceStatusMeta?.column_type ?? '').includes("'holiday'");
  const holidayAttendanceStatus = attendanceStatusSupportsHoliday ? 'holiday' : 'leave';

  // ---- Company-wide holiday (employee_id omitted / null) ----
  if (employee_id === null || employee_id === undefined) {
    if (leave_type !== 'holiday') {
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'employee_id is required for non-holiday leave types' },
        { status: 400 },
      );
    }
    if (employeeIdAllowsNull) {
      const existingHoliday = await queryOne<{ id: number }>(
        'SELECT id FROM leave_records WHERE employee_id IS NULL AND leave_date = ? LIMIT 1',
        [normalizedLeaveDate],
      );
      if (existingHoliday) {
        if (hasCreatedBy) {
          await query(
            `UPDATE leave_records
             SET leave_type = ?, notes = ?, created_by = ?
             WHERE id = ?`,
            [holidayLeaveType, notes ?? null, auth.id, existingHoliday.id],
          );
        } else {
          await query(
            `UPDATE leave_records
             SET leave_type = ?, notes = ?
             WHERE id = ?`,
            [holidayLeaveType, notes ?? null, existingHoliday.id],
          );
        }
      } else {
        if (hasCreatedBy) {
          await query(
            `INSERT INTO leave_records (employee_id, leave_date, leave_type, notes, created_by)
             VALUES (NULL, ?, ?, ?, ?)`,
            [normalizedLeaveDate, holidayLeaveType, notes ?? null, auth.id],
          );
        } else {
          await query(
            `INSERT INTO leave_records (employee_id, leave_date, leave_type, notes)
             VALUES (NULL, ?, ?, ?)`,
            [normalizedLeaveDate, holidayLeaveType, notes ?? null],
          );
        }
      }
    } else {
      // Fallback for legacy schemas where employee_id is NOT NULL.
      if (hasCreatedBy) {
        await query(
          `INSERT INTO leave_records (employee_id, leave_date, leave_type, notes, created_by)
           SELECT e.id, ?, ?, ?, ?
           FROM employees e
           WHERE e.is_active = TRUE
             AND NOT EXISTS (
               SELECT 1
               FROM leave_records lr
               WHERE lr.employee_id = e.id
                 AND lr.leave_date = ?
             )`,
          [normalizedLeaveDate, holidayLeaveType, notes ?? null, auth.id, normalizedLeaveDate],
        );
      } else {
        await query(
          `INSERT INTO leave_records (employee_id, leave_date, leave_type, notes)
           SELECT e.id, ?, ?, ?
           FROM employees e
           WHERE e.is_active = TRUE
             AND NOT EXISTS (
               SELECT 1
               FROM leave_records lr
               WHERE lr.employee_id = e.id
                 AND lr.leave_date = ?
             )`,
          [normalizedLeaveDate, holidayLeaveType, notes ?? null, normalizedLeaveDate],
        );
      }

      // If a row already existed for this date in legacy mode, normalize it to holiday.
      if (hasCreatedBy) {
        await query(
          `UPDATE leave_records
           SET leave_type = ?,
               notes = ?,
               created_by = ?
           WHERE leave_date = ?
             AND employee_id IN (SELECT id FROM employees WHERE is_active = TRUE)`,
          [holidayLeaveType, notes ?? null, auth.id, normalizedLeaveDate],
        );
      } else {
        await query(
          `UPDATE leave_records
           SET leave_type = ?,
               notes = ?
           WHERE leave_date = ?
             AND employee_id IN (SELECT id FROM employees WHERE is_active = TRUE)`,
          [holidayLeaveType, notes ?? null, normalizedLeaveDate],
        );
      }
    }

    // Flip attendance to 'holiday' — but ONLY for people who did not work.
    //
    // This used to flip every row for the date. Somebody who came in on the
    // holiday had their day relabelled 'holiday' on top of a real clock-in:
    // the hours stayed in the row, but the day stopped counting as present and
    // there was nothing left to say they had worked at all. Declaring a
    // holiday must not erase the people who turned up for it.
    await query(
      `UPDATE attendance
       SET status = ?
       WHERE work_date = ?
         AND clock_in_utc IS NULL
         AND employee_id IN (SELECT id FROM employees WHERE is_active = TRUE)`,
      [holidayAttendanceStatus, normalizedLeaveDate],
    );

    await insertAuditLog({
      action: 'holiday_created',
      entity: 'attendance',
      performed_by: auth.id,
      details: {
        leave_date: normalizedLeaveDate,
        leave_type: holidayLeaveType,
        attendance_status: holidayAttendanceStatus,
        notes: notes ?? null,
        scope: 'all_employees',
      },
      ip_address: request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
    });

    return NextResponse.json<ApiResponse>(
      { success: true, message: `Holiday created for all active employees on ${normalizedLeaveDate}` },
      { status: 201 },
    );
  }

  // ---- Single-employee leave ----

  // Manager scope check
  if (auth.role === 'manager') {
    const emp = await queryOne<{ manager_id: number | null }>(
      'SELECT manager_id FROM employees WHERE id = ? AND is_active = TRUE',
      [employee_id],
    );
    if (!emp || emp.manager_id !== auth.id) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'Access denied: not in your team' },
        { status: 403 },
      );
    }
  }

  const result = hasCreatedBy
    ? await query(
      `INSERT INTO leave_records (employee_id, leave_date, leave_type, notes, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [employee_id, normalizedLeaveDate, leave_type, notes ?? null, auth.id],
    )
    : await query(
      `INSERT INTO leave_records (employee_id, leave_date, leave_type, notes)
       VALUES (?, ?, ?, ?)`,
      [employee_id, normalizedLeaveDate, leave_type, notes ?? null],
    );
  const insertId = (result as unknown as { insertId: number }).insertId;

  // Flip an existing attendance row to leave/holiday — but ONLY if they did
  // not work that day.
  //
  // This is what makes an approved casual or sick leave stop reading as
  // ABSENT: the end-of-day job may already have written an 'absent' row before
  // anyone recorded the leave, and this converts it.
  //
  // The clock_in_utc guard is the other half. Without it, recording leave for
  // somebody who had actually worked overwrote their day: hours in the row,
  // status saying they were on leave, and no way to tell they had been in.
  const newAttendanceStatus = leave_type === 'holiday' ? 'holiday' : 'leave';
  await query(
    `UPDATE attendance SET status = ?
      WHERE employee_id = ? AND work_date = ? AND clock_in_utc IS NULL`,
    [newAttendanceStatus, employee_id, normalizedLeaveDate],
  );

  await insertAuditLog({
    action: 'leave_created',
    entity: 'attendance',
    entity_id: insertId,
    performed_by: auth.id,
    details: { employee_id, leave_date: normalizedLeaveDate, leave_type, notes: notes ?? null },
    ip_address: request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
  });

  const leaveRecord = await queryOne<LeaveRecord>(
    'SELECT * FROM leave_records WHERE id = ?',
    [insertId],
  );

  return NextResponse.json<ApiResponse<LeaveRecord>>(
    { success: true, data: leaveRecord! },
    { status: 201 },
  );
}

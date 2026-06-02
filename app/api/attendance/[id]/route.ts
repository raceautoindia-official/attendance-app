import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { toMySQLDatetime } from '@/lib/attendance';
import type { ApiResponse, AttendanceRecord, AttendanceStatus } from '@/lib/types';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const EditSchema = z.object({
  clock_in_utc: z.string().nullable().optional(),
  clock_out_utc: z.string().nullable().optional(),
  status: z
    .enum(['present', 'late', 'early_departure', 'absent', 'leave', 'holiday'])
    .optional(),
  notes: z.string().max(2000).nullable().optional(),
});

// ---------------------------------------------------------------------------
// PUT /api/attendance/[id]
// ---------------------------------------------------------------------------

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const { id: idStr } = await context.params;
  const recordId = parseInt(idStr, 10);
  if (isNaN(recordId)) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Invalid record ID' },
      { status: 400 },
    );
  }

  // 1. Parse + validate body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const parsed = EditSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Validation error' },
      { status: 400 },
    );
  }

  // 2. Load the existing record
  const existing = await queryOne<AttendanceRecord>(
    `SELECT a.*, e.name AS employee_name, e.emp_id
     FROM attendance a
     JOIN employees e ON a.employee_id = e.id
     WHERE a.id = ?`,
    [recordId],
  );

  if (!existing) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Attendance record not found' },
      { status: 404 },
    );
  }

  // 3. Scope check — managers can only edit their own team's records
  if (auth.role === 'manager') {
    const empRow = await queryOne<{ manager_id: number | null }>(
      'SELECT manager_id FROM employees WHERE id = ?',
      [existing.employee_id],
    );
    if (!empRow || empRow.manager_id !== auth.id) {
      return NextResponse.json<ApiResponse>(
        {
          success: false,
          error: 'You can only edit attendance records for your team members',
        },
        { status: 403 },
      );
    }
  }

  // 4. Resolve updated values (fall back to existing when not provided)
  const { clock_in_utc, clock_out_utc, status, notes } = parsed.data;

  const newClockIn = clock_in_utc !== undefined
    ? (clock_in_utc ? new Date(clock_in_utc) : null)
    : existing.clock_in_utc;

  const newClockOut = clock_out_utc !== undefined
    ? (clock_out_utc ? new Date(clock_out_utc) : null)
    : existing.clock_out_utc;

  // Validate parsed dates
  if (newClockIn && isNaN(newClockIn.getTime())) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Invalid clock_in_utc datetime string' },
      { status: 400 },
    );
  }
  if (newClockOut && isNaN(newClockOut.getTime())) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Invalid clock_out_utc datetime string' },
      { status: 400 },
    );
  }

  // 5. Validate clock ordering then recalculate total_minutes
  if (newClockIn && newClockOut && newClockOut <= newClockIn) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'clock_out_utc must be after clock_in_utc' },
      { status: 400 },
    );
  }

  let totalMinutes: number | null = existing.total_minutes;
  if (newClockIn && newClockOut) {
    totalMinutes = Math.round((newClockOut.getTime() - newClockIn.getTime()) / 60_000);
  } else if (!newClockOut) {
    totalMinutes = null;
  }

  const newStatus: AttendanceStatus = status ?? existing.status;
  const newNotes = notes !== undefined ? notes : existing.notes;
  const nowUtc = new Date();

  // 6. Persist
  await query(
    `UPDATE attendance
     SET clock_in_utc  = ?,
         clock_out_utc = ?,
         total_minutes = ?,
         status        = ?,
         notes         = ?,
         edited_by     = ?,
         edited_at     = ?
     WHERE id = ?`,
    [
      newClockIn ? toMySQLDatetime(newClockIn) : null,
      newClockOut ? toMySQLDatetime(newClockOut) : null,
      totalMinutes,
      newStatus,
      newNotes ?? null,
      auth.id,
      toMySQLDatetime(nowUtc),
      recordId,
    ],
  );

  // 7. Audit log — capture before/after values
  await insertAuditLog({
    action: 'attendance_edited',
    entity: 'attendance',
    entity_id: recordId,
    performed_by: auth.id,
    details: {
      before: {
        clock_in_utc: existing.clock_in_utc,
        clock_out_utc: existing.clock_out_utc,
        status: existing.status,
        notes: existing.notes,
        total_minutes: existing.total_minutes,
      },
      after: {
        clock_in_utc: newClockIn,
        clock_out_utc: newClockOut,
        status: newStatus,
        notes: newNotes,
        total_minutes: totalMinutes,
      },
    },
    ip_address:
      request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
  });

  // 8. Return the updated record
  const updated = await queryOne<AttendanceRecord>(
    `SELECT a.*, e.name AS employee_name, e.emp_id
     FROM attendance a
     JOIN employees e ON a.employee_id = e.id
     WHERE a.id = ?`,
    [recordId],
  );

  return NextResponse.json<ApiResponse<AttendanceRecord>>(
    { success: true, data: updated! },
  );
}

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { queryOne, insertAuditLog, pool } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { overlappingShiftNames, type DayShift } from '@/lib/shifts';
import { parseWorkingDays } from '@/lib/workingDays';
import type { ApiResponse, EmployeeSchedule } from '@/lib/types';

/** Two shifts a day — a morning and an evening. More is not a shift pattern. */
const MAX_SHIFTS_PER_DAY = 2;

interface ExistingShift {
  id: number;
  name: string;
  start_time: string | null;
  end_time: string | null;
  required_hours: number | string | null;
  working_days: unknown;
}

/** Enough of a DayShift for the overlap check. */
const toDayShift = (s: ExistingShift): DayShift => ({
  shift_id: s.id,
  name: s.name,
  start_time: s.start_time,
  end_time: s.end_time,
  required_hours: s.required_hours,
  working_days: parseWorkingDays(s.working_days),
} as DayShift);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const AssignSchema = z.object({
  employee_id: z.number().int().positive(),
  shift_id: z.number().int().positive(),
  location_id: z.number().int().positive().nullable().optional(),
  geofencing_enabled: z.boolean().default(false),
  effective_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'effective_from must be YYYY-MM-DD'),
  /**
   * Add this shift ALONGSIDE the employee's current one (a double shift)
   * instead of replacing it. Off by default, so an ordinary reassignment keeps
   * behaving exactly as before — only the employees the admin opts in get two.
   */
  additional: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// PUT /api/schedules/assign
// Closes the current active schedule and opens a new one.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 }); }

  const parsed = AssignSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Validation error' },
      { status: 400 },
    );
  }

  const { employee_id, shift_id, location_id, geofencing_enabled, effective_from, additional } = parsed.data;

  // Geofencing without a location fences nothing — the clock-in check needs
  // coordinates to compare against. Rather than silently storing a flag that
  // does nothing (which is how schedules ended up claiming a fence they did not
  // enforce), say so.
  if (geofencing_enabled && !location_id) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Select a location to enable geofencing — a fence needs coordinates to check against' },
      { status: 400 },
    );
  }
  const normalizedGeofencing = location_id ? geofencing_enabled : false;

  // Managers can only assign schedules to their own team
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

  // Verify the shift and location exist
  const shiftExists = await queryOne<{ id: number }>(
    'SELECT id FROM shifts WHERE id = ?',
    [shift_id],
  );
  if (!shiftExists) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Shift not found' }, { status: 404 });
  }

  if (location_id) {
    const locExists = await queryOne<{ id: number }>(
      'SELECT id FROM locations WHERE id = ? AND is_active = TRUE',
      [location_id],
    );
    if (!locExists) {
      return NextResponse.json<ApiResponse>({ success: false, error: 'Location not found' }, { status: 404 });
    }
  }

  const conn = await pool.getConnection();
  let insertId = 0;
  try {
    await conn.beginTransaction();

    const [dupRows] = await conn.query(
      `SELECT id FROM employee_schedules
       WHERE employee_id = ?
         AND shift_id = ?
         AND ((location_id IS NULL AND ? IS NULL) OR location_id = ?)
         AND geofencing_enabled = ?
         AND effective_from = ?
         AND effective_to IS NULL
       LIMIT 1`,
      [employee_id, shift_id, location_id ?? null, location_id ?? null, normalizedGeofencing ? 1 : 0, effective_from],
    );
    const dup = (dupRows as Array<{ id: number }>)[0];
    if (dup) {
      await conn.rollback();
      return NextResponse.json<ApiResponse>(
        { success: true, message: 'Schedule already assigned for this date. No changes made.' },
      );
    }

    if (additional) {
      // Double shift: keep what the employee already has and add to it. The new
      // shift has to be a genuinely different one that does not clash, or the
      // day's hours would be nonsense — two rows for the same shift would read
      // as double the hours, and overlapping windows cannot both be worked.
      const [currentRows] = await conn.query(
        `SELECT s.id, s.name, s.start_time, s.end_time, s.required_hours, s.working_days
         FROM employee_schedules es
         JOIN shifts s ON s.id = es.shift_id
         WHERE es.employee_id = ?
           AND (es.effective_to IS NULL OR es.effective_to >= ?)`,
        [employee_id, effective_from],
      );
      const current = currentRows as ExistingShift[];

      if (current.some(c => c.id === shift_id)) {
        await conn.rollback();
        return NextResponse.json<ApiResponse>(
          { success: false, error: 'That shift is already assigned to this employee' },
          { status: 409 },
        );
      }
      if (current.length + 1 > MAX_SHIFTS_PER_DAY) {
        await conn.rollback();
        return NextResponse.json<ApiResponse>(
          { success: false, error: `An employee can hold at most ${MAX_SHIFTS_PER_DAY} shifts a day` },
          { status: 409 },
        );
      }

      const [newRows] = await conn.query(
        'SELECT id, name, start_time, end_time, required_hours, working_days FROM shifts WHERE id = ?',
        [shift_id],
      );
      const clash = overlappingShiftNames(
        [...current, ...(newRows as ExistingShift[])].map(toDayShift),
      );
      if (clash.length) {
        await conn.rollback();
        return NextResponse.json<ApiResponse>(
          {
            success: false,
            error: `These shifts overlap and cannot both be worked: ${clash.join(' and ')}`,
          },
          { status: 409 },
        );
      }
    } else {
      await conn.query(
        `UPDATE employee_schedules
         SET effective_to = DATE_SUB(?, INTERVAL 1 DAY)
         WHERE employee_id = ?
           AND effective_from < ?
           AND (effective_to IS NULL OR effective_to >= ?)`,
        [effective_from, employee_id, effective_from, effective_from],
      );
      // A row starting on the SAME date is what this one replaces.
      await conn.query(
        'DELETE FROM employee_schedules WHERE employee_id = ? AND effective_from = ?',
        [employee_id, effective_from],
      );
    }

    // A schedule backdated ahead of one that already starts later must stop
    // where that one begins. Without this the older UPDATE (which only closes
    // rows starting strictly earlier) left BOTH in force from the later date,
    // which now reads as a double shift nobody asked for.
    const [nextRows] = await conn.query(
      `SELECT MIN(effective_from) AS next_from
       FROM employee_schedules
       WHERE employee_id = ? AND effective_from > ?`,
      [employee_id, effective_from],
    );
    const nextFrom = (nextRows as Array<{ next_from: Date | string | null }>)[0]?.next_from ?? null;

    const [result] = await conn.query(
      `INSERT INTO employee_schedules
        (employee_id, shift_id, location_id, geofencing_enabled, effective_from, effective_to, assigned_by)
       VALUES (?, ?, ?, ?, ?, ${additional || !nextFrom ? 'NULL' : 'DATE_SUB(?, INTERVAL 1 DAY)'}, ?)`,
      additional || !nextFrom
        ? [employee_id, shift_id, location_id ?? null, normalizedGeofencing ? 1 : 0, effective_from, auth.id]
        : [employee_id, shift_id, location_id ?? null, normalizedGeofencing ? 1 : 0, effective_from, nextFrom, auth.id],
    );
    insertId = (result as { insertId: number }).insertId;
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }

  await insertAuditLog({
    action: 'schedule_assigned',
    entity: 'employee_schedule',
    entity_id: insertId,
    performed_by: auth.id,
    details: { employee_id, shift_id, location_id, geofencing_enabled: normalizedGeofencing, effective_from },
    ip_address: request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
  });

  const schedule = await queryOne<EmployeeSchedule>(
    'SELECT * FROM employee_schedules WHERE id = ?',
    [insertId],
  );

  return NextResponse.json<ApiResponse<EmployeeSchedule>>(
    { success: true, data: schedule! },
    { status: 201 },
  );
}

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { getWorkDateIST } from '@/lib/attendance';
import type { ApiResponse, EmployeeSchedule } from '@/lib/types';

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

  const { employee_id, shift_id, location_id, geofencing_enabled, effective_from } = parsed.data;

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

  const today = getWorkDateIST();

  // Close any currently active schedule (set effective_to = today)
  await query(
    `UPDATE employee_schedules
     SET effective_to = ?
     WHERE employee_id = ?
       AND effective_from <= CURDATE()
       AND (effective_to IS NULL OR effective_to >= CURDATE())`,
    [today, employee_id],
  );

  // Insert new schedule
  const result = await query(
    `INSERT INTO employee_schedules
       (employee_id, shift_id, location_id, geofencing_enabled, effective_from, assigned_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [employee_id, shift_id, location_id ?? null, geofencing_enabled ? 1 : 0, effective_from, auth.id],
  );
  const insertId = (result as unknown as { insertId: number }).insertId;

  await insertAuditLog({
    action: 'schedule_assigned',
    entity: 'employee_schedule',
    entity_id: insertId,
    performed_by: auth.id,
    details: { employee_id, shift_id, location_id, geofencing_enabled, effective_from },
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

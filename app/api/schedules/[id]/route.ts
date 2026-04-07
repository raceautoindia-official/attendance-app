import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import type { ApiResponse, Shift } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

const UpdateShiftSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional(),
  end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional(),
  required_hours: z.number().min(0.5).max(24).nullable().optional(),
  grace_minutes: z.number().int().min(0).max(60).optional(),
  working_days: z.array(z.string()).min(1).optional(),
  rotation_config: z.array(z.object({
    name: z.string(), start_time: z.string(),
    end_time: z.string(), days: z.array(z.string()),
  })).nullable().optional(),
});

// GET /api/schedules/[id]
export async function GET(request: NextRequest, context: Params) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const { id } = await context.params;
  const shiftId = parseInt(id, 10);
  if (isNaN(shiftId)) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid ID' }, { status: 400 });
  }

  const shift = await queryOne<Shift>('SELECT * FROM shifts WHERE id = ?', [shiftId]);
  if (!shift) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Shift not found' }, { status: 404 });
  }

  if (typeof shift.working_days === 'string') shift.working_days = JSON.parse(shift.working_days as unknown as string);
  if (shift.rotation_config && typeof shift.rotation_config === 'string') shift.rotation_config = JSON.parse(shift.rotation_config as unknown as string);

  return NextResponse.json<ApiResponse<Shift>>({ success: true, data: shift });
}

// PUT /api/schedules/[id]
export async function PUT(request: NextRequest, context: Params) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  const { id } = await context.params;
  const shiftId = parseInt(id, 10);
  if (isNaN(shiftId)) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid ID' }, { status: 400 });
  }

  const existing = await queryOne<Shift>('SELECT * FROM shifts WHERE id = ?', [shiftId]);
  if (!existing) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Shift not found' }, { status: 404 });
  }

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 }); }

  const parsed = UpdateShiftSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Validation error' },
      { status: 400 },
    );
  }

  const setClauses: string[] = [];
  const params: unknown[] = [];

  const apply = (col: string, val: unknown) => { setClauses.push(`${col} = ?`); params.push(val); };

  if (parsed.data.name !== undefined) apply('name', parsed.data.name);
  if (parsed.data.start_time !== undefined) apply('start_time', parsed.data.start_time);
  if (parsed.data.end_time !== undefined) apply('end_time', parsed.data.end_time);
  if (parsed.data.required_hours !== undefined) apply('required_hours', parsed.data.required_hours);
  if (parsed.data.grace_minutes !== undefined) apply('grace_minutes', parsed.data.grace_minutes);
  if (parsed.data.working_days !== undefined) apply('working_days', JSON.stringify(parsed.data.working_days));
  if (parsed.data.rotation_config !== undefined) apply('rotation_config', parsed.data.rotation_config ? JSON.stringify(parsed.data.rotation_config) : null);

  if (setClauses.length === 0) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'No fields to update' }, { status: 400 });
  }

  params.push(shiftId);
  await query(`UPDATE shifts SET ${setClauses.join(', ')} WHERE id = ?`, params);

  const updated = await queryOne<Shift>('SELECT * FROM shifts WHERE id = ?', [shiftId]);
  if (updated) {
    if (typeof updated.working_days === 'string') updated.working_days = JSON.parse(updated.working_days as unknown as string);
    if (updated.rotation_config && typeof updated.rotation_config === 'string') updated.rotation_config = JSON.parse(updated.rotation_config as unknown as string);
  }

  return NextResponse.json<ApiResponse<Shift>>({ success: true, data: updated! });
}

// DELETE /api/schedules/[id]
export async function DELETE(request: NextRequest, context: Params) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  const { id } = await context.params;
  const shiftId = parseInt(id, 10);
  if (isNaN(shiftId)) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid ID' }, { status: 400 });
  }

  // Block deletion if the shift is referenced by any active schedule
  const inUse = await queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM employee_schedules
     WHERE shift_id = ? AND (effective_to IS NULL OR effective_to >= CURDATE())`,
    [shiftId],
  );
  if (Number(inUse?.count ?? 0) > 0) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Shift is currently assigned to active schedules and cannot be deleted' },
      { status: 409 },
    );
  }

  const rows = await query('DELETE FROM shifts WHERE id = ?', [shiftId]);
  if ((rows as unknown as { affectedRows: number }).affectedRows === 0) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Shift not found' }, { status: 404 });
  }

  return NextResponse.json<ApiResponse>({ success: true, message: 'Shift deleted' });
}

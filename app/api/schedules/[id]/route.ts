import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { getWorkDateIST } from '@/lib/attendance';
import type { ApiResponse, Shift } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

// A cleared time box arrives as "", which is "no start time" — not a badly
// formatted one. Without this, clearing a shift's start time answered
// "start_time must be HH:MM", which describes the wrong problem.
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

const UpdateShiftSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  // type was NOT here, so the Type dropdown in the edit form was silently
  // discarded: a shift could not be changed from fixed to flexible, and the
  // control looked like it had worked. It decides whether lateness is measured
  // at all, so it is exactly the field an edit needs to reach.
  type: z.enum(['fixed', 'flexible', 'rotating', 'custom']).optional(),
  start_time: z.preprocess(
    blankToNull,
    z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/, 'start_time must be HH:MM or HH:MM:SS').nullable().optional(),
  ),
  end_time: z.preprocess(
    blankToNull,
    z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/, 'end_time must be HH:MM or HH:MM:SS').nullable().optional(),
  ),
  required_hours: z.preprocess(blankToNull, z.number().min(0.5).max(24).nullable().optional()),
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

  // Validate the shift the edit would LEAVE BEHIND, not just the fields sent.
  //
  // A PUT here is a partial update, so "is this shift coherent?" cannot be
  // answered from the patch alone: switching a flexible shift to fixed without
  // sending times would have stored a fixed shift with no start time, and
  // everything that measures lateness would then have nothing to measure
  // against. Merging first also produces the useful message ("start_time is
  // required for fixed shifts") instead of a format complaint about "".
  const existingDays = typeof existing.working_days === 'string'
    ? (() => { try { return JSON.parse(existing.working_days as unknown as string); } catch { return []; } })()
    : existing.working_days;
  const merged = {
    type: parsed.data.type ?? existing.type,
    start_time: parsed.data.start_time !== undefined ? parsed.data.start_time : existing.start_time,
    end_time: parsed.data.end_time !== undefined ? parsed.data.end_time : existing.end_time,
    required_hours: parsed.data.required_hours !== undefined
      ? parsed.data.required_hours
      : existing.required_hours,
    rotation_config: parsed.data.rotation_config !== undefined
      ? parsed.data.rotation_config
      : existing.rotation_config,
    working_days: parsed.data.working_days ?? existingDays,
  };

  const complaint =
    merged.type === 'fixed' && !merged.start_time
      ? 'start_time is required for fixed shifts'
      : merged.type === 'fixed' && !merged.end_time
        ? 'end_time is required for fixed shifts'
        : merged.type === 'flexible' && !merged.required_hours
          ? 'required_hours is required for flexible shifts'
          : merged.type === 'rotating'
            && (!merged.rotation_config || (merged.rotation_config as unknown[]).length === 0)
            ? 'rotation_config is required for rotating shifts'
            : !merged.working_days || (merged.working_days as unknown[]).length === 0
              ? 'At least one working day required'
              : null;
  if (complaint) {
    return NextResponse.json<ApiResponse>({ success: false, error: complaint }, { status: 400 });
  }

  const setClauses: string[] = [];
  const params: unknown[] = [];

  const apply = (col: string, val: unknown) => { setClauses.push(`${col} = ?`); params.push(val); };

  if (parsed.data.name !== undefined) apply('name', parsed.data.name);
  if (parsed.data.type !== undefined) apply('type', parsed.data.type);
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
     WHERE shift_id = ? AND (effective_to IS NULL OR effective_to >= ?)`,
    [shiftId, getWorkDateIST()],
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

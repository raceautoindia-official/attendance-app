import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import type { ApiResponse, Shift } from '@/lib/types';

// ---------------------------------------------------------------------------
// Validation — POST
// ---------------------------------------------------------------------------

const ShiftSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['fixed', 'flexible', 'rotating', 'custom']),
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'start_time must be HH:MM or HH:MM:SS').nullable().optional(),
  end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'end_time must be HH:MM or HH:MM:SS').nullable().optional(),
  required_hours: z.number().min(0.5).max(24).nullable().optional(),
  grace_minutes: z.number().int().min(0).max(60).default(10),
  working_days: z.array(z.string()).min(1, 'At least one working day required'),
  rotation_config: z.array(z.object({
    name: z.string(),
    start_time: z.string(),
    end_time: z.string(),
    days: z.array(z.string()),
  })).nullable().optional(),
}).superRefine((data, ctx) => {
  if (data.type === 'fixed') {
    if (!data.start_time) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'start_time is required for fixed shifts', path: ['start_time'] });
    if (!data.end_time) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'end_time is required for fixed shifts', path: ['end_time'] });
  }
  if (data.type === 'flexible' && !data.required_hours) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'required_hours is required for flexible shifts', path: ['required_hours'] });
  }
  if (data.type === 'rotating' && (!data.rotation_config || data.rotation_config.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'rotation_config is required for rotating shifts', path: ['rotation_config'] });
  }
});

// ---------------------------------------------------------------------------
// GET /api/schedules
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const shifts = await query<Shift>(
    `SELECT id, name, type, start_time, end_time, required_hours,
            grace_minutes, working_days, rotation_config, created_by, created_at
     FROM shifts
     ORDER BY name ASC`,
  );

  // Parse JSON columns returned as strings by mysql2
  const parsed = shifts.map(s => ({
    ...s,
    working_days:
      typeof s.working_days === 'string'
        ? JSON.parse(s.working_days as unknown as string)
        : s.working_days,
    rotation_config:
      s.rotation_config && typeof s.rotation_config === 'string'
        ? JSON.parse(s.rotation_config as unknown as string)
        : s.rotation_config,
  }));

  return NextResponse.json<ApiResponse<{ shifts: Shift[] }>>({ success: true, data: { shifts: parsed } });
}

// ---------------------------------------------------------------------------
// POST /api/schedules
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 }); }

  const validated = ShiftSchema.safeParse(body);
  if (!validated.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: validated.error.issues[0]?.message ?? 'Validation error' },
      { status: 400 },
    );
  }

  const {
    name, type, start_time, end_time, required_hours,
    grace_minutes, working_days, rotation_config,
  } = validated.data;

  const result = await query(
    `INSERT INTO shifts
       (name, type, start_time, end_time, required_hours, grace_minutes,
        working_days, rotation_config, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name, type,
      start_time ?? null,
      end_time ?? null,
      required_hours ?? null,
      grace_minutes,
      JSON.stringify(working_days),
      rotation_config ? JSON.stringify(rotation_config) : null,
      auth.id,
    ],
  );
  const insertId = (result as unknown as { insertId: number }).insertId;

  const shift = await queryOne<Shift>('SELECT * FROM shifts WHERE id = ?', [insertId]);
  if (shift) {
    if (typeof shift.working_days === 'string') shift.working_days = JSON.parse(shift.working_days as unknown as string);
    if (shift.rotation_config && typeof shift.rotation_config === 'string') shift.rotation_config = JSON.parse(shift.rotation_config as unknown as string);
  }

  return NextResponse.json<ApiResponse<Shift>>(
    { success: true, data: shift! },
    { status: 201 },
  );
}

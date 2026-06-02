import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { toMySQLDatetime } from '@/lib/attendance';
import type { ApiResponse, LiveTrackingSession } from '@/lib/types';

const StartSchema = z.object({
  latitude: z.number({ error: 'latitude must be a number' }),
  longitude: z.number({ error: 'longitude must be a number' }),
  accuracy_meters: z.number().min(0).max(10000).nullable().optional(),
});

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['employee', 'manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;
  try {
    const employee = await queryOne<{ live_tracking_enabled: number | boolean }>(
      'SELECT live_tracking_enabled FROM employees WHERE id = ?',
      [auth.id],
    );
    if (!employee?.live_tracking_enabled) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'Live tracking is disabled for this employee' },
        { status: 403 },
      );
    }
  } catch (error) {
    const err = error as { code?: string };
    if (err?.code !== 'ER_BAD_FIELD_ERROR') throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = StartSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Validation error' },
      { status: 400 },
    );
  }

  const { latitude, longitude, accuracy_meters } = parsed.data;
  const now = toMySQLDatetime(new Date());

  let session: LiveTrackingSession | null = null;
  try {
    session = await queryOne<LiveTrackingSession>(
      `SELECT id, employee_id, started_at_utc, ended_at_utc, is_active, last_ping_utc, created_at
       FROM live_tracking_sessions
       WHERE employee_id = ? AND is_active = TRUE
       ORDER BY started_at_utc DESC
       LIMIT 1`,
      [auth.id],
    );
  } catch (error) {
    const err = error as { code?: string };
    if (err?.code === 'ER_NO_SUCH_TABLE') {
      return NextResponse.json<ApiResponse>(
        {
          success: false,
          error: 'Live-tracking tables are missing. Run migration: database/migrations/2026-05-27_add_live_tracking_tables.sql',
        },
        { status: 503 },
      );
    }
    throw error;
  }

  if (!session) {
    const result = await query<{ insertId: number }>(
      `INSERT INTO live_tracking_sessions (employee_id, started_at_utc, is_active, last_ping_utc)
       VALUES (?, ?, TRUE, ?)`,
      [auth.id, now, now],
    );
    const insertId = (result as unknown as { insertId: number }).insertId;
    session = await queryOne<LiveTrackingSession>(
      `SELECT id, employee_id, started_at_utc, ended_at_utc, is_active, last_ping_utc, created_at
       FROM live_tracking_sessions
       WHERE id = ?`,
      [insertId],
    );
  } else {
    await query(
      `UPDATE live_tracking_sessions SET last_ping_utc = ? WHERE id = ?`,
      [now, session.id],
    );
  }

  await query(
    `INSERT INTO live_tracking_points (session_id, employee_id, tracked_at_utc, latitude, longitude, accuracy_meters)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [session!.id, auth.id, now, latitude, longitude, accuracy_meters ?? null],
  );

  await insertAuditLog({
    action: 'live_tracking_started',
    entity: 'attendance',
    entity_id: session!.id,
    performed_by: auth.id,
    details: { latitude, longitude, accuracy_meters: accuracy_meters ?? null },
    ip_address: request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
  });

  return NextResponse.json<ApiResponse<{ session: LiveTrackingSession }>>({
    success: true,
    data: { session: session! },
  });
}

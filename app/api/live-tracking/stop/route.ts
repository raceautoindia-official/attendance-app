import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { toMySQLDatetime } from '@/lib/attendance';
import { sendLiveTrackingAlert } from '@/lib/mailer';
import type { ApiResponse, LiveTrackingSession } from '@/lib/types';

const StopSchema = z.object({
  latitude: z.number({ error: 'latitude must be a number' }).nullable().optional(),
  longitude: z.number({ error: 'longitude must be a number' }).nullable().optional(),
  accuracy_meters: z.number().min(0).max(10000).nullable().optional(),
});

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['employee', 'manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const parsed = StopSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Validation error' },
      { status: 400 },
    );
  }

  const activeSession = await queryOne<LiveTrackingSession>(
    `SELECT id, employee_id, started_at_utc, ended_at_utc, is_active, last_ping_utc, created_at
     FROM live_tracking_sessions
     WHERE employee_id = ? AND is_active = TRUE
     ORDER BY started_at_utc DESC
     LIMIT 1`,
    [auth.id],
  );

  if (!activeSession) {
    return NextResponse.json<ApiResponse>({ success: true, message: 'Live tracking already stopped' });
  }

  const employee = await queryOne<{ name: string; emp_id: string }>(
    'SELECT name, emp_id FROM employees WHERE id = ? LIMIT 1',
    [auth.id],
  );

  const now = toMySQLDatetime(new Date());
  await query(
    `UPDATE live_tracking_sessions
     SET is_active = FALSE,
         ended_at_utc = ?,
         last_ping_utc = ?
     WHERE id = ?`,
    [now, now, activeSession.id],
  );

  if (parsed.data.latitude != null && parsed.data.longitude != null) {
    await query(
      `INSERT INTO live_tracking_points (session_id, employee_id, tracked_at_utc, latitude, longitude, accuracy_meters)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        activeSession.id,
        auth.id,
        now,
        parsed.data.latitude,
        parsed.data.longitude,
        parsed.data.accuracy_meters ?? null,
      ],
    );
  }

  await insertAuditLog({
    action: 'live_tracking_stopped',
    entity: 'attendance',
    entity_id: activeSession.id,
    performed_by: auth.id,
    details: { stopped_at_utc: now },
    ip_address: request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
  });

  const admins = await query<{ email: string | null }>(
    `SELECT DISTINCT email
     FROM employees
     WHERE is_active = TRUE
       AND role IN ('super_admin', 'manager')
       AND email IS NOT NULL`,
  );
  await Promise.all(
    admins
      .map(a => a.email)
      .filter((email): email is string => !!email)
      .map(email => sendLiveTrackingAlert(email, {
        employeeName: employee?.name ?? auth.emp_id,
        empId: employee?.emp_id ?? auth.emp_id,
        reason: 'manual_stop',
        detectedAt: new Date(),
        sessionId: activeSession.id,
      })),
  );

  return NextResponse.json<ApiResponse>({ success: true, message: 'Live tracking stopped' });
}

import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import type { ApiResponse, LiveTrackingSession } from '@/lib/types';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['employee', 'manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;
  let isEnabledForEmployee = true;
  try {
    const employee = await queryOne<{ live_tracking_enabled: number | boolean }>(
      'SELECT live_tracking_enabled FROM employees WHERE id = ?',
      [auth.id],
    );
    isEnabledForEmployee = !!employee?.live_tracking_enabled;
  } catch (error) {
    const err = error as { code?: string };
    if (err?.code !== 'ER_BAD_FIELD_ERROR') throw error;
  }

  const activeSession = await queryOne<LiveTrackingSession>(
    `SELECT id, employee_id, started_at_utc, ended_at_utc, is_active, last_ping_utc, created_at
     FROM live_tracking_sessions
     WHERE employee_id = ? AND is_active = TRUE
     ORDER BY started_at_utc DESC
     LIMIT 1`,
    [auth.id],
  );

  return NextResponse.json<ApiResponse<{ enabled: boolean; session: LiveTrackingSession | null }>>({
    success: true,
    data: { enabled: isEnabledForEmployee && !!activeSession, session: activeSession ?? null },
  });
}

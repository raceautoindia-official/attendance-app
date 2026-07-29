import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { toMySQLDatetime } from '@/lib/attendance';
import type { ApiResponse, LiveTrackingSession } from '@/lib/types';

const PointSchema = z.object({
  latitude: z.number({ error: 'latitude must be a number' }),
  longitude: z.number({ error: 'longitude must be a number' }),
  accuracy_meters: z.number().min(0).max(10000).nullable().optional(),
  // GPS fix time from the device. Optional so old app builds (which send only
  // coordinates) keep working; those points are stamped with the server time.
  tracked_at_utc: z.iso.datetime().optional(),
});

// Either the legacy single-point body or a batch. The app batches when the OS
// delivers several fixes at once and when it retries points buffered offline.
const PingSchema = z.union([
  z.object({
    points: z.array(PointSchema).min(1).max(500),
    // The device's current time when it sent this request. Comparing it with
    // the server clock gives the phone's clock error, which is then removed
    // from every point — a phone set 20 minutes slow otherwise shows all its
    // tracking times 20 minutes early on the admin map.
    device_now_utc: z.iso.datetime().optional(),
  }),
  PointSchema,
]);

// Ignore skew smaller than this — that's just network latency, not a wrong
// clock, and GPS fix times are more precise than send time in that range.
const CLOCK_SKEW_TOLERANCE_MS = 30_000;

function clockOffsetMs(deviceNowIso: string | undefined, nowMs: number): number {
  if (!deviceNowIso) return 0;
  const deviceNow = new Date(deviceNowIso).getTime();
  if (Number.isNaN(deviceNow)) return 0;
  const offset = nowMs - deviceNow;
  return Math.abs(offset) > CLOCK_SKEW_TOLERANCE_MS ? offset : 0;
}

// Device clocks drift and users change them; after skew correction, only trust
// a timestamp that is plausible (not in the future, not older than a day) —
// otherwise fall back to the server time so the point still lands on the map.
// floorMs is the session's server-stamped start: no point may predate it, so a
// wrong phone clock can never make tracking appear to run before login.
function normalizeTrackedAt(iso: string | undefined, nowMs: number, offsetMs: number, floorMs: number): string {
  if (iso) {
    const t = new Date(iso).getTime() + offsetMs;
    if (!Number.isNaN(t) && t <= nowMs + 60_000 && t >= nowMs - 24 * 60 * 60 * 1000) {
      return toMySQLDatetime(new Date(Math.max(Math.min(t, nowMs), floorMs)));
    }
  }
  return toMySQLDatetime(new Date(nowMs));
}

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

  const parsed = PingSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Validation error' },
      { status: 400 },
    );
  }

  const points = 'points' in parsed.data ? parsed.data.points : [parsed.data];
  const deviceNowUtc = 'points' in parsed.data ? parsed.data.device_now_utc : undefined;

  const activeSession = await queryOne<LiveTrackingSession>(
    `SELECT id, employee_id, started_at_utc, ended_at_utc, is_active, last_ping_utc, created_at
     FROM live_tracking_sessions
     WHERE employee_id = ? AND is_active = TRUE
     ORDER BY started_at_utc DESC
     LIMIT 1`,
    [auth.id],
  );

  if (!activeSession) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'No active live-tracking session' },
      { status: 404 },
    );
  }

  const nowMs = Date.now();
  const offsetMs = clockOffsetMs(deviceNowUtc, nowMs);
  const sessionStartMs = new Date(activeSession.started_at_utc as unknown as string | Date).getTime();
  const floorMs = Number.isNaN(sessionStartMs) ? 0 : sessionStartMs;

  await query(
    `UPDATE live_tracking_sessions
     SET last_ping_utc = ?
     WHERE id = ?`,
    [toMySQLDatetime(new Date(nowMs)), activeSession.id],
  );

  const placeholders = points.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
  const params = points.flatMap(p => [
    activeSession.id,
    auth.id,
    normalizeTrackedAt(p.tracked_at_utc, nowMs, offsetMs, floorMs),
    p.latitude,
    p.longitude,
    p.accuracy_meters ?? null,
  ]);
  await query(
    `INSERT INTO live_tracking_points (session_id, employee_id, tracked_at_utc, latitude, longitude, accuracy_meters)
     VALUES ${placeholders}`,
    params,
  );

  return NextResponse.json<ApiResponse>({ success: true, message: 'Live-tracking ping saved' });
}

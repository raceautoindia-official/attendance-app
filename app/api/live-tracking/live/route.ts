import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { toMySQLDatetime } from '@/lib/attendance';
import type { ApiResponse } from '@/lib/types';

interface LiveRow {
  session_id: number;
  employee_id: number;
  emp_id: string;
  employee_name: string;
  started_at_utc: string;
  last_ping_utc: string | null;
  tracked_at_utc: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracy_meters: number | null;
  path?: LivePoint[];
}

interface LivePoint {
  tracked_at_utc: string;
  latitude: number;
  longitude: number;
  accuracy_meters: number | null;
}

interface LivePointRow extends LivePoint {
  session_id: number;
}

// GET /api/live-tracking/live
// employee -> own live session
// manager  -> team live sessions
// super_admin -> all live sessions
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['employee', 'manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;
  const searchParams = request.nextUrl.searchParams;
  // The client sends ISO 8601 (e.g. 2026-06-09T04:28:00.000Z), but the points
  // are stored in a MySQL DATETIME column as 'YYYY-MM-DD HH:MM:SS' (UTC). MySQL
  // cannot reliably compare a DATETIME against the 'T...Z' form, so normalize
  // both bounds to the stored format — otherwise the path query matches zero
  // rows and Path Points shows 0 even when points exist.
  const toMySQLBound = (raw: string | null): string | null => {
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : toMySQLDatetime(d);
  };
  const fromUtc = toMySQLBound(searchParams.get('from_utc'));
  const toUtc = toMySQLBound(searchParams.get('to_utc'));
  const includePathParam = searchParams.get('include_path');
  const includePath =
    includePathParam == null
      ? auth.role !== 'employee'
      : !['0', 'false', 'no'].includes(includePathParam.toLowerCase());

  const conditions: string[] = ['s.is_active = TRUE', 'e.is_active = TRUE'];
  const params: unknown[] = [];

  if (auth.role === 'employee') {
    conditions.push('s.employee_id = ?');
    params.push(auth.id);
  } else if (auth.role === 'manager') {
    conditions.push('e.manager_id = ?');
    params.push(auth.id);
  }

  const rows = await query<LiveRow>(
    `SELECT
       s.id AS session_id,
       s.employee_id,
       e.emp_id,
       e.name AS employee_name,
       s.started_at_utc,
       s.last_ping_utc,
       p.tracked_at_utc,
       p.latitude,
       p.longitude,
       p.accuracy_meters
     FROM live_tracking_sessions s
     JOIN employees e ON e.id = s.employee_id
     LEFT JOIN live_tracking_points p
       ON p.id = (
         SELECT p2.id
         FROM live_tracking_points p2
         WHERE p2.session_id = s.id
         ORDER BY p2.tracked_at_utc DESC, p2.id DESC
         LIMIT 1
       )
     WHERE ${conditions.join(' AND ')}
     ORDER BY s.last_ping_utc DESC, s.started_at_utc DESC`,
    params,
  );

  if (!rows.length) {
    return NextResponse.json<ApiResponse<{ sessions: LiveRow[] }>>({
      success: true,
      data: { sessions: [] },
    });
  }

  if (!includePath) {
    return NextResponse.json<ApiResponse<{ sessions: LiveRow[] }>>({
      success: true,
      data: { sessions: rows },
    });
  }

  const sessionIds = Array.from(new Set(rows.map(r => r.session_id)));
  const placeholders = sessionIds.map(() => '?').join(',');
  const pointConditions: string[] = [`session_id IN (${placeholders})`];
  const pointParams: unknown[] = [...sessionIds];
  if (fromUtc) {
    pointConditions.push('tracked_at_utc >= ?');
    pointParams.push(fromUtc);
  }
  if (toUtc) {
    pointConditions.push('tracked_at_utc <= ?');
    pointParams.push(toUtc);
  }
  const pointRows = await query<LivePointRow>(
    `SELECT
       session_id,
       tracked_at_utc,
       latitude,
       longitude,
       accuracy_meters
     FROM live_tracking_points
     WHERE ${pointConditions.join(' AND ')}
     ORDER BY session_id ASC, tracked_at_utc ASC, id ASC`,
    pointParams,
  );

  const pathBySession = new Map<number, LivePoint[]>();
  for (const point of pointRows) {
    if (point.latitude == null || point.longitude == null) continue;
    const existing = pathBySession.get(point.session_id);
    const normalized: LivePoint = {
      tracked_at_utc: point.tracked_at_utc,
      latitude: Number(point.latitude),
      longitude: Number(point.longitude),
      accuracy_meters: point.accuracy_meters != null ? Number(point.accuracy_meters) : null,
    };
    if (existing) existing.push(normalized);
    else pathBySession.set(point.session_id, [normalized]);
  }

  const sessionsWithPath = rows.map(row => ({
    ...row,
    path: pathBySession.get(row.session_id) ?? [],
  }));

  return NextResponse.json<ApiResponse<{ sessions: LiveRow[] }>>({
    success: true,
    data: { sessions: sessionsWithPath },
  });
}

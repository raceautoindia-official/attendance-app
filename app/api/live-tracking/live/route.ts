import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { getWorkDateIST, toMySQLDatetime, workDayStartUtc, workDayEndUtc } from '@/lib/attendance';
import type { ApiResponse } from '@/lib/types';

interface LiveRow {
  /**
   * NULL when the employee is on shift but has no live-tracking session — their
   * phone is not reporting. The row is still returned: absence from this list
   * used to be the only signal, and it is indistinguishable from having gone
   * home.
   */
  session_id: number | null;
  employee_id: number;
  emp_id: string;
  employee_name: string;
  started_at_utc: string;
  last_ping_utc: string | null;
  tracked_at_utc: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracy_meters: number | null;
  /** Name of the work site this employee marks attendance at, if one is assigned */
  location_name: string | null;
  location_address: string | null;
  /** Jitter-filtered route, for drawing a clean line on the map */
  path?: LivePoint[];
  /** Every fix actually recorded, in order — the admin's audit log. A
   *  stationary phone keeps pinging, and those points are dropped from `path`
   *  as jitter, so only this shows exactly where the employee was and when. */
  recorded_path?: LivePoint[];
  /** Total fixes recorded in the window, before any display cap */
  recorded_count?: number;
}

// The audit log is a UI list, not a dataset — cap what we ship per session so a
// long window can't return tens of thousands of rows. recorded_count still
// reports the true total.
const MAX_RECORDED_POINTS = 500;

interface LivePoint {
  tracked_at_utc: string;
  latitude: number;
  longitude: number;
  accuracy_meters: number | null;
}

interface LivePointRow extends LivePoint {
  session_id: number;
  employee_id: number;
}

// GPS fixes worse than this are Wi-Fi/cell-tower guesses that scatter hundreds
// of meters around a stationary phone — they stay in the DB (they still prove
// the app is alive) but are excluded from the map so the path shows real
// movement only.
const MAX_ACCURACY_M = Number(process.env.LIVE_TRACKING_MAX_ACCURACY_M) || 100;

// A segment faster than this (~144 km/h between pings) is a GPS glitch, not an
// employee — drop the jumping point instead of drawing a spike.
const MAX_SPEED_MPS = 40;

// Movement smaller than this never extends the path. Combined with each fix's
// own accuracy radius, this collapses the "fuzz ball" a stationary phone draws.
const MIN_MOVE_M = 30;

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Reduce raw fixes to genuine movement:
//  - drift smaller than the fixes' accuracy radius is jitter, not walking;
//  - segments faster than MAX_SPEED_MPS are glitches;
//  - a single point that leaves the cluster and immediately snaps back is an
//    outlier no matter how much time passed (this is what kills long spikes
//    that a pure speed check misses across ping gaps).
function cleanPath(points: LivePoint[]): LivePoint[] {
  const kept: LivePoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const prev = kept[kept.length - 1];
    if (!prev) {
      kept.push(p);
      continue;
    }
    const dist = haversineMeters(prev.latitude, prev.longitude, p.latitude, p.longitude);
    const jitterRadius = Math.max(MIN_MOVE_M, p.accuracy_meters ?? 0, prev.accuracy_meters ?? 0);
    if (dist <= jitterRadius) continue;
    const seconds =
      (new Date(p.tracked_at_utc).getTime() - new Date(prev.tracked_at_utc).getTime()) / 1000;
    if (seconds > 0 ? dist / seconds > MAX_SPEED_MPS : dist > 600) continue;
    const next = points[i + 1];
    if (next) {
      const returned = haversineMeters(prev.latitude, prev.longitude, Number(next.latitude), Number(next.longitude));
      if (returned <= jitterRadius) continue; // one-point excursion
    }
    kept.push(p);
  }
  return kept;
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
  // REVIEW A PAST DAY.
  //
  // Without this the page can only ever show people who are clocked in RIGHT
  // NOW (see the WHERE below), so at the end of the day — once everybody has
  // gone home — it is empty, and a day's movement cannot be looked at from it
  // at all. The time-range control did not help: it trims the path of people
  // still on shift rather than bringing finished ones back.
  //
  // With a date, the same rows are returned for that WORK DATE whether or not
  // the day was closed, and the path covers the whole day.
  const dateParam = searchParams.get('date');
  const reviewDate = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : null;

  const includePathParam = searchParams.get('include_path');
  const includePath =
    includePathParam == null
      ? auth.role !== 'employee'
      : !['0', 'false', 'no'].includes(includePathParam.toLowerCase());

  const conditions: string[] = ['e.is_active = TRUE'];
  const params: unknown[] = [];

  if (auth.role === 'employee') {
    conditions.push('a.employee_id = ?');
    params.push(auth.id);
  } else if (auth.role === 'manager') {
    conditions.push('e.manager_id = ?');
    params.push(auth.id);
  }

  // Driven by WHO IS CLOCKED IN, not by who has a tracking session.
  //
  // It used to start from live_tracking_sessions, so an employee on shift whose
  // phone was not reporting simply vanished from the page — and "vanished" is
  // indistinguishable from "went home". Three people disappeared from this list
  // on the same afternoon they were sitting at their desks, and answering why
  // took four wrong guesses. Someone on shift now always appears; whether their
  // phone is reporting is shown as a fact about them, not by their absence.
  const rows = await query<LiveRow>(
    `SELECT
       s.id AS session_id,
       a.employee_id,
       e.emp_id,
       e.name AS employee_name,
       COALESCE(s.started_at_utc, a.clock_in_utc) AS started_at_utc,
       s.last_ping_utc,
       p.tracked_at_utc,
       p.latitude,
       p.longitude,
       p.accuracy_meters,
       l.name    AS location_name,
       l.address AS location_address
     FROM attendance a
     JOIN employees e ON e.id = a.employee_id
     -- The open session IS the definition of "on shift": clocked in, not yet
     -- clocked out. Matching on work_date instead would drop anyone still on an
     -- overnight shift once the 07:00 boundary moved the date on.
     -- Reviewing a finished day, the ACTIVE session is the wrong one to attach
     -- (there may be none, or one from a later day). Take the session that
     -- covers this attendance instead.
     LEFT JOIN live_tracking_sessions s
       ON ${reviewDate
            ? `s.id = (SELECT s2.id FROM live_tracking_sessions s2
                        WHERE s2.employee_id = a.employee_id
                          AND s2.started_at_utc >= a.clock_in_utc
                        ORDER BY s2.started_at_utc ASC LIMIT 1)`
            : 's.employee_id = a.employee_id AND s.is_active = TRUE'}
     -- The work site this employee is scheduled to mark attendance at, so the
     -- Overview can name the place instead of only showing raw coordinates.
     LEFT JOIN employee_schedules es
       ON es.id = (
         SELECT es2.id
         FROM employee_schedules es2
         WHERE es2.employee_id = a.employee_id
           AND es2.effective_from <= ?
           AND (es2.effective_to IS NULL OR es2.effective_to >= ?)
         ORDER BY es2.effective_from DESC, es2.id DESC
         LIMIT 1
       )
     LEFT JOIN locations l ON l.id = es.location_id
     -- Latest fix of this shift. Keyed on the employee and their clock-in
     -- rather than on the session id, so a phone that reported before its
     -- session was replaced still shows its last known position instead of a
     -- blank row.
     LEFT JOIN live_tracking_points p
       ON p.id = (
         SELECT p2.id
         FROM live_tracking_points p2
         WHERE p2.employee_id = a.employee_id
           AND p2.tracked_at_utc >= a.clock_in_utc
         ORDER BY (p2.accuracy_meters IS NULL OR p2.accuracy_meters <= ?) DESC,
                  p2.tracked_at_utc DESC, p2.id DESC
         LIMIT 1
       )
     WHERE a.clock_in_utc IS NOT NULL
       ${reviewDate ? 'AND a.work_date = ?' : 'AND a.clock_out_utc IS NULL'}
       AND ${conditions.join(' AND ')}
     ORDER BY p.tracked_at_utc IS NULL, p.tracked_at_utc DESC, a.clock_in_utc DESC`,
    // The two schedule-date params come first: that subquery appears before the
    // accuracy-ordered point lookup in the statement.
    [
      reviewDate ?? getWorkDateIST(), reviewDate ?? getWorkDateIST(),
      MAX_ACCURACY_M,
      ...(reviewDate ? [reviewDate] : []),
      ...params,
    ],
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

  // Someone on shift whose phone is not reporting has no session at all, so
  // session_id is NULL for them. Left in, those would build `IN (NULL)` — and
  // if NOBODY has a session, `IN ()`, which is a syntax error that would take
  // the whole page down rather than showing it with empty paths.
  const employeeIds = Array.from(new Set(rows.map(r => r.employee_id)));
  const sessionIds = Array.from(new Set(rows.map(r => r.session_id).filter((id): id is number => id != null)));
  // In review mode a row with no session still has points to show, so the
  // early return only applies to live mode.
  if (!reviewDate && !sessionIds.length) {
    return NextResponse.json<ApiResponse<{ sessions: LiveRow[] }>>({
      success: true,
      data: { sessions: rows.map(row => ({ ...row, path: [], recorded_path: [], recorded_count: 0 })) },
    });
  }
  const keyIds = reviewDate ? employeeIds : sessionIds;
  const keyCol = reviewDate ? 'employee_id' : 'session_id';
  const placeholders = keyIds.map(() => '?').join(',');
  const pointConditions: string[] = [
    `${keyCol} IN (${placeholders})`,
    '(accuracy_meters IS NULL OR accuracy_meters <= ?)',
  ];
  const pointParams: unknown[] = [...keyIds, MAX_ACCURACY_M];
  // Bound a reviewed day to the work day itself (07:00 to 07:00), or a session
  // spanning midnight would drag in the neighbouring day's movement. An
  // explicit range from the caller still wins.
  if (reviewDate && !fromUtc && !toUtc) {
    pointConditions.push('tracked_at_utc >= ?', 'tracked_at_utc <= ?');
    pointParams.push(
      toMySQLDatetime(workDayStartUtc(reviewDate)),
      toMySQLDatetime(workDayEndUtc(reviewDate)),
    );
  }
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
       employee_id,
       tracked_at_utc,
       latitude,
       longitude,
       accuracy_meters
     FROM live_tracking_points
     WHERE ${pointConditions.join(' AND ')}
     ORDER BY ${keyCol} ASC, tracked_at_utc ASC, id ASC`,
    pointParams,
  );

  const rawBySession = new Map<number, LivePoint[]>();
  for (const point of pointRows) {
    if (point.latitude == null || point.longitude == null) continue;
    const normalized: LivePoint = {
      tracked_at_utc: point.tracked_at_utc,
      latitude: Number(point.latitude),
      longitude: Number(point.longitude),
      accuracy_meters: point.accuracy_meters != null ? Number(point.accuracy_meters) : null,
    };
    const key = reviewDate ? point.employee_id : point.session_id;
    if (key == null) continue;
    const existing = rawBySession.get(key);
    if (existing) existing.push(normalized);
    else rawBySession.set(key, [normalized]);
  }

  const sessionsWithPath = rows.map(row => {
    const key = reviewDate ? row.employee_id : row.session_id;
    const raw = (key != null ? rawBySession.get(key) : undefined) ?? [];
    return {
      ...row,
      path: cleanPath(raw),
      // Keep the MOST RECENT points when capping — the tail is what an admin
      // is looking at, and the count below still states the real total.
      recorded_path: raw.length > MAX_RECORDED_POINTS ? raw.slice(-MAX_RECORDED_POINTS) : raw,
      recorded_count: raw.length,
    };
  });

  return NextResponse.json<ApiResponse<{ sessions: LiveRow[] }>>({
    success: true,
    data: { sessions: sessionsWithPath },
  });
}

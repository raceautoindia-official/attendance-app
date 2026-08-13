import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { haversineDistance } from '@/lib/geo';
import { getWorkDateIST, previousWorkDate } from '@/lib/attendance';
import {
  hasOutOfFenceReviewColumns,
  hasOutOfFenceReasonColumn,
} from '@/lib/employeeDetails';
import { hasPermissionTable, hasOnDutyColumn } from '@/lib/permissions';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// GET /api/notifications
//
// Everything an admin should look at, GROUPED BY DAY.
//
// It used to list one thing: a clock-in from away from the work site that
// carried a typed reason. That left three gaps.
//
//  • Off-site clock-ins with NO reason were invisible. An approved on-duty
//    clock-in from a customer site is exactly that, and so were older rows
//    from before the reason column existed.
//  • REFUSED attempts were invisible, and they are now the common case: since
//    the reason box was removed, somebody away from site is turned away rather
//    than let in. Nothing showed that it had happened.
//  • Permission requests and their approve/reject decisions lived on a
//    different page entirely, so there was nowhere to see what was decided on
//    a given day.
//
//   ?status=pending|approved|rejected|all   (default: all)
//   ?from_date=&to_date=                     (default: the last 30 days)
//   ?limit=                                  (default 200, max 500)
// ---------------------------------------------------------------------------

type Decision = 'pending' | 'approved' | 'rejected' | 'none';

interface NotificationItem {
  /** Stable key, unique across the kinds. */
  id: string;
  kind: 'off_site_clock_in' | 'off_site_refused' | 'permission_request';
  employee_id: number;
  employee_name: string;
  emp_id: string;
  work_date: string;
  /** When the thing happened (UTC ISO). */
  at_utc: string | null;
  /** 'none' for an event nobody decides on, like a refused attempt. */
  decision: Decision;
  reviewed_at: string | null;
  reviewed_by_name: string | null;
  review_notes: string | null;
  /** Set for off-site items: the attendance row to review. */
  attendance_id?: number;
  reason?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  distance_m?: number | null;
  radius_m?: number | null;
  /** The fix's own accuracy, when the phone reported one (refusals). */
  accuracy_m?: number | null;
  location_name?: string | null;
  /** Set for permission items. */
  permission_id?: number;
  request_type?: string;
  start_time?: string;
  end_time?: string;
  minutes?: number;
}

interface DayGroup {
  work_date: string;
  items: NotificationItem[];
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);
  const statusParam = searchParams.get('status') ?? 'all';
  const limit = Math.min(Math.max(1, Number(searchParams.get('limit') ?? 200)), 500);

  const isDate = (v: string | null) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const toDate = isDate(searchParams.get('to_date'))
    ? (searchParams.get('to_date') as string)
    : getWorkDateIST();
  const fromDate = isDate(searchParams.get('from_date'))
    ? (searchParams.get('from_date') as string)
    : (() => {
        let d = toDate;
        for (let i = 0; i < 30; i++) d = previousWorkDate(d);
        return d;
      })();

  const [reviewCols, reasonCol, permissionsAvailable, onDutyCol] = await Promise.all([
    hasOutOfFenceReviewColumns(),
    hasOutOfFenceReasonColumn(),
    hasPermissionTable(),
    hasOnDutyColumn(),
  ]);

  // A manager sees their own team; a super admin sees everybody.
  const scopeSql = auth.role === 'manager' ? 'AND e.manager_id = ?' : '';
  const scopeParams = auth.role === 'manager' ? [auth.id] : [];

  const items: NotificationItem[] = [];

  // -------------------------------------------------------------------------
  // 1. Clock-ins from away from the work site.
  //
  // Keyed on geofence_status, NOT on the review columns. A row only has a
  // review status if a reason was typed, and that is now impossible — so
  // filtering by it would show an ever-staler set of historical rows and
  // nothing that happens from here on.
  // -------------------------------------------------------------------------
  const offSite = await query<{
    attendance_id: number; employee_id: number; employee_name: string; emp_id: string;
    work_date: string; clock_in_utc: string;
    clock_in_lat: number | null; clock_in_lng: number | null;
    reason: string | null; status: string | null;
    reviewed_at: string | null; reviewed_by_name: string | null; review_notes: string | null;
    location_name: string | null; location_lat: number | null; location_lng: number | null;
    radius_meters: number | null;
  }>(
    `SELECT a.id AS attendance_id, a.employee_id, e.name AS employee_name, e.emp_id,
            DATE_FORMAT(a.work_date, '%Y-%m-%d') AS work_date,
            a.clock_in_utc, a.clock_in_lat, a.clock_in_lng,
            ${reasonCol ? 'a.out_of_fence_reason' : 'NULL'} AS reason,
            ${reviewCols ? 'a.out_of_fence_status' : 'NULL'} AS status,
            ${reviewCols ? 'a.out_of_fence_reviewed_at' : 'NULL'} AS reviewed_at,
            ${reviewCols ? 'r.name' : 'NULL'} AS reviewed_by_name,
            ${reviewCols ? 'a.out_of_fence_review_notes' : 'NULL'} AS review_notes,
            l.name AS location_name, l.latitude AS location_lat,
            l.longitude AS location_lng, l.radius_meters
       FROM attendance a
       JOIN employees e ON e.id = a.employee_id
       ${reviewCols ? 'LEFT JOIN employees r ON r.id = a.out_of_fence_reviewed_by' : ''}
       LEFT JOIN employee_schedules es ON es.id = (
         SELECT es2.id FROM employee_schedules es2
          WHERE es2.employee_id = a.employee_id
            AND es2.effective_from <= a.work_date
            AND (es2.effective_to IS NULL OR es2.effective_to >= a.work_date)
          ORDER BY es2.effective_from DESC, es2.id DESC LIMIT 1)
       LEFT JOIN locations l ON l.id = es.location_id
      WHERE a.geofence_status = 'outside'
        AND a.clock_in_utc IS NOT NULL
        AND a.work_date BETWEEN ? AND ?
        ${scopeSql}
      ORDER BY a.clock_in_utc DESC
      LIMIT ?`,
    [fromDate, toDate, ...scopeParams, limit],
  );

  for (const r of offSite) {
    const away = r.clock_in_lat != null && r.clock_in_lng != null
      && r.location_lat != null && r.location_lng != null
      ? Math.round(haversineDistance(
          Number(r.clock_in_lat), Number(r.clock_in_lng),
          Number(r.location_lat), Number(r.location_lng)))
      : null;
    items.push({
      id: `att-${r.attendance_id}`,
      kind: 'off_site_clock_in',
      attendance_id: r.attendance_id,
      employee_id: r.employee_id,
      employee_name: r.employee_name,
      emp_id: r.emp_id,
      work_date: r.work_date,
      at_utc: r.clock_in_utc,
      // No review status means nobody has been asked to look at it — which is
      // the truth for an on-duty clock-in and for rows predating the column.
      decision: (r.status as Decision) ?? 'none',
      reviewed_at: r.reviewed_at,
      reviewed_by_name: r.reviewed_by_name,
      review_notes: r.review_notes,
      reason: r.reason,
      latitude: r.clock_in_lat == null ? null : Number(r.clock_in_lat),
      longitude: r.clock_in_lng == null ? null : Number(r.clock_in_lng),
      distance_m: Number.isFinite(away as number) ? away : null,
      radius_m: r.radius_meters == null ? null : Number(r.radius_meters),
      location_name: r.location_name,
    });
  }

  // -------------------------------------------------------------------------
  // 2. REFUSED attempts to clock in from away from the site.
  //
  // Read from the audit log, which is where the refusal is recorded — there is
  // no attendance row, because the whole point is that they were not put on the
  // clock. Without this an admin's only clue was a missing day.
  // -------------------------------------------------------------------------
  const refused = await query<{
    id: number; employee_id: number; employee_name: string; emp_id: string;
    created_at: string; details: string | Record<string, unknown> | null;
  }>(
    `SELECT al.id, al.entity_id AS employee_id, e.name AS employee_name, e.emp_id,
            al.created_at, al.details
       FROM audit_log al
       JOIN employees e ON e.id = al.entity_id
      WHERE al.action = 'clock_in_refused_outside_fence'
        AND al.entity = 'employee'
        AND JSON_UNQUOTE(JSON_EXTRACT(al.details, '$.work_date')) BETWEEN ? AND ?
        ${scopeSql}
      ORDER BY al.created_at DESC
      LIMIT ?`,
    [fromDate, toDate, ...scopeParams, limit],
  );

  for (const r of refused) {
    // mysql2 hands a JSON column back as an object on some server versions and
    // as a string on others.
    let d: Record<string, unknown> = {};
    if (typeof r.details === 'string') {
      try { d = JSON.parse(r.details) as Record<string, unknown>; } catch { d = {}; }
    } else if (r.details && typeof r.details === 'object') {
      d = r.details as Record<string, unknown>;
    }
    const num = (v: unknown) => (typeof v === 'number' ? v : null);
    items.push({
      id: `refused-${r.id}`,
      kind: 'off_site_refused',
      employee_id: r.employee_id,
      employee_name: r.employee_name,
      emp_id: r.emp_id,
      work_date: String(d.work_date ?? ''),
      at_utc: r.created_at,
      // Nothing to approve: they were turned away. It is a record of an
      // attempt, not a request waiting on anybody.
      decision: 'none',
      reviewed_at: null,
      reviewed_by_name: null,
      review_notes: null,
      latitude: num(d.latitude),
      longitude: num(d.longitude),
      distance_m: num(d.distance_m),
      radius_m: num(d.radius_m),
      accuracy_m: num(d.accuracy_m),
      location_name: typeof d.location === 'string' ? d.location : null,
      reason: d.after_fence_closure === true
        ? 'Tried to clock back in after the fence ended their day'
        : null,
    });
  }

  // -------------------------------------------------------------------------
  // 3. Permission requests, with what was decided.
  // -------------------------------------------------------------------------
  if (permissionsAvailable) {
    const perms = await query<{
      id: number; employee_id: number; employee_name: string; emp_id: string;
      permission_date: string; request_type: string; start_time: string; end_time: string;
      minutes: number; reason: string | null; status: string;
      reviewed_at: string | null; reviewed_by_name: string | null; review_notes: string | null;
      created_at: string;
    }>(
      `SELECT pr.id, pr.employee_id, e.name AS employee_name, e.emp_id,
              DATE_FORMAT(pr.permission_date, '%Y-%m-%d') AS permission_date,
              ${onDutyCol ? 'pr.request_type' : "'permission' AS request_type"},
              pr.start_time, pr.end_time, pr.minutes, pr.reason, pr.status,
              pr.reviewed_at, rv.name AS reviewed_by_name, pr.review_notes, pr.created_at
         FROM permission_requests pr
         JOIN employees e ON e.id = pr.employee_id
         LEFT JOIN employees rv ON rv.id = pr.reviewed_by
        WHERE pr.permission_date BETWEEN ? AND ?
          ${scopeSql}
        ORDER BY pr.permission_date DESC, pr.id DESC
        LIMIT ?`,
      [fromDate, toDate, ...scopeParams, limit],
    );

    for (const p of perms) {
      items.push({
        id: `perm-${p.id}`,
        kind: 'permission_request',
        permission_id: p.id,
        employee_id: p.employee_id,
        employee_name: p.employee_name,
        emp_id: p.emp_id,
        work_date: p.permission_date,
        at_utc: p.created_at,
        // 'cancelled' is a real status in the table but not a decision an admin
        // made, so it lands as 'none' rather than pretending to be a rejection.
        decision: p.status === 'pending' || p.status === 'approved' || p.status === 'rejected'
          ? p.status
          : 'none',
        reviewed_at: p.reviewed_at,
        reviewed_by_name: p.reviewed_by_name,
        review_notes: p.review_notes,
        reason: p.reason,
        request_type: p.request_type,
        start_time: p.start_time,
        end_time: p.end_time,
        minutes: Number(p.minutes ?? 0),
      });
    }
  }

  // Filter AFTER assembling, so one rule covers all three kinds.
  const filtered = ['pending', 'approved', 'rejected'].includes(statusParam)
    ? items.filter(i => i.decision === statusParam)
    : items;

  // Group by day, newest day first, and newest thing first within a day.
  const byDay = new Map<string, NotificationItem[]>();
  for (const i of filtered) {
    if (!byDay.has(i.work_date)) byDay.set(i.work_date, []);
    byDay.get(i.work_date)!.push(i);
  }
  const days: DayGroup[] = Array.from(byDay.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([work_date, dayItems]) => ({
      work_date,
      items: dayItems.sort((a, b) => String(b.at_utc ?? '').localeCompare(String(a.at_utc ?? ''))),
    }));

  // The sidebar badge. Always the PENDING total whatever is being listed, or it
  // would change just because the admin filtered the page to "approved".
  const pendingOffSite = reviewCols
    ? Number((await queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM attendance a JOIN employees e ON e.id = a.employee_id
          WHERE a.out_of_fence_status = 'pending' ${scopeSql}`,
        scopeParams,
      ))?.n ?? 0)
    : 0;
  const pendingPermissions = permissionsAvailable
    ? Number((await queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM permission_requests pr JOIN employees e ON e.id = pr.employee_id
          WHERE pr.status = 'pending' ${scopeSql}`,
        scopeParams,
      ))?.n ?? 0)
    : 0;

  return NextResponse.json<ApiResponse<{
    days: DayGroup[];
    from_date: string;
    to_date: string;
    pending_count: number;
    totals: { off_site: number; refused: number; permission: number };
  }>>(
    {
      success: true,
      data: {
        days,
        from_date: fromDate,
        to_date: toDate,
        pending_count: pendingOffSite + pendingPermissions,
        totals: {
          off_site: items.filter(i => i.kind === 'off_site_clock_in').length,
          refused: items.filter(i => i.kind === 'off_site_refused').length,
          permission: items.filter(i => i.kind === 'permission_request').length,
        },
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

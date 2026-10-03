import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { readJsonColumn } from '@/lib/jsonColumn';
import { requireAuth } from '@/lib/auth';
import {
  canAccessEmployee,
  hasSessionColumns,
  hasOutOfFenceReasonColumn,
  hasOutOfFenceReviewColumns,
} from '@/lib/employeeDetails';
import { getWorkDateIST, workDayEndUtc, previousWorkDate, toMySQLDatetime } from '@/lib/attendance';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// GET /api/employees/[id]/timeline?date=YYYY-MM-DD
//
// One employee's work day as a single chronological story. The pieces already
// existed — attendance, the audit log, permissions, tracking points — but an
// admin answering "what happened with Shankar today?" had to reconstruct it
// from four pages. This endpoint does the reconstruction once, server-side:
// every event between the day's 07:00 boundaries, in order, in words.
//
// Access: the employee themself, their manager, or a super admin — the same
// rule as the rest of their record.
// ---------------------------------------------------------------------------

interface TimelineEvent {
  at_utc: string;
  /** Stable machine kind, e.g. 'clock_in' — the UI picks colours from it. */
  kind: string;
  /** One human line: what happened. */
  title: string;
  /** Optional second line: why / how far / by whom. */
  detail: string | null;
  latitude: number | null;
  longitude: number | null;
}

// The audit actions worth narrating, and how to say them. Everything else in
// the log (schema checks, admin CRUD elsewhere) is noise for this view.
const AUDIT_NARRATION: Record<string, (d: Record<string, unknown>) => { title: string; detail: string | null }> = {
  clock_in: d => ({
    title: d.auto === true ? 'Clocked in automatically (returned to site)' : 'Clocked in',
    detail: d.out_of_fence_reason ? `Off-site, reason: ${d.out_of_fence_reason}` : null,
  }),
  clock_out: d => ({
    title: d.auto === true
      ? `Clocked out automatically${d.reason === 'location_off' ? ' (location was off)' : d.reason === 'geofence_exit' ? ' (left the site)' : ''}`
      : 'Clocked out',
    detail: null,
  }),
  geofence_auto_clockout: d => ({
    title: 'Clocked out by the server watchdog',
    detail: d.reason === 'left_the_fence'
      ? `Left the fence — unconfirmed for ${d.minutes_unconfirmed} min`
      : `Presence never confirmed inside the fence (${d.minutes_unconfirmed} min)`,
  }),
  clock_in_outside_fence: d => ({
    title: 'Clocked in away from the work site',
    detail: `${d.distance_m != null ? `${d.distance_m} m from ${d.location ?? 'site'} — ` : ''}reason: ${d.reason}`,
  }),
  off_site_clock_in_approved: d => ({
    title: 'Off-site clock-in approved',
    detail: (d.review_notes as string) ?? null,
  }),
  off_site_clock_in_rejected: d => ({
    title: 'Off-site clock-in disputed',
    detail: (d.review_notes as string) ?? null,
  }),
  live_tracking_signal_lost: () => ({
    title: 'Phone went silent',
    detail: 'No location fix for several minutes — admins alerted',
  }),
  marked_absent: () => ({ title: 'Marked absent', detail: 'No clock-in and no leave for the day' }),
  device_bound: () => ({ title: 'New phone registered', detail: null }),
  permission_approved: d => ({
    title: 'Permission request approved',
    detail: (d.review_notes as string) ?? null,
  }),
  permission_rejected: d => ({
    title: 'Permission request rejected',
    detail: (d.review_notes as string) ?? null,
  }),
  permission_cancelled: () => ({ title: 'Permission request cancelled by the employee', detail: null }),
};

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(request, ['employee', 'manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const { id } = await context.params;
  const employeeId = Number(id);
  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid employee id' }, { status: 400 });
  }
  if (!(await canAccessEmployee(auth, employeeId))) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Not your record to read' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const workDate = /^\d{4}-\d{2}-\d{2}$/.test(searchParams.get('date') ?? '')
    ? (searchParams.get('date') as string)
    : getWorkDateIST();

  // The day's UTC window: it STARTS where the previous work day ended (07:00
  // boundary) and ends at its own boundary — midnight has no meaning here.
  const startUtc = workDayEndUtc(previousWorkDate(workDate));
  const endUtc = workDayEndUtc(workDate);

  const employee = await queryOne<{ name: string; emp_id: string }>(
    'SELECT name, emp_id FROM employees WHERE id = ?', [employeeId]);
  if (!employee) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Employee not found' }, { status: 404 });
  }

  // Everything the audit log saw for this person in the window. employee_id is
  // carried in details on every attendance-adjacent action precisely so one
  // filter can pull a person's whole trail.
  const auditRows = await query<{
    created_at: string;
    action: string;
    // Both shapes — see readJsonColumn. Typed as string only, this parsed as
    // nothing at all and every event lost its reason line and its map pin.
    details: string | Record<string, unknown> | null;
  }>(
    `SELECT created_at, action, details
     FROM audit_log
     WHERE created_at >= ? AND created_at < ?
       AND JSON_EXTRACT(details, '$.employee_id') = ?
     ORDER BY created_at DESC
     LIMIT 300`,
    [toMySQLDatetime(startUtc), toMySQLDatetime(endUtc), employeeId],
  );

  // Newest 300 kept, then flipped to chronological. Ordering ASC with a limit
  // keeps the OLDEST rows and silently drops the end of a busy day — the exact
  // events an admin opens this view to see. A production day was found with
  // 694 audit rows, and the approval being looked for was in the discarded
  // tail.
  auditRows.reverse();
  const truncated = auditRows.length === 300;
  const events: TimelineEvent[] = [];
  for (const row of auditRows) {
    const narrate = AUDIT_NARRATION[row.action];
    if (!narrate) continue;
    const details = readJsonColumn(row.details);
    const { title, detail } = narrate(details);
    events.push({
      at_utc: new Date(row.created_at).toISOString(),
      kind: row.action,
      title,
      detail,
      latitude: typeof details.latitude === 'number' ? details.latitude : null,
      longitude: typeof details.longitude === 'number' ? details.longitude : null,
    });
  }

  // The attendance row carries the day's verdict even when no audit event does
  // (e.g. a holiday row), and the tracking summary says whether the phone was
  // alive between the events.
  //
  // Every optional column is guarded the way the rest of the app guards them.
  // Naming one bare took the WHOLE endpoint down with ER_BAD_FIELD_ERROR on a
  // database where that migration had not run — the modal said only "Could not
  // load the day", so a missing migration looked like a broken feature. A day
  // whose extras are unavailable should still show its clock-in and clock-out.
  const [sessionCols, reasonCol, reviewCols] = await Promise.all([
    hasSessionColumns(),
    hasOutOfFenceReasonColumn(),
    hasOutOfFenceReviewColumns(),
  ]);
  const attendance = await queryOne<Record<string, unknown>>(
    `SELECT DATE_FORMAT(work_date, '%Y-%m-%d') AS work_date, clock_in_utc, clock_out_utc,
            total_minutes, status, geofence_status,
            ${sessionCols ? 'banked_minutes, session_count' : '0 AS banked_minutes, 1 AS session_count'},
            ${reasonCol ? 'out_of_fence_reason' : 'NULL AS out_of_fence_reason'},
            ${reviewCols ? 'out_of_fence_status' : 'NULL AS out_of_fence_status'}
     FROM attendance WHERE employee_id = ? AND work_date = ?`,
    [employeeId, workDate],
  );

  const tracking = await queryOne<{ points: number; first_utc: string | null; last_utc: string | null }>(
    `SELECT COUNT(*) AS points, MIN(tracked_at_utc) AS first_utc, MAX(tracked_at_utc) AS last_utc
     FROM live_tracking_points
     WHERE employee_id = ? AND tracked_at_utc >= ? AND tracked_at_utc < ?`,
    [employeeId, toMySQLDatetime(startUtc), toMySQLDatetime(endUtc)],
  );

  return NextResponse.json<ApiResponse<{
    employee: { id: number; name: string; emp_id: string };
    work_date: string;
    events: TimelineEvent[];
    truncated: boolean;
    attendance: Record<string, unknown> | null;
    tracking: { points: number; first_utc: string | null; last_utc: string | null };
  }>>({
    success: true,
    data: {
      employee: { id: employeeId, ...employee },
      work_date: workDate,
      events,
      truncated,
      attendance: attendance ?? null,
      tracking: {
        points: Number(tracking?.points ?? 0),
        first_utc: tracking?.first_utc ? new Date(tracking.first_utc).toISOString() : null,
        last_utc: tracking?.last_utc ? new Date(tracking.last_utc).toISOString() : null,
      },
    },
  }, { headers: { 'Cache-Control': 'no-store' } });
}

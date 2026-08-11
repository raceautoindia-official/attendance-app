import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { hasOutOfFenceReviewColumns } from '@/lib/employeeDetails';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// GET /api/notifications
//
// Things an admin should look at. Today that means one thing: somebody clocked
// in away from their work site and gave a reason.
//
// Reviewing is NOT approval-to-work. The employee is clocked in the moment they
// give a reason and stays clocked in whether or not anyone ever opens this
// page — an unreviewed clock-in counts exactly as much as an approved one.
// What is recorded here is the admin's position on the trip, not permission for
// it. Nobody's pay should depend on how quickly a manager reads a list.
//
//   ?status=pending|approved|rejected|all   (default: pending)
//   ?limit=                                  (default 50, max 200)
// ---------------------------------------------------------------------------

interface NotificationRow {
  attendance_id: number;
  employee_id: number;
  employee_name: string;
  emp_id: string;
  work_date: string;
  clock_in_utc: string;
  clock_in_lat: number | null;
  clock_in_lng: number | null;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewed_at: string | null;
  reviewed_by_name: string | null;
  review_notes: string | null;
  location_name: string | null;
  location_lat: number | null;
  location_lng: number | null;
  radius_meters: number | null;
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  // Before the migration there is nothing to review — and an empty list is the
  // truthful answer, not a 500 that makes the whole page look broken.
  if (!(await hasOutOfFenceReviewColumns())) {
    return NextResponse.json<ApiResponse<{ notifications: NotificationRow[]; pending_count: number }>>({
      success: true,
      data: { notifications: [], pending_count: 0 },
    });
  }

  const { searchParams } = new URL(request.url);
  const statusParam = searchParams.get('status') ?? 'pending';
  const limit = Math.min(Math.max(1, Number(searchParams.get('limit') ?? 50)), 200);

  const conditions = ['a.out_of_fence_status IS NOT NULL'];
  const params: unknown[] = [];

  if (['pending', 'approved', 'rejected'].includes(statusParam)) {
    conditions.push('a.out_of_fence_status = ?');
    params.push(statusParam);
  }
  // A manager sees their own team; a super admin sees everybody.
  if (auth.role === 'manager') {
    conditions.push('e.manager_id = ?');
    params.push(auth.id);
  }

  const rows = await query<NotificationRow>(
    `SELECT a.id AS attendance_id, a.employee_id, e.name AS employee_name, e.emp_id,
            DATE_FORMAT(a.work_date, '%Y-%m-%d') AS work_date,
            a.clock_in_utc, a.clock_in_lat, a.clock_in_lng,
            a.out_of_fence_reason  AS reason,
            a.out_of_fence_status  AS status,
            a.out_of_fence_reviewed_at AS reviewed_at,
            r.name AS reviewed_by_name,
            a.out_of_fence_review_notes AS review_notes,
            l.name AS location_name, l.latitude AS location_lat,
            l.longitude AS location_lng, l.radius_meters
     FROM attendance a
     JOIN employees e ON e.id = a.employee_id
     LEFT JOIN employees r ON r.id = a.out_of_fence_reviewed_by
     LEFT JOIN employee_schedules es ON es.id = (
       SELECT es2.id FROM employee_schedules es2
        WHERE es2.employee_id = a.employee_id
          AND es2.effective_from <= a.work_date
          AND (es2.effective_to IS NULL OR es2.effective_to >= a.work_date)
        ORDER BY es2.effective_from DESC, es2.id DESC LIMIT 1)
     LEFT JOIN locations l ON l.id = es.location_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY a.clock_in_utc DESC
     LIMIT ?`,
    [...params, limit],
  );

  // Always the PENDING total, whatever is being listed — it is what the sidebar
  // badge shows, and it must not change just because the admin filtered the
  // page to "approved".
  const countConditions = ["a.out_of_fence_status = 'pending'"];
  const countParams: unknown[] = [];
  if (auth.role === 'manager') {
    countConditions.push('e.manager_id = ?');
    countParams.push(auth.id);
  }
  const countRow = await queryOne<{ total: number }>(
    `SELECT COUNT(*) AS total
       FROM attendance a JOIN employees e ON e.id = a.employee_id
      WHERE ${countConditions.join(' AND ')}`,
    countParams,
  );

  return NextResponse.json<ApiResponse<{ notifications: NotificationRow[]; pending_count: number }>>(
    {
      success: true,
      data: { notifications: rows, pending_count: Number(countRow?.total ?? 0) },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

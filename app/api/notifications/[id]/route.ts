import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { hasOutOfFenceReviewColumns } from '@/lib/employeeDetails';
import type { ApiResponse } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

// ---------------------------------------------------------------------------
// PATCH /api/notifications/[id] — approve or reject an off-site clock-in.
//
// NEITHER OUTCOME CHANGES THE ATTENDANCE. The employee was clocked in when they
// gave their reason, and stays clocked in: same hours, same status, same pay,
// whether this is approved, rejected, or never looked at. Rejecting records that
// the admin disputes the trip and flags the day for a conversation — taking
// somebody's hours away is an explicit edit in Checkin Records, not a side
// effect of a button on a notifications screen.
//
// [id] is the attendance row id.
// ---------------------------------------------------------------------------

const PatchSchema = z.object({
  action: z.enum(['approve', 'reject']),
  review_notes: z.string().max(500).nullable().optional(),
});

export async function PATCH(request: NextRequest, context: Params) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  if (!(await hasOutOfFenceReviewColumns())) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Off-site review is not set up on this server yet' },
      { status: 503 },
    );
  }

  const { id } = await context.params;
  const attendanceId = Number(id);
  if (!Number.isInteger(attendanceId) || attendanceId <= 0) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid id' }, { status: 400 });
  }

  const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "action must be 'approve' or 'reject'" },
      { status: 400 },
    );
  }
  const { action, review_notes } = parsed.data;
  const nextStatus = action === 'approve' ? 'approved' : 'rejected';

  const existing = await queryOne<{
    id: number;
    employee_id: number;
    emp_id: string;
    manager_id: number | null;
    out_of_fence_status: string | null;
    out_of_fence_reason: string | null;
  }>(
    `SELECT a.id, a.employee_id, e.emp_id, e.manager_id,
            a.out_of_fence_status, a.out_of_fence_reason
     FROM attendance a JOIN employees e ON e.id = a.employee_id
     WHERE a.id = ?`,
    [attendanceId],
  );
  if (!existing || !existing.out_of_fence_status) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'No off-site clock-in to review here' },
      { status: 404 },
    );
  }
  // A manager reviews their own team only.
  if (auth.role === 'manager' && existing.manager_id !== auth.id) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'That employee is not on your team' },
      { status: 403 },
    );
  }
  // Already decided. The compare-and-set below only stops two admins racing
  // within the same instant; without this, reviewing an hour later would
  // quietly overwrite a colleague's verdict and the first one would vanish
  // from everything except the audit log.
  if (existing.out_of_fence_status !== 'pending') {
    return NextResponse.json<ApiResponse>(
      { success: false, error: `This was already ${existing.out_of_fence_status}` },
      { status: 409 },
    );
  }

  // Compare-and-set on the CURRENT status, so two admins opening the list at
  // once cannot both record a verdict and have the later one win silently.
  const updated = await query(
    `UPDATE attendance
        SET out_of_fence_status = ?,
            out_of_fence_reviewed_by = ?,
            out_of_fence_reviewed_at = UTC_TIMESTAMP(),
            out_of_fence_review_notes = ?
      WHERE id = ? AND out_of_fence_status = ?`,
    [nextStatus, auth.id, review_notes ?? null, attendanceId, existing.out_of_fence_status],
  );
  if ((updated as unknown as { affectedRows: number }).affectedRows === 0) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Somebody else reviewed this a moment ago — reload the list' },
      { status: 409 },
    );
  }

  await insertAuditLog({
    action: action === 'approve' ? 'off_site_clock_in_approved' : 'off_site_clock_in_rejected',
    entity: 'attendance',
    entity_id: attendanceId,
    performed_by: auth.id,
    details: {
      employee_id: existing.employee_id,
      emp_id: existing.emp_id,
      reason: existing.out_of_fence_reason,
      review_notes: review_notes ?? null,
      // Stated outright in the log, because it is the thing most likely to be
      // misremembered later: rejecting did not remove anybody's hours.
      attendance_unchanged: true,
    },
    ip_address: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  });

  return NextResponse.json<ApiResponse<{ attendance_id: number; status: string }>>({
    success: true,
    data: { attendance_id: attendanceId, status: nextStatus },
    message:
      action === 'approve'
        ? 'Marked as approved. Their attendance was already counted and is unchanged.'
        : 'Marked as disputed. Their attendance still stands — edit the record itself to change their hours.',
  });
}

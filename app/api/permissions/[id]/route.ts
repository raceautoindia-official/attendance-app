import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { getClientIp } from '@/lib/attendance';
import { PERMISSION_MAX_MINUTES_PER_MONTH } from '@/lib/constants';
import {
  canReviewEmployee,
  formatMinutes,
  getMonthlyUsage,
  hasPermissionTable,
  missingPermissionTableError,
} from '@/lib/permissions';
import type { ApiResponse, PermissionRequest } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

const ReviewSchema = z.object({
  // approve / reject — admin. cancel — the employee withdrawing their own.
  action: z.enum(['approve', 'reject', 'cancel']),
  review_notes: z.string().max(500).nullable().optional(),
});

function fail(error: string, status: number) {
  return NextResponse.json<ApiResponse>({ success: false, error }, { status });
}

async function loadRequest(id: number) {
  return queryOne<PermissionRequest>(
    `SELECT pr.*, DATE_FORMAT(pr.permission_date, '%Y-%m-%d') AS permission_date,
            e.name AS employee_name, e.emp_id AS employee_emp_id,
            r.name AS reviewed_by_name
     FROM permission_requests pr
     JOIN employees e ON e.id = pr.employee_id
     LEFT JOIN employees r ON r.id = pr.reviewed_by
     WHERE pr.id = ?`,
    [id],
  );
}

// ---------------------------------------------------------------------------
// PATCH /api/permissions/[id] — approve / reject (manager, super_admin)
//                               cancel (the employee who applied)
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest, context: Params) {
  const auth = await requireAuth(request, ['employee', 'manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  if (!(await hasPermissionTable())) {
    return fail(missingPermissionTableError(), 503);
  }

  const { id } = await context.params;
  const requestId = parseInt(id, 10);
  if (Number.isNaN(requestId)) return fail('Invalid ID', 400);

  let body: unknown;
  try { body = await request.json(); }
  catch { return fail('Invalid JSON body', 400); }

  const parsed = ReviewSchema.safeParse(body);
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? 'Validation error', 400);
  }
  const { action, review_notes } = parsed.data;

  const existing = await loadRequest(requestId);
  if (!existing) return fail('Permission request not found', 404);

  if (existing.status !== 'pending') {
    return fail(`This request is already ${existing.status}`, 409);
  }

  // --- Cancellation: only the employee who owns the request ------------------
  if (action === 'cancel') {
    const isOwner = existing.employee_id === auth.id;
    const canAdminCancel =
      auth.role !== 'employee' && (await canReviewEmployee(auth, existing.employee_id));
    if (!isOwner && !canAdminCancel) {
      return fail('Access denied', 403);
    }

    // The status guard makes this a compare-and-set: if a concurrent review
    // already moved the row off 'pending', no rows change and this caller must
    // be told so rather than reporting a success that never happened.
    const cancelResult = await query(
      `UPDATE permission_requests
       SET status = 'cancelled', reviewed_by = ?, reviewed_at = NOW(), review_notes = ?
       WHERE id = ? AND status = 'pending'`,
      [auth.id, review_notes ?? null, requestId],
    );
    if ((cancelResult as unknown as { affectedRows: number }).affectedRows === 0) {
      const current = await loadRequest(requestId);
      return fail(`This request is already ${current?.status ?? 'reviewed'}`, 409);
    }

    await insertAuditLog({
      action: 'permission_cancelled',
      entity: 'permission_request',
      entity_id: requestId,
      performed_by: auth.id,
      details: {
        employee_id: existing.employee_id,
        permission_date: existing.permission_date,
        minutes: Number(existing.minutes),
      },
      ip_address: getClientIp(request),
    });

    return NextResponse.json<ApiResponse<PermissionRequest>>({
      success: true,
      message: 'Permission request cancelled',
      data: (await loadRequest(requestId))!,
    });
  }

  // --- Approval / rejection: admins only, never on your own request ----------
  if (auth.role === 'employee') return fail('Insufficient permissions', 403);
  if (!(await canReviewEmployee(auth, existing.employee_id))) {
    return fail(
      existing.employee_id === auth.id
        ? 'You cannot approve your own permission request'
        : 'Access denied: not in your team',
      403,
    );
  }

  // On-duty is a working assignment, not time off — it never draws on the
  // monthly entitlement, so a full day of it must remain approvable.
  if (action === 'approve' && existing.request_type !== 'on_duty') {
    // Re-check the monthly entitlement against already-APPROVED minutes only,
    // so a queue of pending requests can't be approved past the limit.
    const { used } = await getMonthlyUsage(
      existing.employee_id,
      existing.permission_date,
      requestId,
    );
    const minutes = Number(existing.minutes);
    if (used + minutes > PERMISSION_MAX_MINUTES_PER_MONTH) {
      return fail(
        `Approving this would exceed the monthly limit of ${formatMinutes(PERMISSION_MAX_MINUTES_PER_MONTH)} — ${formatMinutes(used)} already approved for ${existing.permission_date.slice(0, 7)}`,
        409,
      );
    }
  }

  const newStatus = action === 'approve' ? 'approved' : 'rejected';
  // Compare-and-set on 'pending'. Two admins reviewing the same request at the
  // same moment would otherwise BOTH be told they succeeded while only one
  // verdict was stored — the second admin would walk away believing they had
  // rejected something that is now approved.
  const reviewResult = await query(
    `UPDATE permission_requests
     SET status = ?, reviewed_by = ?, reviewed_at = NOW(), review_notes = ?
     WHERE id = ? AND status = 'pending'`,
    [newStatus, auth.id, review_notes ?? null, requestId],
  );
  if ((reviewResult as unknown as { affectedRows: number }).affectedRows === 0) {
    const current = await loadRequest(requestId);
    return fail(
      `Already ${current?.status ?? 'reviewed'}${current?.reviewed_by_name ? ` by ${current.reviewed_by_name}` : ''}`,
      409,
    );
  }

  await insertAuditLog({
    action: newStatus === 'approved' ? 'permission_approved' : 'permission_rejected',
    entity: 'permission_request',
    entity_id: requestId,
    performed_by: auth.id,
    details: {
      employee_id: existing.employee_id,
      permission_date: existing.permission_date,
      start_time: existing.start_time,
      end_time: existing.end_time,
      minutes: Number(existing.minutes),
      review_notes: review_notes ?? null,
    },
    ip_address: getClientIp(request),
  });

  return NextResponse.json<ApiResponse<PermissionRequest>>({
    success: true,
    message: `Permission ${newStatus}`,
    data: (await loadRequest(requestId))!,
  });
}

// ---------------------------------------------------------------------------
// DELETE /api/permissions/[id]
// The employee may delete their own request while it is still pending;
// a super admin may delete any record outright.
// ---------------------------------------------------------------------------

export async function DELETE(request: NextRequest, context: Params) {
  const auth = await requireAuth(request, ['employee', 'manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  if (!(await hasPermissionTable())) {
    return fail(missingPermissionTableError(), 503);
  }

  const { id } = await context.params;
  const requestId = parseInt(id, 10);
  if (Number.isNaN(requestId)) return fail('Invalid ID', 400);

  const existing = await loadRequest(requestId);
  if (!existing) return fail('Permission request not found', 404);

  const isOwnPending = existing.employee_id === auth.id && existing.status === 'pending';
  if (!isOwnPending && auth.role !== 'super_admin') {
    return fail(
      existing.employee_id === auth.id
        ? 'Only pending requests can be withdrawn — ask an admin to change an approved one'
        : 'Access denied',
      403,
    );
  }

  await query('DELETE FROM permission_requests WHERE id = ?', [requestId]);

  await insertAuditLog({
    action: 'permission_deleted',
    entity: 'permission_request',
    entity_id: requestId,
    performed_by: auth.id,
    details: {
      employee_id: existing.employee_id,
      permission_date: existing.permission_date,
      minutes: Number(existing.minutes),
      status: existing.status,
    },
    ip_address: getClientIp(request),
  });

  return NextResponse.json<ApiResponse>({ success: true, message: 'Permission request deleted' });
}

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth';
import { queryOne } from '@/lib/db';
import {
  approveRequest, cancelRequest, getRequest, rejectRequest,
} from '@/lib/regularisation';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// PATCH /api/regularisations/[id]  { action: 'approve' | 'reject' | 'cancel' }
//
// Approving APPLIES the correction, so it needs the same authority as editing
// the attendance row directly — manager (own reports only) or super_admin.
// Cancelling is withdrawing your own request, so the employee may do it.
// ---------------------------------------------------------------------------

const Schema = z.object({
  action: z.enum(['approve', 'reject', 'cancel']),
  notes: z.string().max(500).nullable().optional(),
});

type Params = { params: Promise<{ id: string }> };

function ipOf(request: NextRequest): string | null {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? request.headers.get('x-real-ip') ?? null;
}

export async function PATCH(request: NextRequest, context: Params) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const { id: idStr } = await context.params;
  const id = parseInt(idStr, 10);
  if (Number.isNaN(id)) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid ID' }, { status: 400 });
  }

  let body: unknown;
  try { body = await request.json(); }
  catch {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' },
      { status: 400 },
    );
  }

  const existing = await getRequest(id);
  if (!existing) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'No such request' }, { status: 404 });
  }

  const { action, notes } = parsed.data;

  if (action === 'cancel') {
    // Your own, or a reviewer withdrawing one on somebody's behalf.
    const isReviewer = auth.role === 'manager' || auth.role === 'super_admin';
    if (existing.employee_id !== auth.id && existing.requested_by !== auth.id && !isReviewer) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'You can only withdraw your own request.' }, { status: 403 },
      );
    }
  } else {
    if (auth.role !== 'manager' && auth.role !== 'super_admin') {
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'Only a manager or administrator can decide a request.' },
        { status: 403 },
      );
    }
    // Nobody decides their own request, whatever their role. Approving your own
    // correction is editing your own attendance with extra steps.
    if (existing.employee_id === auth.id) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'You cannot decide a request about your own attendance.' },
        { status: 403 },
      );
    }
    if (auth.role === 'manager') {
      const own = await queryOne<{ id: number }>(
        `SELECT id FROM employees WHERE id = ? AND manager_id = ?`, [existing.employee_id, auth.id],
      );
      if (!own) {
        return NextResponse.json<ApiResponse>(
          { success: false, error: 'That employee is not one of your reports.' }, { status: 403 },
        );
      }
    }
  }

  try {
    const updated = action === 'approve'
      ? await approveRequest({ id, reviewedBy: auth.id, notes: notes ?? null, ip: ipOf(request) })
      : action === 'reject'
        ? await rejectRequest({ id, reviewedBy: auth.id, notes: notes ?? '', ip: ipOf(request) })
        : await cancelRequest({ id, by: auth.id, ip: ipOf(request) });

    return NextResponse.json<ApiResponse<{ request: typeof updated }>>({
      success: true, data: { request: updated },
    });
  } catch (err) {
    const message = (err as Error).message;
    const status = /closed on/i.test(message) ? 409 : 400;
    return NextResponse.json<ApiResponse>({ success: false, error: message }, { status });
  }
}

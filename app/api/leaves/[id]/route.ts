import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import type { ApiResponse, LeaveRecord } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

// DELETE /api/leaves/[id] — manager | super_admin
export async function DELETE(request: NextRequest, context: Params) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const { id } = await context.params;
  const leaveId = parseInt(id, 10);
  if (isNaN(leaveId)) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid ID' }, { status: 400 });
  }

  const existing = await queryOne<LeaveRecord>(
    'SELECT * FROM leave_records WHERE id = ?',
    [leaveId],
  );
  if (!existing) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Leave record not found' },
      { status: 404 },
    );
  }

  // Company-wide holiday records (employee_id IS NULL) — super_admin only
  if (existing.employee_id === null) {
    if (auth.role !== 'super_admin') {
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'Only super_admin can delete company-wide holiday records' },
        { status: 403 },
      );
    }
  } else if (auth.role === 'manager') {
    // Manager can only delete leaves for their own team members
    const emp = await queryOne<{ manager_id: number | null }>(
      'SELECT manager_id FROM employees WHERE id = ?',
      [existing.employee_id],
    );
    if (!emp || emp.manager_id !== auth.id) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'Access denied: not in your team' },
        { status: 403 },
      );
    }
  }

  await query('DELETE FROM leave_records WHERE id = ?', [leaveId]);

  await insertAuditLog({
    action: 'leave_deleted',
    entity: 'attendance',
    entity_id: leaveId,
    performed_by: auth.id,
    details: {
      employee_id: existing.employee_id,
      leave_date: existing.leave_date,
      leave_type: existing.type,
    },
    ip_address: request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
  });

  return NextResponse.json<ApiResponse>({ success: true, message: 'Leave record deleted' });
}

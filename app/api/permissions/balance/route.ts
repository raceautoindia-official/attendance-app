import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { queryOne } from '@/lib/db';
import { getWorkDateIST } from '@/lib/attendance';
import {
  emptyBalance,
  getMonthlyBalance,
  hasPermissionTable,
} from '@/lib/permissions';
import type { ApiResponse, PermissionBalance } from '@/lib/types';

// ---------------------------------------------------------------------------
// GET /api/permissions/balance?month=YYYY-MM&employee_id=N
// The caller's own monthly permission entitlement, or a team member's when an
// admin asks for one.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['employee', 'manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);

  // Anchor date for the month whose balance we report.
  const monthParam = searchParams.get('month');
  const anchorDate = monthParam && /^\d{4}-\d{2}$/.test(monthParam)
    ? `${monthParam}-01`
    : getWorkDateIST();

  let employeeId = auth.id;
  const requested = searchParams.get('employee_id');
  if (requested) {
    const eid = parseInt(requested, 10);
    if (!Number.isNaN(eid) && eid !== auth.id) {
      if (auth.role === 'employee') {
        return NextResponse.json<ApiResponse>(
          { success: false, error: 'Access denied' },
          { status: 403 },
        );
      }
      if (auth.role === 'manager') {
        const emp = await queryOne<{ manager_id: number | null }>(
          'SELECT manager_id FROM employees WHERE id = ?',
          [eid],
        );
        if (emp?.manager_id !== auth.id) {
          return NextResponse.json<ApiResponse>(
            { success: false, error: 'Access denied: not in your team' },
            { status: 403 },
          );
        }
      }
      employeeId = eid;
    }
  }

  const balance = (await hasPermissionTable())
    ? await getMonthlyBalance(employeeId, anchorDate)
    : emptyBalance(anchorDate);

  return NextResponse.json<ApiResponse<PermissionBalance>>(
    { success: true, data: balance },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

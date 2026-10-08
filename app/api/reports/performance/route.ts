import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { queryOne } from '@/lib/db';
import { rankPerformance, scoreEmployee, type PerformanceReport, type PerformanceScore } from '@/lib/performance';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// GET /api/reports/performance
//
//   ?month=2026-09                   everybody, scored and ranked
//   ?month=2026-09&policy_id=3       only people on that policy
//   ?month=2026-09&employee_id=10    one person's score, in detail
//
// manager | super_admin, with a manager seeing only their own reports.
//
// It builds a full hours ledger per employee, so it is the slowest report in
// the app. That is deliberate: scoring somebody from a cheaper aggregate would
// mean the number on the leaderboard and the number on their statement could
// differ, and the leaderboard is the one people will argue about.
// ---------------------------------------------------------------------------

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const YM = /^\d{4}-\d{2}$/;

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const sp = new URL(request.url).searchParams;
  const month = sp.get('month');
  let fromDate = sp.get('from_date');
  let toDate = sp.get('to_date');

  if (month) {
    if (!YM.test(month)) {
      return NextResponse.json<ApiResponse>({ success: false, error: 'month must be YYYY-MM' }, { status: 400 });
    }
    const [y, m] = month.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    fromDate = `${month}-01`;
    toDate = `${month}-${String(last).padStart(2, '0')}`;
  }
  if (!fromDate || !toDate || !YMD.test(fromDate) || !YMD.test(toDate)) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Provide month=YYYY-MM, or from_date and to_date' }, { status: 400 },
    );
  }
  if (fromDate > toDate) [fromDate, toDate] = [toDate, fromDate];

  const span = (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000;
  if (span > 92) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Score a quarter at most — a ledger is built per employee.' },
      { status: 400 },
    );
  }

  // One employee, in detail.
  const employeeId = Number(sp.get('employee_id'));
  if (Number.isInteger(employeeId) && employeeId > 0) {
    if (auth.role === 'manager') {
      const own = await queryOne<{ id: number }>(
        `SELECT id FROM employees WHERE id = ? AND manager_id = ?`, [employeeId, auth.id],
      );
      if (!own) {
        return NextResponse.json<ApiResponse>(
          { success: false, error: 'That employee is not one of your reports.' }, { status: 403 },
        );
      }
    }
    const score = await scoreEmployee(employeeId, fromDate, toDate);
    if (!score) {
      return NextResponse.json<ApiResponse>({ success: false, error: 'No such employee.' }, { status: 404 });
    }
    return NextResponse.json<ApiResponse<{ score: PerformanceScore }>>({ success: true, data: { score } });
  }

  const policyId = Number(sp.get('policy_id'));
  const report = await rankPerformance({
    fromDate,
    toDate,
    policyId: Number.isInteger(policyId) && policyId > 0 ? policyId : null,
    managerId: auth.role === 'manager' ? auth.id : null,
  });

  return NextResponse.json<ApiResponse<PerformanceReport>>({ success: true, data: report });
}

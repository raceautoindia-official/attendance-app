import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { queryOne } from '@/lib/db';
import { buildComparison, type TrendComparison } from '@/lib/hoursTrend';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// GET /api/reports/hours-trend?employee_id=9&month=2026-09
//
// This period against the one before it, and against the employee's peers.
//
// Separate from /api/reports/hours-ledger on purpose: it runs the ledger for
// every peer, so it is the slow part of the page. Keeping it apart means the
// statement renders immediately and the comparison arrives when it arrives.
//
// Same manager scoping as the ledger.
// ---------------------------------------------------------------------------

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const YM = /^\d{4}-\d{2}$/;

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const sp = new URL(request.url).searchParams;
  const employeeId = Number(sp.get('employee_id'));
  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'employee_id is required' }, { status: 400 },
    );
  }

  const month = sp.get('month');
  let fromDate = sp.get('from_date');
  let toDate = sp.get('to_date');
  if (month) {
    if (!YM.test(month)) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'month must be YYYY-MM' }, { status: 400 },
      );
    }
    const [y, m] = month.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    fromDate = `${month}-01`;
    toDate = `${month}-${String(last).padStart(2, '0')}`;
  }
  if (!fromDate || !toDate || !YMD.test(fromDate) || !YMD.test(toDate)) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Provide month=YYYY-MM, or from_date and to_date' },
      { status: 400 },
    );
  }
  if (fromDate > toDate) [fromDate, toDate] = [toDate, fromDate];

  // It builds a ledger per peer, twice over for the previous period, so a long
  // range would be a lot of work for a comparison nobody reads.
  const span = (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000;
  if (span > 62) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Compare a period of two months or less.' },
      { status: 400 },
    );
  }

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

  const comparison = await buildComparison(employeeId, fromDate, toDate);
  if (!comparison) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'No such employee.' }, { status: 404 });
  }
  return NextResponse.json<ApiResponse<TrendComparison>>({ success: true, data: comparison });
}

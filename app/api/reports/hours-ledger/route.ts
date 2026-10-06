import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { buildHoursLedger } from '@/lib/hoursLedger';
import { queryOne } from '@/lib/db';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// GET /api/reports/hours-ledger — manager | super_admin
//
// One employee, one period, day by day, with the shortage stated.
//
//   ?employee_id=9&month=2026-09          whole calendar month
//   ?employee_id=9&from_date=…&to_date=…  any range
//
// `month` is a convenience for the month dropdown; the explicit range still
// works exactly as it does everywhere else in the app, so nothing that already
// passes from_date/to_date has to change.
//
// A manager sees only their own reports — the same rule as /api/reports/summary.
// ---------------------------------------------------------------------------

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const YM = /^\d{4}-\d{2}$/;

/** First and last day of a YYYY-MM, as YYYY-MM-DD. */
function monthBounds(month: string): { from: string; to: string } | null {
  if (!YM.test(month)) return null;
  const [y, m] = month.split('-').map(Number);
  if (m < 1 || m > 12) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);

  const employeeId = Number(searchParams.get('employee_id'));
  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'employee_id is required' },
      { status: 400 },
    );
  }

  const month = searchParams.get('month');
  let fromDate = searchParams.get('from_date');
  let toDate = searchParams.get('to_date');

  if (month) {
    const bounds = monthBounds(month);
    if (!bounds) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'month must be YYYY-MM' },
        { status: 400 },
      );
    }
    fromDate = bounds.from;
    toDate = bounds.to;
  }

  if (!fromDate || !toDate || !YMD.test(fromDate) || !YMD.test(toDate)) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Provide month=YYYY-MM, or from_date and to_date as YYYY-MM-DD' },
      { status: 400 },
    );
  }
  if (fromDate > toDate) [fromDate, toDate] = [toDate, fromDate];

  // 400 days is the ledger's own walk cap; refuse rather than silently truncate.
  const span = (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000;
  if (span > 399) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Period is too long — 400 days maximum.' },
      { status: 400 },
    );
  }

  // A manager may only read their own reports. Checked before the ledger runs,
  // so an out-of-scope id cannot be probed through response timing.
  if (auth.role === 'manager') {
    const own = await queryOne<{ id: number }>(
      `SELECT id FROM employees WHERE id = ? AND manager_id = ?`,
      [employeeId, auth.id],
    );
    if (!own) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'That employee is not one of your reports.' },
        { status: 403 },
      );
    }
  }

  const ledger = await buildHoursLedger({ employeeId, fromDate, toDate });
  if (!ledger) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'No such employee.' },
      { status: 404 },
    );
  }

  return NextResponse.json<ApiResponse<typeof ledger>>({ success: true, data: ledger });
}

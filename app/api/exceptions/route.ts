import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { findExceptions, type ExceptionReport } from '@/lib/exceptions';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// GET /api/exceptions — what needs a decision in a period.
//
//   ?month=2026-09            whole calendar month
//   ?from_date=&to_date=      any range
//
// manager | super_admin. Read-only: it reads the same tables the reports read,
// so an exception and the report it came from can never disagree.
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
      { success: false, error: 'Provide month=YYYY-MM, or from_date and to_date as YYYY-MM-DD' },
      { status: 400 },
    );
  }
  if (fromDate > toDate) [fromDate, toDate] = [toDate, fromDate];

  const span = (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000;
  if (span > 92) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Period is too long — review a quarter at most.' },
      { status: 400 },
    );
  }

  const report = await findExceptions(fromDate, toDate);
  return NextResponse.json<ApiResponse<ExceptionReport>>({ success: true, data: report });
}

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getWorkDateIST } from '@/lib/attendance';
import { expectedButMissing } from '@/lib/markAbsent';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// GET /api/attendance/absent-today?date=YYYY-MM-DD
//
// Who was expected today and has not clocked in.
//
// The Overview card used to count rows with status 'absent', but those rows are
// written by the end-of-day job for the day that has FINISHED — so the count
// read 0 all day, every day, which is what "absent missing" meant.
//
// It answers with the same rule the job applies (each shift's working days, the
// company weekly-off fallback for unscheduled staff, leave and holidays
// excluded). Re-deriving that in the browser would have been three chances to
// disagree with the thing that actually decides.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const param = request.nextUrl.searchParams.get('date');
  const workDate = /^\d{4}-\d{2}-\d{2}$/.test(param ?? '') ? (param as string) : getWorkDateIST();

  const missing = await expectedButMissing(workDate);

  return NextResponse.json<
    ApiResponse<{ work_date: string; count: number; employees: Array<{ id: number; name: string }> }>
  >(
    { success: true, data: { work_date: workDate, count: missing.length, employees: missing } },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

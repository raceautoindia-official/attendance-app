import { NextRequest, NextResponse } from 'next/server';
import { closeOpenSessions } from '@/lib/closeSessions';

// ---------------------------------------------------------------------------
// POST /api/cron/close-sessions
//
// Closes any session that was clocked in but never clocked out on a PREVIOUS
// day, crediting the standard 9-hour shift, so each day stands on its own.
//
// NOTE: This no longer needs an external scheduler — the app runs the same
// close at ~00:05 IST every day via the in-app scheduler (see
// instrumentation.ts + lib/scheduler/autoClockOut.ts). This endpoint remains
// for manual triggering and for verifying the behaviour.
//
// Test-only query knobs (still gated by x-cron-secret):
//   include_today=1        -> also close TODAY's still-open session(s)
//   test_employee_id=<id>  -> restrict to a single employee
// e.g. .../close-sessions?include_today=1&test_employee_id=10
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const secret = request.headers.get('x-cron-secret');
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const includeToday = searchParams.get('include_today') === '1';
  const testEmployeeId = searchParams.get('test_employee_id');

  const closed = await closeOpenSessions({
    includeToday,
    employeeId: testEmployeeId ? Number(testEmployeeId) : null,
  });

  const scope = includeToday ? 'today and previous day(s)' : 'previous day(s)';
  return NextResponse.json({
    success: true,
    message: `Auto-closed ${closed} open session(s) from ${scope}`,
    count: closed,
  });
}

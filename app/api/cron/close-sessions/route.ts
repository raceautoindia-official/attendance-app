import { NextRequest, NextResponse } from 'next/server';
import { query, insertAuditLog } from '@/lib/db';
import { getWorkDateIST, toMySQLDatetime } from '@/lib/attendance';
import { REQUIRED_SHIFT_MINUTES } from '@/lib/constants';

// ---------------------------------------------------------------------------
// POST /api/cron/close-sessions
//
// Runs just after the grace window ends (midnight IST) to close any session
// that was clocked in but never clocked out on a PREVIOUS day, so each day
// stands on its own and every morning starts fresh.
//
//   5 0 * * *  curl -X POST https://yourdomain.com/api/cron/close-sessions \
//     -H "x-cron-secret: YOUR_SECRET"
//
// A forgotten session is credited the standard required shift length
// (REQUIRED_SHIFT_MINUTES = 9 hours) for both general and flexible shifts.
// Flexible employees are still expected to clock out themselves; this is the
// fallback when they forget.
// ---------------------------------------------------------------------------

interface OpenSession {
  id: number;
  clock_in_utc: Date;
}

export async function POST(request: NextRequest) {
  const secret = request.headers.get('x-cron-secret');
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const today = getWorkDateIST();

  // --- Test-only knobs (still gated by x-cron-secret) -----------------------
  // The normal nightly run closes ONLY previous-day sessions (work_date < today)
  // for everyone. To verify the auto clock-out without waiting for midnight,
  // pass:
  //   include_today=1        -> also close TODAY's still-open session(s)
  //   test_employee_id=<id>  -> restrict to a single employee
  // e.g. .../close-sessions?include_today=1&test_employee_id=42
  const { searchParams } = new URL(request.url);
  const includeToday = searchParams.get('include_today') === '1';
  const testEmployeeId = searchParams.get('test_employee_id');

  const conditions = ['a.clock_out_utc IS NULL', 'a.clock_in_utc IS NOT NULL'];
  const params: (string | number)[] = [];
  // include_today widens the window to "today and earlier"; otherwise the
  // production behaviour of "previous days only" is preserved exactly.
  conditions.push(includeToday ? 'a.work_date <= ?' : 'a.work_date < ?');
  params.push(today);
  if (testEmployeeId) {
    conditions.push('a.employee_id = ?');
    params.push(Number(testEmployeeId));
  }

  const openSessions = await query<OpenSession>(
    `SELECT a.id, a.clock_in_utc
     FROM attendance a
     WHERE ${conditions.join(' AND ')}`,
    params,
  );

  let closed = 0;
  for (const session of openSessions) {
    const minutes = REQUIRED_SHIFT_MINUTES;
    const clockOut = new Date(new Date(session.clock_in_utc).getTime() + minutes * 60_000);

    // Guard on clock_out_utc IS NULL so a real clock-out always wins a race.
    await query(
      `UPDATE attendance
       SET clock_out_utc = ?,
           total_minutes = ?
       WHERE id = ? AND clock_out_utc IS NULL`,
      [toMySQLDatetime(clockOut), minutes, session.id],
    );
    closed++;
  }

  if (closed > 0) {
    await insertAuditLog({
      action: 'sessions_auto_closed',
      entity: 'attendance',
      performed_by: null,
      details: {
        count: closed,
        closed_before: today,
        include_today: includeToday,
        test_employee_id: testEmployeeId ? Number(testEmployeeId) : null,
      },
      ip_address: null,
    });
  }

  const scope = includeToday ? 'today and previous day(s)' : 'previous day(s)';
  return NextResponse.json({
    success: true,
    message: `Auto-closed ${closed} open session(s) from ${scope}`,
    count: closed,
  });
}

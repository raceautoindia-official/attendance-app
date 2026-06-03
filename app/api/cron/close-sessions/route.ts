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

  // Open sessions from previous days (clocked in, never clocked out).
  const openSessions = await query<OpenSession>(
    `SELECT a.id, a.clock_in_utc
     FROM attendance a
     WHERE a.clock_out_utc IS NULL
       AND a.clock_in_utc IS NOT NULL
       AND a.work_date < ?`,
    [today],
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
      details: { count: closed, closed_before: today },
      ip_address: null,
    });
  }

  return NextResponse.json({
    success: true,
    message: `Auto-closed ${closed} open session(s) from previous day(s)`,
    count: closed,
  });
}

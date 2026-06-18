import { NextRequest, NextResponse } from 'next/server';
import { getWorkDateIST } from '@/lib/attendance';
import { markAbsentees } from '@/lib/markAbsent';

// ---------------------------------------------------------------------------
// POST /api/cron/mark-absent
//
// Marks absent any employee who has a scheduled working day today but no
// attendance and no leave. NOTE: the app also does this automatically via the
// in-app scheduler (instrumentation.ts + lib/scheduler/autoClockOut.ts) for the
// PREVIOUS day after midnight — so no external crontab is required. This
// endpoint remains for manual triggering / verifying.
//
// Optional ?work_date=YYYY-MM-DD to target a specific day (defaults to today).
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  const secret = request.headers.get('x-cron-secret');
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const workDate = searchParams.get('work_date') ?? getWorkDateIST();

  const count = await markAbsentees(workDate);

  return NextResponse.json({
    success: true,
    message: `Marked ${count} employee(s) absent for ${workDate}`,
    count,
    work_date: workDate,
  });
}

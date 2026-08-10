import { NextRequest, NextResponse } from 'next/server';
import { runLiveTrackingMonitor } from '@/lib/liveTrackingMonitor';

// ---------------------------------------------------------------------------
// POST /api/cron/live-tracking-monitor
//
// Manual / external trigger for the live-tracking sweep. The same sweep also
// runs by itself on the in-app scheduler, so this endpoint is only needed to
// force a run — and it stays locked unless CRON_SECRET is set.
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  const secret = request.headers.get('x-cron-secret');
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const result = await runLiveTrackingMonitor();

  return NextResponse.json({
    success: true,
    message: result.message,
    count: result.count,
    alerts_sent: result.alertsSent,
    geofence_clockouts: result.geofenceClockouts,
  });
}

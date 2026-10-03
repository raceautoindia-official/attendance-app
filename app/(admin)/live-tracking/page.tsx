'use client';

import LiveTrackingPanel from '@/components/live/LiveTrackingPanel';

export default function LiveTrackingPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-800 dark:text-slate-200">Live Tracking</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Everyone clocked in right now, and whether their phone is reporting.
        </p>
      </div>
      <LiveTrackingPanel />
    </div>
  );
}

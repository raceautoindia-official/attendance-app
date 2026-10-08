'use client';

/**
 * /hours — kept only to forward to the page that replaced it.
 *
 * Working Hours and Reports answered the same question twice: both showed what
 * somebody was required to work against what they actually worked, each with
 * its own employee picker and its own date range to keep in step. They are now
 * one page, where a row in the company table opens that person's day-by-day
 * detail underneath it.
 *
 * The route stays because links to it are already out there — the Performance
 * page, Month Review, and whatever somebody has bookmarked. It carries the
 * parameters across rather than dropping the reader on an unfiltered page,
 * which would technically work and would still have lost them their place.
 */

import { Suspense, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import Card from '@/components/ui/Card';
import Spinner from '@/components/ui/Spinner';

export default function HoursPage() {
  return (
    <Suspense fallback={<Card><div className="flex justify-center py-10"><Spinner /></div></Card>}>
      <Forward />
    </Suspense>
  );
}

function Forward() {
  const searchParams = useSearchParams();

  useEffect(() => {
    const qs = new URLSearchParams();
    for (const key of ['employee', 'month', 'from_date', 'to_date']) {
      const v = searchParams.get(key);
      if (v) qs.set(key, v);
    }
    // replace(), not assign(): the Back button should return to wherever the
    // reader came from, not to this page, which would bounce them forward again.
    window.location.replace(`/reports${qs.toString() ? `?${qs}` : ''}`);
  }, [searchParams]);

  return (
    <Card>
      <div className="flex items-center justify-center gap-3 py-10">
        <Spinner />
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Working Hours is now part of Reports — taking you there.
        </p>
      </div>
    </Card>
  );
}

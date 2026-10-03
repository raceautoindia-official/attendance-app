// Next.js instrumentation hook: register() runs once when a server instance
// starts (Node runtime only). It starts the in-app daily scheduler, which
// settles each work day when that day ends (07:00 IST) — crediting the hours
// actually worked — and marks the no-shows absent. Running it in-process means
// no external VPS crontab is required; the /api/cron/* endpoints are only a
// manual override and stay locked unless CRON_SECRET is set.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startAutoClockOutScheduler } = await import('@/lib/scheduler/autoClockOut');
  startAutoClockOutScheduler();
}

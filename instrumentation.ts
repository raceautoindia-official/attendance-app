// Next.js instrumentation hook: register() runs once when a server instance
// starts (Node runtime only). We use it to start the in-app daily scheduler
// that auto-closes (auto clock-out) forgotten sessions at midnight IST, so the
// 9-hour automatic clock-out runs without any external VPS crontab.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startAutoClockOutScheduler } = await import('@/lib/scheduler/autoClockOut');
  startAutoClockOutScheduler();
}

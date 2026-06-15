import { closeOpenSessions } from '@/lib/closeSessions';

// ---------------------------------------------------------------------------
// In-app scheduler for the automatic 9-hour clock-out.
//
// Anyone still clocked in from a PREVIOUS day (i.e. they never clocked out by
// midnight) is auto clock-out with 9 hours credited.
//
// Design: instead of one fragile "fire at midnight" timer — which silently
// misses if the server restarts near midnight or that single run hits a
// transient DB error — we run a SELF-HEALING periodic sweep every 15 minutes,
// plus an immediate catch-up on startup. closeOpenSessions() only ever acts on
// sessions with work_date < today, so:
//   • during the day it is a harmless no-op for everyone still working,
//   • a forgotten session is closed within 15 min of midnight IST at the latest,
//   • any missed/failed run is automatically retried on the next sweep.
// The UPDATE guards on clock_out_utc IS NULL, so it is fully idempotent and
// safe to run as often as we like and across multiple server instances.
// ---------------------------------------------------------------------------

const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes
const STARTUP_DELAY_MS = 10_000;          // brief delay so startup isn't blocked

let started = false;

async function runAutoClockOut(label: string): Promise<void> {
  try {
    const closed = await closeOpenSessions(); // previous-day open sessions → 9h
    if (closed > 0) {
      console.log(`[auto-clock-out] ${label}: closed ${closed} open session(s)`);
    }
  } catch (err) {
    console.error(`[auto-clock-out] ${label}: failed (will retry next sweep)`, err);
  }
}

export function startAutoClockOutScheduler(): void {
  if (started) return; // guard against double-registration in one process
  started = true;

  // Catch-up shortly after startup (covers a server that was down at midnight).
  setTimeout(() => { void runAutoClockOut('startup catch-up'); }, STARTUP_DELAY_MS);

  // Self-healing periodic sweep.
  setInterval(() => { void runAutoClockOut('sweep'); }, SWEEP_INTERVAL_MS);
}

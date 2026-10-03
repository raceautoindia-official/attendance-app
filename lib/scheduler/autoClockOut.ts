import { closeOpenSessions } from '@/lib/closeSessions';
import { markAbsentees } from '@/lib/markAbsent';
import { markSundayHolidays } from '@/lib/markSundayHolidays';
import { runLiveTrackingMonitor } from '@/lib/liveTrackingMonitor';
import { getWorkDateIST, previousWorkDate } from '@/lib/attendance';

// ---------------------------------------------------------------------------
// In-app end-of-day scheduler. On a self-healing 15-minute sweep (plus a
// startup catch-up) it does two things, both idempotent and safe to re-run:
//
//   1. SETTLE THE DAY — anyone still clocked in from a work day that has now
//      ENDED (07:00 IST, not midnight) is clocked out and credited the hours
//      actually worked up to that boundary — never a nominal shift length
//      (closeOpenSessions, acts only on work_date < the current work date).
//      Anyone still on site at the boundary gets a fresh session so the new day
//      starts counting without them clocking in again.
//
//   2. MARK ABSENT — employees who had a scheduled working day on the work day
//      that just finished, but no attendance and no leave, are marked absent.
//
//   3. LIVE MONITOR — on its own faster timer: auto clock-out for anyone whose
//      presence inside their fence has not been confirmed for the grace period,
//      and admin alerts for a phone that has gone silent (runMonitor).
//
// Using a periodic sweep instead of one fragile "fire at 07:00" timer means a
// server restart near the boundary or a transient DB error can't make it miss —
// the next sweep self-heals. No external crontab is required.
// ---------------------------------------------------------------------------

const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // end-of-day work: every 15 minutes
const STARTUP_DELAY_MS = 10_000;          // brief delay so startup isn't blocked

/**
 * The live-tracking sweep runs on its OWN, faster timer.
 *
 * Its job is timely detection — someone who left the site, or a phone that
 * stopped reporting — so tying it to the 15-minute end-of-day cadence would add
 * up to a quarter of an hour of avoidable delay on top of the grace period it
 * already applies. The queries are small and indexed, so a short interval is
 * cheap. Override with LIVE_MONITOR_INTERVAL_MIN.
 */
const MONITOR_INTERVAL_MS =
  Math.max(1, Number(process.env.LIVE_MONITOR_INTERVAL_MIN) || 3) * 60 * 1000;

let started = false;

/**
 * What actually went wrong, in one line.
 *
 * `console.error('...', err)` on a production build prints "Error:" and a stack
 * through minified chunk names — no message, no SQL, nothing to act on. A
 * database error carries everything worth knowing on its own properties, so
 * pull those out by name instead of trusting the default formatting.
 */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & {
    code?: string; errno?: number; sqlState?: string; sqlMessage?: string; sql?: string;
  };
  const parts = [
    e.sqlMessage || e.message || e.name || 'no message',
    e.code ? `code=${e.code}` : '',
    e.errno ? `errno=${e.errno}` : '',
    e.sqlState ? `sqlState=${e.sqlState}` : '',
    // Enough of the statement to identify it, not enough to fill the log.
    e.sql ? `sql=${e.sql.replace(/\s+/g, ' ').slice(0, 300)}` : '',
  ].filter(Boolean);
  return parts.join(' | ');
}

/**
 * Auto clock-out for being away from the work site, plus alerts for a phone
 * that has gone silent.
 *
 * This used to run ONLY from /api/cron/live-tracking-monitor, so on a server
 * with no external crontab — or with CRON_SECRET unset, where that endpoint
 * rejects every request — it never ran at all, and nobody was ever clocked out
 * for leaving the fence. It runs in-process now, like the end-of-day jobs.
 */
async function runMonitor(label: string): Promise<void> {
  try {
    const r = await runLiveTrackingMonitor();
    // A sweep that finds nothing used to print nothing, which makes "running
    // and idle" indistinguishable from "not running at all" — the exact doubt
    // this job has already caused once. LIVE_MONITOR_VERBOSE logs every sweep
    // so it can be watched during setup; off by default, because a line every
    // couple of minutes would bury everything else.
    if (r.geofenceClockouts > 0 || r.count > 0) {
      console.log(
        `[live-monitor] ${label}: ${r.geofenceClockouts} away-from-site clock-out(s), ` +
        `${r.count} stale session(s), ${r.alertsSent} alert(s)`,
      );
    } else if (process.env.LIVE_MONITOR_VERBOSE === 'true') {
      console.log(`[live-monitor] ${label}: ran, nothing to do`);
    }
  } catch (err) {
    console.error(`[live-monitor] ${label}: failed (will retry next sweep) — ${describeError(err)}`);
  }
}

function lastCompletedWorkDate(): string {
  // The work day that has now finished. Work days end at WORK_DAY_START_HOUR,
  // so this must come off the work-date helper — subtracting 24h from the wall
  // clock would name the wrong day for the hours either side of the boundary.
  return previousWorkDate(getWorkDateIST());
}

async function runEndOfDay(label: string): Promise<void> {
  try {
    const closed = await closeOpenSessions(); // previous-day open sessions → 9h
    if (closed > 0) {
      console.log(`[end-of-day] ${label}: auto clocked-out ${closed} session(s)`);
    } else if (label === 'startup catch-up') {
      // Proof the very first run reached the database and found the backlog
      // empty — the one sweep worth confirming even when it does nothing.
      console.log(`[end-of-day] ${label}: no sessions left open from an earlier day`);
    }
  } catch (err) {
    console.error(`[end-of-day] ${label}: auto clock-out failed (will retry next sweep) — ${describeError(err)}`);
  }

  try {
    const yesterday = lastCompletedWorkDate();
    const absent = await markAbsentees(yesterday); // mark yesterday's no-shows absent
    if (absent > 0) {
      console.log(`[end-of-day] ${label}: marked ${absent} employee(s) absent for ${yesterday}`);
    }
  } catch (err) {
    console.error(`[end-of-day] ${label}: mark-absent failed (will retry next sweep) — ${describeError(err)}`);
  }

  try {
    // Sunday = company holiday. Cover today (so a current Sunday shows up right
    // away) and yesterday (catch-up if the server was down on Sunday).
    const holidays =
      (await markSundayHolidays(getWorkDateIST())) + (await markSundayHolidays(lastCompletedWorkDate()));
    if (holidays > 0) {
      console.log(`[end-of-day] ${label}: marked ${holidays} Sunday holiday row(s)`);
    }
  } catch (err) {
    console.error(`[end-of-day] ${label}: Sunday-holiday marking failed (will retry next sweep) — ${describeError(err)}`);
  }
}

export function startAutoClockOutScheduler(): void {
  if (started) return; // guard against double-registration in one process
  started = true;

  // Say so, once. A sweep with nothing to do prints nothing, so "running and
  // idle" and "never started" look identical in pm2 — and the difference is
  // whether anyone still clocked in from yesterday gets settled tonight or
  // walks into "Already clocked in" tomorrow morning. One line at boot is what
  // makes that answerable from the logs instead of from the database.
  console.log(
    `[end-of-day] scheduler started — settling sweep every ${SWEEP_INTERVAL_MS / 60000} min, ` +
    `live monitor every ${MONITOR_INTERVAL_MS / 60000} min`,
  );

  // Catch-up shortly after startup (covers a server that was down at midnight).
  setTimeout(() => { void runEndOfDay('startup catch-up'); }, STARTUP_DELAY_MS);
  setTimeout(() => { void runMonitor('startup'); }, STARTUP_DELAY_MS);

  // Self-healing periodic sweeps. Two timers, because the two jobs answer very
  // different questions: "has a day finished?" and "is someone still on site?"
  setInterval(() => { void runEndOfDay('sweep'); }, SWEEP_INTERVAL_MS);
  setInterval(() => { void runMonitor('sweep'); }, MONITOR_INTERVAL_MS);
}

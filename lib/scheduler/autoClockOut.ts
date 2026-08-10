import { closeOpenSessions } from '@/lib/closeSessions';
import { markAbsentees } from '@/lib/markAbsent';
import { markSundayHolidays } from '@/lib/markSundayHolidays';
import { getWorkDateIST, previousWorkDate } from '@/lib/attendance';
import { formatInTimeZone } from 'date-fns-tz';
import { TIMEZONE } from '@/lib/constants';

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
// Using a periodic sweep instead of one fragile "fire at 07:00" timer means a
// server restart near the boundary or a transient DB error can't make it miss —
// the next sweep self-heals. No external crontab is required.
// ---------------------------------------------------------------------------

const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes
const STARTUP_DELAY_MS = 10_000;          // brief delay so startup isn't blocked

let started = false;

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
    }
  } catch (err) {
    console.error(`[end-of-day] ${label}: auto clock-out failed (will retry next sweep)`, err);
  }

  try {
    const yesterday = lastCompletedWorkDate();
    const absent = await markAbsentees(yesterday); // mark yesterday's no-shows absent
    if (absent > 0) {
      console.log(`[end-of-day] ${label}: marked ${absent} employee(s) absent for ${yesterday}`);
    }
  } catch (err) {
    console.error(`[end-of-day] ${label}: mark-absent failed (will retry next sweep)`, err);
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
    console.error(`[end-of-day] ${label}: Sunday-holiday marking failed (will retry next sweep)`, err);
  }
}

export function startAutoClockOutScheduler(): void {
  if (started) return; // guard against double-registration in one process
  started = true;

  // Catch-up shortly after startup (covers a server that was down at midnight).
  setTimeout(() => { void runEndOfDay('startup catch-up'); }, STARTUP_DELAY_MS);

  // Self-healing periodic sweep.
  setInterval(() => { void runEndOfDay('sweep'); }, SWEEP_INTERVAL_MS);
}

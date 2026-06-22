import { closeOpenSessions } from '@/lib/closeSessions';
import { markAbsentees } from '@/lib/markAbsent';
import { markSundayHolidays } from '@/lib/markSundayHolidays';
import { getWorkDateIST } from '@/lib/attendance';
import { formatInTimeZone } from 'date-fns-tz';
import { TIMEZONE } from '@/lib/constants';

// ---------------------------------------------------------------------------
// In-app end-of-day scheduler. On a self-healing 15-minute sweep (plus a
// startup catch-up) it does two things, both idempotent and safe to re-run:
//
//   1. AUTO CLOCK-OUT — anyone still clocked in from a PREVIOUS day (never
//      clocked out by midnight) is auto clock-out with 9 hours credited
//      (closeOpenSessions, acts only on work_date < today).
//
//   2. MARK ABSENT — employees who had a scheduled working day YESTERDAY but no
//      attendance and no leave are marked absent (markAbsentees for the
//      previous IST day, which is now complete).
//
// Using a periodic sweep instead of one fragile "fire at midnight" timer means
// a server restart near midnight or a transient DB error can't make it miss —
// the next sweep self-heals. No external crontab is required.
// ---------------------------------------------------------------------------

const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes
const STARTUP_DELAY_MS = 10_000;          // brief delay so startup isn't blocked

let started = false;

function previousWorkDate(): string {
  // Yesterday's IST calendar date (the day that is now complete).
  return formatInTimeZone(new Date(Date.now() - 24 * 60 * 60 * 1000), TIMEZONE, 'yyyy-MM-dd');
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
    const yesterday = previousWorkDate();
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
      (await markSundayHolidays(getWorkDateIST())) + (await markSundayHolidays(previousWorkDate()));
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

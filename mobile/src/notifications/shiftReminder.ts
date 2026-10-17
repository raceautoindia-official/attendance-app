import * as Notifications from 'expo-notifications';
import { scheduleAt, CHANNELS } from './setup';

// The foreground handler used to be set here, as a side effect of importing
// this module — so whether a notification appeared while the app was open
// depended on whether an unrelated feature happened to be imported. It belongs
// to the app, not to shift reminders; see setup.ts.

// Fixed identifiers, one per offset: rescheduling REPLACES the previous set
// rather than adding to it. They used to be random and remembered in the state
// file, so the dashboard and a background auto clock-in scheduling at the same
// moment — or one lost state write — left a set nobody could cancel, and
// "please clock out" arrived several times over.
const ID_PREFIX = 'shift-end-reminder-';
const TITLES = ['Shift time is over', 'Reminder: please clock out'];
// Always 9 working hours counted from the actual clock-in — the reminder is
// personal to each employee's own start time, never a fixed wall-clock time.
const SHIFT_HOURS = 9;
// First alert exactly when the 9 hours complete, then nags if they still
// haven't clocked out.
const REMINDER_OFFSETS_MIN = [0, 30, 60];

/** Scheduling and cancelling run one at a time, so a clock-out's cancel cannot
 *  be undone by a schedule that was still in flight. */
let queue: Promise<void> = Promise.resolve();
function serially(task: () => Promise<void>): Promise<void> {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

/**
 * Every pending shift reminder the OS holds, this version's or an older one's.
 *
 * Never cancelAllScheduledNotificationsAsync(). Cancelling everything is how
 * one feature's cleanup silently disables another's — the morning clock-in
 * reminders are scheduled by a different module, and a clock-out would have
 * swept them all away.
 */
async function cancelEveryShiftReminder(): Promise<void> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  for (const req of scheduled) {
    if (req.identifier.startsWith(ID_PREFIX) || TITLES.includes(req.content.title ?? '')) {
      await Notifications.cancelScheduledNotificationAsync(req.identifier).catch(() => {});
    }
  }
}

/** Schedules OS-level "shift over, please clock out" notifications exactly
 *  9 hours after the given clock-in. They fire on the lock screen /
 *  notification bar even with the app closed. Nothing is shown at clock-in
 *  itself; re-scheduling replaces any previous set. */
export async function scheduleShiftEndReminders(clockInUtc: string): Promise<void> {
  const clockInMs = new Date(clockInUtc).getTime();
  if (Number.isNaN(clockInMs)) return;

  return serially(async () => {
    try {
      await cancelEveryShiftReminder();

      const shiftEndMs = clockInMs + SHIFT_HOURS * 60 * 60 * 1000;
      for (const offsetMin of REMINDER_OFFSETS_MIN) {
        const fireAt = new Date(shiftEndMs + offsetMin * 60 * 1000);
        if (fireAt.getTime() <= Date.now() + 5000) continue; // already past
        await scheduleAt(
          CHANNELS.shift,
          fireAt,
          offsetMin === 0 ? TITLES[0] : TITLES[1],
          offsetMin === 0
            ? `Your ${SHIFT_HOURS}-hour shift is complete. Open Attendance and clock out.`
            : 'You are still clocked in. Open Attendance and clock out.',
          `${ID_PREFIX}${offsetMin}`,
        );
      }
    } catch {
      // a missing reminder must never break the clock-in that scheduled it
    }
  });
}

/** Cancels this module's pending shift reminders (on clock-out and on logout). */
export async function cancelShiftEndReminders(): Promise<void> {
  return serially(async () => {
    try {
      await cancelEveryShiftReminder();
    } catch {
      // never block clock-out/logout on notification cleanup
    }
  });
}

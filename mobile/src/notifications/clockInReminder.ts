import * as Notifications from 'expo-notifications';
import { getState, setState } from '../storage/state';
import { scheduleAt, ensureNotificationPermission, CHANNELS } from './setup';

// ---------------------------------------------------------------------------
// "You have not clocked in yet" — a local notification each working morning.
//
// Local, not pushed from the server: there is no push infrastructure here, and
// a reminder to open the app is exactly the thing that must work when the app
// is closed. The OS holds the schedule, so it fires on the lock screen whether
// or not the app is running.
//
// Scheduled as a set of DATED notifications for the coming days rather than one
// repeating daily trigger, because a daily trigger cannot be told "not today, I
// already clocked in" — it would nag every morning regardless. Dated ones can
// be cancelled individually the moment somebody clocks in, and re-armed on the
// next app open.
//
// ONE PER MORNING, BY CONSTRUCTION. Each reminder's identifier is the date it
// fires on, and scheduling an identifier that already exists replaces it. This
// used to keep random identifiers in the state file and cancel only those — so
// two arming calls racing on app open (the dashboard effect fires again when
// the roster arrives), or a state-file write lost to a background task, left
// whole sets behind that nothing remembered and nothing could cancel. Each day
// stacked another set on the coming mornings, and people got the same "Good
// morning" fifteen times at 09:00.
//
// Cancelling therefore asks the OS what is actually scheduled instead of
// trusting what we think we scheduled, and matches the title too — so the
// orphans earlier versions left behind are swept up on this version's first run.
// ---------------------------------------------------------------------------

/** Identifier prefix; the local date it fires on follows. */
const ID_PREFIX = 'clockin-reminder-';
const TITLE = 'Good morning — clock in';
/** The morning this set was armed for, so re-arming is cheap. */
const ARMED_KEY = 'clockin_reminder_armed_for';

/** Local wall-clock hour and minute of the reminder. */
export const REMINDER_HOUR = 9;
export const REMINDER_MINUTE = 0;
/** How many days ahead to arm. Covers a weekend away from the app. */
const DAYS_AHEAD = 7;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Arming and cancelling run one at a time. Otherwise a clock-in's cancel can
 * finish while an arm is still scheduling, and the arm puts the reminders
 * straight back for a day that has already started.
 */
let queue: Promise<void> = Promise.resolve();
function serially(task: () => Promise<void>): Promise<void> {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

function localYmd(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Every pending morning reminder the OS holds, this version's or an older one's.
 *
 * Never cancelAllScheduledNotificationsAsync — the shift-end reminders are
 * scheduled by another module, and wiping everything is how one feature's
 * cleanup silently disables another's.
 */
async function cancelEveryMorningReminder(): Promise<void> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  for (const req of scheduled) {
    if (req.identifier.startsWith(ID_PREFIX) || req.content.title === TITLE) {
      await Notifications.cancelScheduledNotificationAsync(req.identifier).catch(() => {});
    }
  }
}

/** Drops the pending morning reminders (on clock-in and on logout). */
export async function cancelClockInReminders(): Promise<void> {
  return serially(async () => {
    try {
      await cancelEveryMorningReminder();
      await setState(ARMED_KEY, '');
    } catch {
      // never block clock-in or logout on notification cleanup
    }
  });
}

/**
 * Drops only THIS morning's reminder — for a day already started somewhere the
 * phone did not see (the website, the geofence). The coming mornings stay
 * armed: cancelling those too would leave someone who does not open the app
 * for a few days with no reminders at all.
 */
export async function cancelTodaysClockInReminder(): Promise<void> {
  return serially(async () => {
    await Notifications.cancelScheduledNotificationAsync(`${ID_PREFIX}${localYmd(new Date())}`).catch(() => {});
  });
}

/**
 * Arms a reminder for each of the coming working mornings.
 *
 * @param workingDays  The employee's own working weekdays ("Mon".."Sat"). No
 *                     nagging on their day off. Null means every day, which is
 *                     the honest default when the phone has no roster to read.
 */
export async function scheduleClockInReminders(
  workingDays: string[] | null,
): Promise<void> {
  return serially(async () => {
    try {
      // Asked for once at app start (see setup.ts). If it was refused there is
      // nothing to schedule — the OS would drop these silently.
      if (!(await ensureNotificationPermission(false))) return;

      // Already armed for the same morning — nothing to redo. Without this, every
      // dashboard refresh would cancel and re-create seven notifications. The
      // "v2" makes the first run after the update do the full sweep below even
      // on a morning an older version had already armed.
      const now = new Date();
      const stamp = `v2|${now.toDateString()}|${(workingDays ?? []).join(',')}`;
      if ((await getState(ARMED_KEY)) === stamp) return;

      await cancelEveryMorningReminder();

      for (let i = 0; i < DAYS_AHEAD; i++) {
        const fireAt = new Date(now);
        fireAt.setDate(fireAt.getDate() + i);
        fireAt.setHours(REMINDER_HOUR, REMINDER_MINUTE, 0, 0);
        // Today's has already gone by — start from tomorrow.
        if (fireAt.getTime() <= Date.now() + 60_000) continue;
        if (workingDays && !workingDays.includes(WEEKDAYS[fireAt.getDay()])) continue;

        await scheduleAt(
          CHANNELS.attendance,
          fireAt,
          TITLE,
          'Open Attendance and clock in for today.',
          `${ID_PREFIX}${localYmd(fireAt)}`,
        );
      }

      await setState(ARMED_KEY, stamp);
    } catch {
      // a missing reminder must never break the screen that scheduled it
    }
  });
}

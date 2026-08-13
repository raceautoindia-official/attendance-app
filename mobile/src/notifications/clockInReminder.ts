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
// ---------------------------------------------------------------------------

/** Identifiers we scheduled, so cancelling touches only ours. */
const IDS_KEY = 'clockin_reminder_ids';
/** The morning this set was armed for, so re-arming is cheap and idempotent. */
const ARMED_KEY = 'clockin_reminder_armed_for';

/** Local wall-clock hour and minute of the reminder. */
export const REMINDER_HOUR = 9;
export const REMINDER_MINUTE = 0;
/** How many days ahead to arm. Covers a weekend away from the app. */
const DAYS_AHEAD = 7;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

async function storedIds(): Promise<string[]> {
  try {
    const raw = await getState(IDS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * Drops the pending morning reminders.
 *
 * Cancels BY IDENTIFIER rather than calling cancelAllScheduledNotificationsAsync
 * — the shift-end reminders are scheduled by another module, and wiping
 * everything is how one feature's cleanup silently disables another's.
 */
export async function cancelClockInReminders(): Promise<void> {
  try {
    for (const id of await storedIds()) {
      await Notifications.cancelScheduledNotificationAsync(id).catch(() => {});
    }
    await setState(IDS_KEY, '[]');
    await setState(ARMED_KEY, '');
  } catch {
    // never block clock-in or logout on notification cleanup
  }
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
  try {
    // Asked for once at app start (see setup.ts). If it was refused there is
    // nothing to schedule — the OS would drop these silently.
    if (!(await ensureNotificationPermission(false))) return;

    // Already armed for the same morning — nothing to redo. Without this, every
    // dashboard refresh would cancel and re-create seven notifications.
    const now = new Date();
    const stamp = `${now.toDateString()}|${(workingDays ?? []).join(',')}`;
    if ((await getState(ARMED_KEY)) === stamp) return;

    await cancelClockInReminders();

    const ids: string[] = [];
    for (let i = 0; i < DAYS_AHEAD; i++) {
      const fireAt = new Date(now);
      fireAt.setDate(fireAt.getDate() + i);
      fireAt.setHours(REMINDER_HOUR, REMINDER_MINUTE, 0, 0);
      // Today's has already gone by — start from tomorrow.
      if (fireAt.getTime() <= Date.now() + 60_000) continue;
      if (workingDays && !workingDays.includes(WEEKDAYS[fireAt.getDay()])) continue;

      const id = await scheduleAt(
        CHANNELS.attendance,
        fireAt,
        'Good morning — clock in',
        'Open Attendance and clock in for today.',
      );
      if (id) ids.push(id);
    }

    await setState(IDS_KEY, JSON.stringify(ids));
    await setState(ARMED_KEY, stamp);
  } catch {
    // a missing reminder must never break the screen that scheduled it
  }
}

import * as Notifications from 'expo-notifications';
import { getState, setState } from '../storage/state';
import { scheduleAt, CHANNELS } from './setup';

// The foreground handler used to be set here, as a side effect of importing
// this module — so whether a notification appeared while the app was open
// depended on whether an unrelated feature happened to be imported. It belongs
// to the app, not to shift reminders; see setup.ts.
/** Identifiers this module scheduled, so cancelling touches only its own. */
const IDS_KEY = 'shift_reminder_ids';
// Always 9 working hours counted from the actual clock-in — the reminder is
// personal to each employee's own start time, never a fixed wall-clock time.
const SHIFT_HOURS = 9;
// First alert exactly when the 9 hours complete, then nags if they still
// haven't clocked out.
const REMINDER_OFFSETS_MIN = [0, 30, 60];

/** Schedules OS-level "shift over, please clock out" notifications exactly
 *  9 hours after the given clock-in. They fire on the lock screen /
 *  notification bar even with the app closed. Nothing is shown at clock-in
 *  itself; re-scheduling replaces any previous set. */
export async function scheduleShiftEndReminders(clockInUtc: string): Promise<void> {
  const clockInMs = new Date(clockInUtc).getTime();
  if (Number.isNaN(clockInMs)) return;

  await cancelShiftEndReminders();

  const shiftEndMs = clockInMs + SHIFT_HOURS * 60 * 60 * 1000;

  const ids: string[] = [];
  for (const offsetMin of REMINDER_OFFSETS_MIN) {
    const fireAt = new Date(shiftEndMs + offsetMin * 60 * 1000);
    if (fireAt.getTime() <= Date.now() + 5000) continue; // already past
    const id = await scheduleAt(
      CHANNELS.shift,
      fireAt,
      offsetMin === 0 ? 'Shift time is over' : 'Reminder: please clock out',
      offsetMin === 0
        ? `Your ${SHIFT_HOURS}-hour shift is complete. Open Attendance and clock out.`
        : 'You are still clocked in. Open Attendance and clock out.',
    );
    if (id) ids.push(id);
  }
  await setState(IDS_KEY, JSON.stringify(ids));
}

/**
 * Cancels this module's pending shift reminders (on clock-out and on logout).
 *
 * BY IDENTIFIER, not cancelAllScheduledNotificationsAsync(). Cancelling
 * everything is how one feature's cleanup silently disables another's — the
 * morning clock-in reminders are scheduled by a different module, and a
 * clock-out would have swept them all away.
 */
export async function cancelShiftEndReminders(): Promise<void> {
  try {
    const raw = await getState(IDS_KEY);
    const ids = raw ? (JSON.parse(raw) as string[]) : [];
    for (const id of ids) {
      await Notifications.cancelScheduledNotificationAsync(id).catch(() => {});
    }
    await setState(IDS_KEY, '[]');
  } catch {
    // never block clock-out/logout on notification cleanup
  }
}

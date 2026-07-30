import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

// Show shift reminders even while the app is open in the foreground.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const CHANNEL_ID = 'shift-reminders';
// Always 9 working hours counted from the actual clock-in — the reminder is
// personal to each employee's own start time, never a fixed wall-clock time.
const SHIFT_HOURS = 9;
// First alert exactly when the 9 hours complete, then nags if they still
// haven't clocked out.
const REMINDER_OFFSETS_MIN = [0, 30, 60];

async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Shift reminders',
    importance: Notifications.AndroidImportance.HIGH,
    sound: 'default',
    vibrationPattern: [0, 400, 200, 400],
  });
}

/** Schedules OS-level "shift over, please clock out" notifications exactly
 *  9 hours after the given clock-in. They fire on the lock screen /
 *  notification bar even with the app closed. Nothing is shown at clock-in
 *  itself; re-scheduling replaces any previous set. */
export async function scheduleShiftEndReminders(clockInUtc: string): Promise<void> {
  const clockInMs = new Date(clockInUtc).getTime();
  if (Number.isNaN(clockInMs)) return;

  await cancelShiftEndReminders();
  const perm = await Notifications.requestPermissionsAsync();
  if (!perm.granted) return;
  await ensureChannel();

  const shiftEndMs = clockInMs + SHIFT_HOURS * 60 * 60 * 1000;

  for (const offsetMin of REMINDER_OFFSETS_MIN) {
    const fireAt = new Date(shiftEndMs + offsetMin * 60 * 1000);
    if (fireAt.getTime() <= Date.now() + 5000) continue; // already past
    await Notifications.scheduleNotificationAsync({
      content: {
        title: offsetMin === 0 ? 'Shift time is over' : 'Reminder: please clock out',
        body:
          offsetMin === 0
            ? `Your ${SHIFT_HOURS}-hour shift is complete. Open Attendance and clock out.`
            : 'You are still clocked in. Open Attendance and clock out.',
        sound: 'default',
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: fireAt,
        channelId: CHANNEL_ID,
      },
    });
  }
}

/** Cancels all pending shift reminders (on clock-out and on logout). */
export async function cancelShiftEndReminders(): Promise<void> {
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
  } catch {
    // never block clock-out/logout on notification cleanup
  }
}

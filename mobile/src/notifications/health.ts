import * as Notifications from 'expo-notifications';
import * as IntentLauncher from 'expo-intent-launcher';
import { Platform } from 'react-native';
import { getState, setState } from '../storage/state';
import { CHANNELS } from './setup';
import { PACKAGE, openAppSettings } from '../location/batteryOptimization';

// ---------------------------------------------------------------------------
// Can this phone actually show the app's notifications — and on time?
//
// Every notification here is local, so when they "don't work" the phone is
// almost always refusing them, and nothing said so: the permission prompt is
// asked once at launch, and an employee who tapped "Don't allow" (or later
// switched one category off) simply never heard another reminder, warning or
// approval, with no sign anywhere that anything was wrong.
// ---------------------------------------------------------------------------

export type NotificationProblem = 'blocked' | 'some_off' | null;

export async function checkNotificationHealth(): Promise<{ problem: NotificationProblem; canAsk: boolean }> {
  try {
    const perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) return { problem: 'blocked', canAsk: perm.canAskAgain };
    if (Platform.OS === 'android') {
      // Android also lets one category be switched off on its own.
      const ours = new Set<string>(Object.values(CHANNELS));
      const channels = await Notifications.getNotificationChannelsAsync();
      if (channels.some(c => ours.has(c.id) && c.importance === Notifications.AndroidImportance.NONE)) {
        return { problem: 'some_off', canAsk: false };
      }
    }
  } catch {
    // Unknown is not a problem to show.
  }
  return { problem: null, canAsk: false };
}

/** Ask again when Android still allows it, otherwise open the app's
 *  notification settings, where the switch is. */
export async function fixNotifications(canAsk: boolean): Promise<void> {
  if (canAsk) {
    const asked = await Notifications.requestPermissionsAsync().catch(() => null);
    if (asked?.granted) return;
  }
  if (Platform.OS !== 'android') return;
  try {
    await IntentLauncher.startActivityAsync('android.settings.APP_NOTIFICATION_SETTINGS', {
      extra: { 'android.provider.extra.APP_PACKAGE': PACKAGE },
    });
  } catch {
    await openAppSettings();
  }
}

// ---------------------------------------------------------------------------
// On-time reminders.
//
// The morning and end-of-shift reminders are alarms held by Android. Without
// permission for EXACT alarms, Android 12+ treats them as inexact and may
// deliver one up to an hour late — "please clock out" arriving after somebody
// has gone home. The permission is declared in the manifest, which Android 12
// and 13 grant at install; Android 14+ leaves it OFF until the user allows
// "Alarms & reminders" for the app, and offers no way to read it from here —
// so 14+ is asked once, with the reason.
// ---------------------------------------------------------------------------

const EXACT_ALARM_ASKED_KEY = 'exact_alarm_asked';

export async function shouldAskForExactAlarms(): Promise<boolean> {
  if (Platform.OS !== 'android' || typeof Platform.Version !== 'number' || Platform.Version < 34) {
    return false;
  }
  return (await getState(EXACT_ALARM_ASKED_KEY)) !== '1';
}

export async function markExactAlarmsAsked(): Promise<void> {
  await setState(EXACT_ALARM_ASKED_KEY, '1');
}

export async function openExactAlarmSettings(): Promise<void> {
  await markExactAlarmsAsked();
  try {
    await IntentLauncher.startActivityAsync('android.settings.REQUEST_SCHEDULE_EXACT_ALARM', {
      data: `package:${PACKAGE}`,
    });
  } catch {
    await openAppSettings();
  }
}

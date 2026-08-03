import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { apiFetch, ApiError } from '../api/client';

// Location-off enforcement: while an employee is clocked in, the phone checks
// that location services and permissions are still on — every ~15 minutes in
// the background (survives the app being closed) and every minute while the
// app is open. Each failed check raises a warning notification, spaced at
// least STRIKE_SPACING_MIN apart; on the 4th strike the employee is clocked
// out automatically. Location coming back at any point resets the count.

export const LOCATION_WATCH_TASK = 'attendance-location-watch';

const STRIKE_COUNT_KEY = 'loc_off_strikes';
const STRIKE_TS_KEY = 'loc_off_last_strike_ms';
const MAX_STRIKES = 4;
const STRIKE_SPACING_MIN = 10;
const CHANNEL_ID = 'location-warnings';

interface TodayResponse {
  attendance: { clock_in_utc: string | null; clock_out_utc: string | null } | null;
}

async function notify(title: string, body: string): Promise<void> {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: 'Location warnings',
        importance: Notifications.AndroidImportance.HIGH,
        sound: 'default',
        vibrationPattern: [0, 400, 200, 400],
      });
    }
    await Notifications.scheduleNotificationAsync({
      content: { title, body, sound: 'default' },
      trigger: Platform.OS === 'android' ? { channelId: CHANNEL_ID } : null,
    });
  } catch {
    // never fail enforcement over a notification
  }
}

async function locationHealthy(): Promise<boolean> {
  const services = await Location.hasServicesEnabledAsync().catch(() => false);
  if (!services) return false;
  const fg = await Location.getForegroundPermissionsAsync().catch(() => null);
  const bg = await Location.getBackgroundPermissionsAsync().catch(() => null);
  return !!fg?.granted && !!bg?.granted;
}

export async function resetLocationStrikes(): Promise<void> {
  await SecureStore.setItemAsync(STRIKE_COUNT_KEY, '0').catch(() => {});
}

/** One enforcement check. Safe to call from anywhere, any frequency — the
 *  10-minute spacing between strikes is enforced internally. */
export async function checkLocationAndWarn(): Promise<void> {
  // Only relevant during an open shift; server state is authoritative.
  let today: TodayResponse;
  try {
    today = await apiFetch<TodayResponse>('/api/attendance/today');
  } catch {
    return; // offline — the admin-side signal-lost alerts cover this
  }
  const att = today.attendance;
  const onShift = !!att?.clock_in_utc && !att?.clock_out_utc;
  if (!onShift) {
    await resetLocationStrikes();
    return;
  }

  if (await locationHealthy()) {
    await resetLocationStrikes();
    return;
  }

  const strikes = Number(await SecureStore.getItemAsync(STRIKE_COUNT_KEY).catch(() => '0')) || 0;

  if (strikes >= MAX_STRIKES) {
    // Final strike already reached but the clock-out failed (e.g. no network
    // at that moment) — keep retrying on every check until it lands.
    await autoClockOut();
    return;
  }

  // Space warnings out no matter how often callers poll.
  const lastMs = Number(await SecureStore.getItemAsync(STRIKE_TS_KEY).catch(() => '0')) || 0;
  if (Date.now() - lastMs < STRIKE_SPACING_MIN * 60_000) return;

  const next = strikes + 1;
  await SecureStore.setItemAsync(STRIKE_COUNT_KEY, String(next)).catch(() => {});
  await SecureStore.setItemAsync(STRIKE_TS_KEY, String(Date.now())).catch(() => {});

  if (next >= MAX_STRIKES) {
    await autoClockOut();
  } else {
    await notify(
      `Turn location on — warning ${next} of ${MAX_STRIKES}`,
      'Location is off during your shift. Turn it back on now, or you will be clocked out automatically.',
    );
  }
}

async function autoClockOut(): Promise<void> {
  // Location is off, so a fresh fix is impossible; send the last known
  // position if the OS still has one, otherwise no coordinates.
  const last = await Location.getLastKnownPositionAsync({ maxAge: 60 * 60_000 }).catch(() => null);
  try {
    await apiFetch('/api/attendance/clock-out', {
      method: 'POST',
      body: {
        latitude: last?.coords.latitude ?? null,
        longitude: last?.coords.longitude ?? null,
        auto: true,
        reason: 'location_off',
      },
    });
    await resetLocationStrikes();
    await notify(
      'Clocked out — location was off',
      'Location stayed off after 4 warnings, so your attendance has been clocked out automatically.',
    );
  } catch (err) {
    if (err instanceof ApiError) {
      // 404 = already clocked out elsewhere — nothing left to enforce.
      await resetLocationStrikes().catch(() => {});
    }
    // Network errors: keep the counter at MAX so the next check retries the
    // clock-out instead of restarting the warning cycle.
  }
}

TaskManager.defineTask(LOCATION_WATCH_TASK, async () => {
  await checkLocationAndWarn();
  return BackgroundTask.BackgroundTaskResult.Success;
});

/** Registers the periodic background check (min ~15 minutes on Android). */
export async function startLocationWatch(): Promise<void> {
  try {
    await BackgroundTask.registerTaskAsync(LOCATION_WATCH_TASK, {
      minimumInterval: 15, // minutes
    });
  } catch {
    // Background tasks unavailable (rare) — the in-app 60s check still runs.
  }
}

export async function stopLocationWatch(): Promise<void> {
  try {
    await BackgroundTask.unregisterTaskAsync(LOCATION_WATCH_TASK);
  } catch {
    // not registered — fine
  }
  await resetLocationStrikes();
}

import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { getState, setState } from '../storage/state';
import { Platform } from 'react-native';
import { apiFetch, ApiError } from '../api/client';
import { stopBackgroundTracking } from './tracking';
import { reconcileGeofenceAttendance } from './geofenceAuto';
import { cancelShiftEndReminders } from '../notifications/shiftReminder';
import { decideLocationAction, MAX_WARNINGS } from './locationWatchPolicy';
import { notifyPermissionUpdates, PermissionUpdate } from '../notifications/permissionUpdates';

// Location-off enforcement: while an employee is clocked in, the phone checks
// that location services and permissions are still on — every ~15 minutes in
// the background (survives the app being closed) and every minute while the
// app is open.
//
// Each failed check raises ONE warning notification, spaced at least
// STRIKE_SPACING_MIN apart. After all MAX_WARNINGS warnings have been sent —
// and the same grace period has passed since the last of them — the employee
// is clocked out automatically and told why. So the sequence is:
//
//   warning 1 of 4 → 2 of 4 → 3 of 4 → 4 of 4 (final) → automatic clock-out
//
// Location coming back at any point resets the count to zero.

export const LOCATION_WATCH_TASK = 'attendance-location-watch';

const STRIKE_COUNT_KEY = 'loc_off_strikes';
const STRIKE_TS_KEY = 'loc_off_last_strike_ms';
const CHANNEL_ID = 'location-warnings';

interface TodayResponse {
  attendance: { clock_in_utc: string | null; clock_out_utc: string | null } | null;
  permission_updates?: PermissionUpdate[];
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
  await setState(STRIKE_COUNT_KEY, '0');
}

/** One enforcement check. Safe to call from anywhere, any frequency — the
 *  10-minute spacing between strikes is enforced internally. */
export async function checkLocationAndWarn(): Promise<void> {
  // Piggyback: repair any missed geofence auto clock-in/out (no-op unless
  // plant auto mode is active). Runs on the same background cadence.
  await reconcileGeofenceAttendance().catch(() => {});

  // Only relevant during an open shift; server state is authoritative.
  let today: TodayResponse;
  try {
    today = await apiFetch<TodayResponse>('/api/attendance/today');
  } catch (err) {
    // Logged out → stop watching entirely; offline → retry next check.
    if (err instanceof ApiError && err.status === 401) await stopLocationWatch();
    return;
  }
  // Piggyback again: announce permission decisions on the background cadence
  // too, so the verdict reaches a phone that stays in a pocket all day.
  void notifyPermissionUpdates(today.permission_updates);
  const att = today.attendance;
  const onShift = !!att?.clock_in_utc && !att?.clock_out_utc;
  if (!onShift) {
    await resetLocationStrikes();
    return;
  }

  // Admin-disabled tracking = no location obligation → stand down entirely
  // (also unregisters a watch left over from before the admin disabled it).
  try {
    const status = await apiFetch<{ enabled: boolean }>('/api/live-tracking/status');
    if (status.enabled === false) {
      await stopLocationWatch();
      return;
    }
  } catch {
    // status unavailable — err on the side of not punishing the employee
    return;
  }

  if (await locationHealthy()) {
    await resetLocationStrikes();
    return;
  }

  const warnings = Number(await getState(STRIKE_COUNT_KEY)) || 0;
  const lastMs = Number(await getState(STRIKE_TS_KEY)) || 0;

  const decision = decideLocationAction(warnings, lastMs, Date.now());

  if (decision.action === 'wait') return;

  if (decision.action === 'clock_out') {
    // A failed clock-out leaves the counter and timestamp untouched, so the
    // next check retries immediately rather than restarting the warnings.
    await autoClockOut();
    return;
  }

  await setState(STRIKE_COUNT_KEY, String(decision.warningNumber));
  await setState(STRIKE_TS_KEY, String(Date.now()));

  await notify(
    `Turn location on — warning ${decision.warningNumber} of ${MAX_WARNINGS}${decision.isFinal ? ' (final)' : ''}`,
    decision.isFinal
      ? 'Final warning. Location is still off — turn it back on now or you will be clocked out automatically.'
      : 'Location is off during your shift. Turn it back on now, or you will be clocked out automatically.',
  );
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
    // The tracking service can't self-stop via ping-403 with location off
    // (no fixes → no pings), so kill it and the shift reminders here.
    await stopBackgroundTracking().catch(() => {});
    await cancelShiftEndReminders().catch(() => {});
    await notify(
      'Clocked out — location was off',
      'Location stayed off after 4 warnings, so your attendance has been clocked out automatically.',
    );
  } catch (err) {
    // 4xx = the server understood and refused (404 already clocked out,
    // 401 logged out) — nothing left to enforce. 5xx and network errors keep
    // the counter at MAX so the next check retries the clock-out rather than
    // restarting the whole warning cycle.
    if (err instanceof ApiError && err.status < 500) {
      await resetLocationStrikes().catch(() => {});
      await stopBackgroundTracking().catch(() => {});
      await cancelShiftEndReminders().catch(() => {});
    }
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

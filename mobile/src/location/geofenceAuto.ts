import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { apiFetch, ApiError } from '../api/client';
import { startBackgroundTracking, stopBackgroundTracking } from './tracking';
import { scheduleShiftEndReminders, cancelShiftEndReminders } from '../notifications/shiftReminder';

// Automatic attendance for plant (multi-session) employees:
//   - the FIRST clock-in of the day is always manual;
//   - leaving the work site  → automatic clock-out;
//   - re-entering the site   → automatic clock-in (a new session, hours add up)
//     — but ONLY when the closure was the phone's own geofence clock-out. A
//     manual clock-out (phone or web), the server watchdog, or the midnight
//     auto-close means the day is over: re-entry must not reopen it.
//   - manual clock-out / logout / a fresh day stop the monitoring.
//
// Implemented with OS-level geofencing: an inner ENTER circle and an outer
// EXIT circle 150 m larger; the gap is hysteresis so boundary GPS jitter
// cannot flap attendance.

export const GEOFENCE_TASK = 'attendance-geofence-auto';

const INNER_ID = 'fence-inner';
const OUTER_ID = 'fence-outer';
const EXIT_MARGIN_M = 150;
const CHANNEL_ID = 'auto-attendance';

// Set when THIS device auto-clocked-out on exit; required for auto clock-in.
const AUTO_OUT_KEY = 'geofence_auto_out_pending';
// The fence being monitored — lets app-open/periodic reconciliation repair
// missed events (network blips during the actual geofence transition).
const FENCE_KEY = 'geofence_fence';

interface TodayResponse {
  attendance: {
    clock_in_utc: string | null;
    clock_out_utc: string | null;
  } | null;
  multi_session?: boolean;
}

interface Fence {
  latitude: number;
  longitude: number;
  radius: number; // inner radius, already floored at 200
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function notify(title: string, body: string): Promise<void> {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: 'Automatic attendance',
        importance: Notifications.AndroidImportance.HIGH,
        sound: 'default',
      });
    }
    await Notifications.scheduleNotificationAsync({
      content: { title, body, sound: 'default' },
      trigger: Platform.OS === 'android' ? { channelId: CHANNEL_ID } : null,
    });
  } catch {
    // never fail the attendance action over a notification
  }
}

async function storedFence(): Promise<Fence | null> {
  try {
    const raw = await SecureStore.getItemAsync(FENCE_KEY);
    return raw ? (JSON.parse(raw) as Fence) : null;
  } catch {
    return null;
  }
}

async function autoOutPending(): Promise<boolean> {
  return (await SecureStore.getItemAsync(AUTO_OUT_KEY).catch(() => null)) === '1';
}

/** Auto clock-out (site exit). Returns true when the day state changed. */
async function doAutoClockOut(coords: { latitude: number; longitude: number }): Promise<boolean> {
  try {
    await apiFetch('/api/attendance/clock-out', {
      method: 'POST',
      body: { ...coords, auto: true, reason: 'geofence_exit' },
    });
    await SecureStore.setItemAsync(AUTO_OUT_KEY, '1').catch(() => {});
    await stopBackgroundTracking();
    await cancelShiftEndReminders();
    await notify(
      'Auto clocked out',
      'You left the work site, so your attendance was clocked out. Re-entering will clock you in again.',
    );
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return true; // already closed elsewhere
    if (err instanceof ApiError && err.status === 401) await stopGeofenceAutoMode();
    return false; // network — reconciliation retries
  }
}

/** Auto clock-in (site re-entry after our own auto clock-out). */
async function doAutoClockIn(coords: { latitude: number; longitude: number }): Promise<boolean> {
  try {
    await apiFetch('/api/attendance/clock-in', {
      method: 'POST',
      body: { ...coords, auto: true },
    });
    await SecureStore.deleteItemAsync(AUTO_OUT_KEY).catch(() => {});
    await notify('Auto clocked in', 'Welcome back — you re-entered the work site and a new session was started.');
    // Reminders re-anchor to this new session; tracking restart is permitted
    // from a geofence event, and self-heals on next app open if the OS refuses.
    void scheduleShiftEndReminders(new Date().toISOString());
    try { await startBackgroundTracking(); } catch { /* resumes on app open */ }
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      await SecureStore.deleteItemAsync(AUTO_OUT_KEY).catch(() => {});
      return true; // already open
    }
    if (err instanceof ApiError && err.status === 401) await stopGeofenceAutoMode();
    return false; // 403 stale fix / network — reconciliation retries
  }
}

async function fetchToday(): Promise<TodayResponse | null> {
  try {
    return await apiFetch<TodayResponse>('/api/attendance/today');
  } catch (err) {
    // Logged out: nothing on this device may keep watching location.
    if (err instanceof ApiError && err.status === 401) await stopGeofenceAutoMode();
    return null;
  }
}

async function currentCoords(): Promise<{ latitude: number; longitude: number } | null> {
  try {
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
  } catch {
    return null;
  }
}

TaskManager.defineTask(GEOFENCE_TASK, async ({ data, error }) => {
  if (error || !data) return;
  const { eventType, region } = data as {
    eventType: Location.GeofencingEventType;
    region: Location.LocationRegion;
  };

  const today = await fetchToday();
  if (!today) return;

  // Fresh day / no clocked-in record → this monitoring is stale.
  if (!today.attendance?.clock_in_utc) {
    await stopGeofenceAutoMode();
    return;
  }

  const onShift = !today.attendance.clock_out_utc;
  const fence = await storedFence();
  const inner = fence?.radius ?? Math.max(Number(region.radius ?? 200) - EXIT_MARGIN_M, 200);
  const center = fence ?? { latitude: region.latitude, longitude: region.longitude, radius: inner };

  if (eventType === Location.GeofencingEventType.Exit && region.identifier === OUTER_ID && onShift) {
    const coords = await currentCoords();
    if (coords) {
      const dist = haversineMeters(coords.latitude, coords.longitude, center.latitude, center.longitude);
      if (dist <= inner) return; // jitter — still at the site
    }
    await doAutoClockOut(coords ?? { latitude: center.latitude, longitude: center.longitude });
    return;
  }

  if (eventType === Location.GeofencingEventType.Enter && region.identifier === INNER_ID && !onShift) {
    // Only reopen a day WE closed. Any other closure (manual, web, watchdog,
    // midnight) means the day is over — and monitoring can stand down.
    if (!(await autoOutPending())) {
      await stopGeofenceAutoMode();
      return;
    }
    if (today.multi_session !== true) return;
    const coords = await currentCoords();
    if (coords) {
      const dist = haversineMeters(coords.latitude, coords.longitude, center.latitude, center.longitude);
      if (dist > inner + 50) return; // not actually inside yet
    }
    await doAutoClockIn(coords ?? { latitude: center.latitude, longitude: center.longitude });
  }
});

/** Repairs missed transitions (network blip during the actual event):
 *  - still marked on-shift but physically far outside → clock out;
 *  - our auto clock-out pending, physically back inside → clock in.
 *  Called on app open and from the periodic location watch. Cheap no-op when
 *  auto mode isn't running. */
export async function reconcileGeofenceAttendance(): Promise<void> {
  const running = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false);
  if (!running) return;
  const fence = await storedFence();
  if (!fence) return;

  const today = await fetchToday();
  if (!today) return;
  if (!today.attendance?.clock_in_utc) {
    await stopGeofenceAutoMode();
    return;
  }

  const coords = await currentCoords();
  if (!coords) return;
  const dist = haversineMeters(coords.latitude, coords.longitude, fence.latitude, fence.longitude);
  const onShift = !today.attendance.clock_out_utc;

  if (onShift && dist > fence.radius + EXIT_MARGIN_M) {
    await doAutoClockOut(coords);
  } else if (!onShift && (await autoOutPending()) && today.multi_session === true && dist <= fence.radius) {
    await doAutoClockIn(coords);
  }
}

/** True while an auto clock-out by this device awaits the employee's return. */
export async function isAutoOutPending(): Promise<boolean> {
  return autoOutPending();
}

/** Starts (or refreshes) auto-attendance monitoring around the work site.
 *  Safe to call repeatedly; regions are replaced. */
export async function startGeofenceAutoMode(
  latitude: number,
  longitude: number,
  radiusMeters: number,
): Promise<boolean> {
  const fg = await Location.getForegroundPermissionsAsync().catch(() => null);
  const bg = await Location.getBackgroundPermissionsAsync().catch(() => null);
  if (!fg?.granted || !bg?.granted) return false;

  const inner = Math.max(Number(radiusMeters) || 200, 200);
  await SecureStore.setItemAsync(FENCE_KEY, JSON.stringify({ latitude, longitude, radius: inner })).catch(() => {});
  await Location.startGeofencingAsync(GEOFENCE_TASK, [
    { identifier: INNER_ID, latitude, longitude, radius: inner, notifyOnEnter: true, notifyOnExit: false },
    { identifier: OUTER_ID, latitude, longitude, radius: inner + EXIT_MARGIN_M, notifyOnEnter: false, notifyOnExit: true },
  ]);
  return true;
}

export async function stopGeofenceAutoMode(): Promise<void> {
  try {
    if (await Location.hasStartedGeofencingAsync(GEOFENCE_TASK)) {
      await Location.stopGeofencingAsync(GEOFENCE_TASK);
    }
  } catch {
    // not running — fine
  }
  await SecureStore.deleteItemAsync(AUTO_OUT_KEY).catch(() => {});
  await SecureStore.deleteItemAsync(FENCE_KEY).catch(() => {});
}

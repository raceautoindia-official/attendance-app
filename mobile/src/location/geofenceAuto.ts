import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { apiFetch, ApiError } from '../api/client';
import { startBackgroundTracking, stopBackgroundTracking } from './tracking';

// Automatic attendance for plant (multi-session) employees:
//   - the FIRST clock-in of the day is always manual;
//   - leaving the work site  → automatic clock-out;
//   - re-entering the site   → automatic clock-in (a new session, hours add up);
//   - a manual clock-out (or logout / day end) turns auto mode off.
//
// Implemented with OS-level geofencing: the phone watches two circles around
// the site — an inner one whose ENTER event clocks in, and a larger outer one
// whose EXIT event clocks out. The 150 m gap between them is hysteresis, so
// GPS jitter at the boundary cannot flap attendance on and off.

export const GEOFENCE_TASK = 'attendance-geofence-auto';

const INNER_ID = 'fence-inner';
const OUTER_ID = 'fence-outer';
const EXIT_MARGIN_M = 150;
const CHANNEL_ID = 'auto-attendance';

interface TodayResponse {
  attendance: {
    clock_in_utc: string | null;
    clock_out_utc: string | null;
  } | null;
  multi_session?: boolean;
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

// Fresh fix to sanity-check the OS event; returns null when no fix available
// (then we trust the OS — its geofence transitions are already conservative).
async function distanceFromFence(region: Location.LocationRegion): Promise<number | null> {
  try {
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return haversineMeters(
      pos.coords.latitude,
      pos.coords.longitude,
      region.latitude,
      region.longitude,
    );
  } catch {
    return null;
  }
}

async function currentCoords(): Promise<{ latitude: number; longitude: number }> {
  const last = await Location.getLastKnownPositionAsync({ maxAge: 120_000 }).catch(() => null);
  if (last) return { latitude: last.coords.latitude, longitude: last.coords.longitude };
  const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  return { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
}

TaskManager.defineTask(GEOFENCE_TASK, async ({ data, error }) => {
  if (error || !data) return;
  const { eventType, region } = data as {
    eventType: Location.GeofencingEventType;
    region: Location.LocationRegion;
  };

  let today: TodayResponse;
  try {
    today = await apiFetch<TodayResponse>('/api/attendance/today');
  } catch {
    return; // offline — the next transition retries
  }

  // No clocked-in day on record (fresh day after midnight auto-close, or the
  // account state changed) → this monitoring is stale, stop it.
  if (!today.attendance?.clock_in_utc) {
    await stopGeofenceAutoMode();
    return;
  }

  const onShift = !today.attendance.clock_out_utc;
  const innerRadius = Math.max(Number(region.radius ?? 200) - (region.identifier === OUTER_ID ? EXIT_MARGIN_M : 0), 200);

  // ---- left the site while clocked in → auto clock-out ---------------------
  if (eventType === Location.GeofencingEventType.Exit && region.identifier === OUTER_ID && onShift) {
    const dist = await distanceFromFence(region);
    if (dist !== null && dist <= innerRadius) return; // jitter — still at the site
    try {
      const coords = await currentCoords();
      await apiFetch('/api/attendance/clock-out', { method: 'POST', body: { ...coords, auto: true } });
      await stopBackgroundTracking();
      await notify('Auto clocked out', 'You left the work site, so your attendance was clocked out. Re-entering will clock you in again.');
    } catch {
      // 404 = already clocked out elsewhere; anything else retries on next event
    }
    return;
  }

  // ---- came back to the site after an earlier session → auto clock-in ------
  if (
    eventType === Location.GeofencingEventType.Enter &&
    region.identifier === INNER_ID &&
    !onShift &&
    today.multi_session === true
  ) {
    const dist = await distanceFromFence(region);
    if (dist !== null && dist > Number(region.radius ?? 200) + 50) return; // not actually inside yet
    try {
      const coords = await currentCoords();
      await apiFetch('/api/attendance/clock-in', { method: 'POST', body: { ...coords, auto: true } });
      await notify('Auto clocked in', 'Welcome back — you re-entered the work site and a new session was started.');
      // Android permits starting the tracking foreground service in response
      // to a geofencing event; if the OS refuses, tracking resumes when the
      // app is next opened.
      try { await startBackgroundTracking(); } catch { /* resumes on app open */ }
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.status === 403)) return;
    }
  }
});

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
}

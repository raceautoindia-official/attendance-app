import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { apiFetch, ApiError } from '../api/client';
import { startBackgroundTracking, stopBackgroundTracking } from './tracking';
import { scheduleShiftEndReminders, cancelShiftEndReminders } from '../notifications/shiftReminder';

// Automatic attendance around the work-site fence:
//   - the FIRST clock-in of the day is always manual;
//   - leaving the work site  → automatic clock-out, for ANY employee with a
//     fence, so nobody stays on the clock after walking off site;
//   - re-entering the site   → automatic clock-in (a new session, hours add up)
//     — but ONLY when the closure was the phone's own geofence clock-out. A
//     manual clock-out (phone or web), the server watchdog, or the midnight
//     auto-close means the day is over: re-entry must not reopen it.
//
//     Re-entry is attempted for EVERY employee. Reopening the day genuinely
//     requires allow_multiple_sessions — a single-session account gets a 409
//     from the server — but that refusal is now told to the employee rather
//     than skipped in silence. The silence was the worst outcome: we clocked
//     them out for stepping away, then did nothing at all when they came back.
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
    /**
     * The session was closed by the server's away-from-site watchdog rather
     * than by a person. Re-entry may re-open it; a manual or end-of-day
     * closure may not. Absent on an older server, where it reads as false and
     * behaviour falls back to "only a closure this phone performed".
     */
    auto_clocked_out?: boolean;
  } | null;
  multi_session?: boolean;
  /** Approved out-of-office duty covering right now, if any. */
  on_duty_now?: { start_time: string; end_time: string; reason: string | null } | null;
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
      // A 409 here means one of two very different things.
      //
      // "Attendance already completed for today" — the account is limited to a
      // single session, so returning to the site can never reopen the day. That
      // is the trap: we clocked them out when they stepped away, and they
      // cannot get back in. Silently giving up left them stranded outside their
      // own shift with no idea why, so say it plainly.
      if (/completed/i.test(err.message)) {
        await notify(
          'Back at the site — but today is already closed',
          'You were clocked out when you left, and your account allows only one clock-in per day. ' +
          'Ask your admin to enable multiple sessions for you.',
        );
        await stopGeofenceAutoMode();
        return true;
      }
      // Otherwise: already clocked in. Nothing to do.
      await SecureStore.deleteItemAsync(AUTO_OUT_KEY).catch(() => {});
      return true;
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
    // Approved out-of-office duty: the employee is meant to be away, so leaving
    // the fence is not the end of their day. Notify instead of clocking out.
    if (today.on_duty_now) {
      await notify(
        'On duty — still clocked in',
        'You have left the work site with approved on-duty, so your attendance stays open.',
      );
      return;
    }
    const coords = await currentCoords();
    if (coords) {
      const dist = haversineMeters(coords.latitude, coords.longitude, center.latitude, center.longitude);
      if (dist <= inner) return; // jitter — still at the site
    }
    await doAutoClockOut(coords ?? { latitude: center.latitude, longitude: center.longitude });
    return;
  }

  if (eventType === Location.GeofencingEventType.Enter && region.identifier === INNER_ID && !onShift) {
    // Re-open a day that was closed FOR LEAVING THE SITE — by this phone, or by
    // the server's away-from-site watchdog.
    //
    // This used to accept only a closure this phone had performed, and treated
    // the watchdog's as deliberate: it refused to clock back in AND tore the
    // geofence down. But the watchdog is the half that works when the app has
    // been swiped away, so in practice it closes almost all of these days. The
    // effect was that the first time someone was clocked out for stepping away,
    // they were never clocked back in, and their phone quietly stopped watching
    // for the rest of the day. Every re-entry in production was manual.
    //
    // A manual clock-out, an admin edit or the 07:00 settle still mean the day
    // is genuinely over, and those correctly stand monitoring down.
    const closedForLeaving = (await autoOutPending()) || today.attendance.auto_clocked_out === true;
    if (!closedForLeaving) {
      await stopGeofenceAutoMode();
      return;
    }
    // No multi_session pre-check. It used to skip re-entry SILENTLY for anyone
    // limited to one session a day — the same people we had just clocked out
    // for stepping away. They came back to nothing at all: no clock-in, no
    // notification, no explanation. Attempt it and let doAutoClockIn() report
    // what the server says.
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

  // Approved on-duty suppresses the repair path too, otherwise reconciliation
  // would clock out the very employee the geofence handler just spared.
  if (onShift && dist > fence.radius + EXIT_MARGIN_M) {
    if (today.on_duty_now) return;
    await doAutoClockOut(coords);
  } else if (
    !onShift &&
    // Closed for leaving the site — by this phone, or by the server's watchdog.
    // Accepting only our own closure made this repair path useless in exactly
    // the case it exists for: the OS geofence missing the re-entry after the
    // WATCHDOG ended the day, which is how nearly every one of these days ends.
    ((await autoOutPending()) || today.attendance.auto_clocked_out === true) &&
    dist <= fence.radius
  ) {
    // Same as the live handler: no multi_session pre-check, so a refusal is
    // reported to the employee instead of vanishing.
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

  // The configured radius is the one every DECISION uses — the jitter check on
  // an exit event, and reconcileGeofenceAttendance's distance maths. It is
  // stored as-is, with no floor: a 10 m site means 10 m.
  const inner = Number(radiusMeters) > 0 ? Number(radiusMeters) : 200;
  await SecureStore.setItemAsync(FENCE_KEY, JSON.stringify({ latitude, longitude, radius: inner })).catch(() => {});

  // The OS region is only a WAKE-UP, not the ruling. Android's geofencing is
  // unreliable much below ~100 m — it may fire late or not at all — so the
  // region registered with the OS is widened to that, while the app still
  // judges in/out against `inner`. A small site therefore gets woken slightly
  // early and then decides for itself, rather than never being woken at all.
  const OS_MIN_REGION_M = 100;
  const osInner = Math.max(inner, OS_MIN_REGION_M);
  await Location.startGeofencingAsync(GEOFENCE_TASK, [
    { identifier: INNER_ID, latitude, longitude, radius: osInner, notifyOnEnter: true, notifyOnExit: false },
    { identifier: OUTER_ID, latitude, longitude, radius: osInner + EXIT_MARGIN_M, notifyOnEnter: false, notifyOnExit: true },
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

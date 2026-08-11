import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { apiFetch, ApiError } from '../api/client';
import { startBackgroundTracking, stopBackgroundTracking, setFixListener } from './tracking';
import { scheduleShiftEndReminders, cancelShiftEndReminders } from '../notifications/shiftReminder';
import { decideFenceExitAction, EXIT_MAX_WARNINGS } from './fenceExitPolicy';

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
    // A new session starts with a clean slate — no warning count carried over
    // from the excursion that ended the previous one.
    await resetFenceExitStrikes();
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

// ---------------------------------------------------------------------------
// Leaving the fence: four warnings, one minute apart, then the clock-out.
//
// The Exit event used to clock out on the spot. That is the harshest possible
// reading of a boundary crossing — someone walking to the gate for a parcel
// was off the clock before they reached it, and (for a single-session account)
// locked out for the rest of the day. Now the crossing starts an escalation:
//
//   warning 1 (at the boundary) → 2 → 3 → 4 (final), one minute apart,
//   then the automatic clock-out — with the same one-minute grace after the
//   final warning as after every earlier one.
//
// Coming back inside the fence at ANY point wipes the count and the day never
// closes at all. The warnings advance from the 30-second tracking fixes (via
// setFixListener below), so the cadence holds with the app swiped away; the
// server watchdog, ten minutes behind, stays the backstop for a phone that
// stops reporting and so cannot be warned by anything.
// ---------------------------------------------------------------------------

const EXIT_STRIKE_COUNT_KEY = 'fence_exit_strikes';
const EXIT_STRIKE_TS_KEY = 'fence_exit_last_strike_ms';

async function exitStrikes(): Promise<{ warnings: number; lastMs: number }> {
  const warnings = Number(await SecureStore.getItemAsync(EXIT_STRIKE_COUNT_KEY).catch(() => '0')) || 0;
  const lastMs = Number(await SecureStore.getItemAsync(EXIT_STRIKE_TS_KEY).catch(() => '0')) || 0;
  return { warnings, lastMs };
}

/** Wipe the escalation. With `announce`, tell the employee they made it back —
 *  but only when there was an escalation to survive, so an ordinary day inside
 *  the fence never produces a notification (or a storage write) from this. */
async function resetFenceExitStrikes(announce = false): Promise<void> {
  const { warnings } = await exitStrikes();
  if (warnings === 0) return;
  await SecureStore.setItemAsync(EXIT_STRIKE_COUNT_KEY, '0').catch(() => {});
  await SecureStore.setItemAsync(EXIT_STRIKE_TS_KEY, '0').catch(() => {});
  if (announce) {
    await notify('Back on site', 'You returned in time — you are still clocked in.');
  }
}

/** One escalation step: the next warning if a minute has passed, or the
 *  clock-out once all four have been ignored for a minute more. */
async function progressFenceExit(coords: { latitude: number; longitude: number }): Promise<void> {
  const { warnings, lastMs } = await exitStrikes();
  const decision = decideFenceExitAction(warnings, lastMs, Date.now());
  if (decision.action === 'wait') return;

  if (decision.action === 'clock_out') {
    // One last look at the server before acting. Approved on-duty granted
    // mid-escalation, or a day already closed from elsewhere, means standing
    // down — this is the single moment where firing wrongly costs someone
    // their session, so it is worth one API call.
    const today = await fetchToday();
    if (!today) return; // offline — retry on the next fix
    if (
      !today.attendance?.clock_in_utc ||
      today.attendance.clock_out_utc ||
      today.on_duty_now
    ) {
      await resetFenceExitStrikes();
      return;
    }
    if (await doAutoClockOut(coords)) await resetFenceExitStrikes();
    return;
  }

  await SecureStore.setItemAsync(EXIT_STRIKE_COUNT_KEY, String(decision.warningNumber)).catch(() => {});
  await SecureStore.setItemAsync(EXIT_STRIKE_TS_KEY, String(Date.now())).catch(() => {});
  await notify(
    `Return to your work site — warning ${decision.warningNumber} of ${EXIT_MAX_WARNINGS}${decision.isFinal ? ' (final)' : ''}`,
    decision.isFinal
      ? 'Final warning. You are still away from your work site — go back now or you will be clocked out automatically.'
      : 'You have left your work site while clocked in. Go back, or you will be clocked out automatically after the remaining warnings.',
  );
}

/**
 * Fence check on every tracking fix — the 30-second heartbeat that keeps the
 * one-minute warning cadence honest while the app is swiped away.
 *
 * This path only ever ADVANCES an escalation or wipes it; it never starts one.
 * Starting is reserved for the geofence Exit event and reconciliation, which
 * both check approved on-duty first — a bare fix knows nothing about
 * permissions, and warning someone who is away with an admin's blessing is
 * exactly the mistake the on-duty feature exists to prevent.
 */
async function onTrackedFix(coords: { latitude: number; longitude: number }): Promise<void> {
  const fence = await storedFence();
  if (!fence) return;
  const dist = haversineMeters(coords.latitude, coords.longitude, fence.latitude, fence.longitude);
  if (dist <= fence.radius) {
    await resetFenceExitStrikes(true);
    return;
  }
  // Inside the hysteresis band: not home, not gone — leave the count alone.
  if (dist <= fence.radius + EXIT_MARGIN_M) return;
  const { warnings } = await exitStrikes();
  if (warnings > 0) await progressFenceExit(coords);
}

setFixListener(coords => { void onTrackedFix(coords); });

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
      // Any escalation in flight is void too — they are away with permission.
      await resetFenceExitStrikes();
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
    // Not an instant clock-out any more: this starts the warning escalation
    // (warning 1 of 4 fires here, at the boundary), and the tracking fixes
    // carry it forward from there.
    await progressFenceExit(coords ?? { latitude: center.latitude, longitude: center.longitude });
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
    if (today.on_duty_now) {
      await resetFenceExitStrikes();
      return;
    }
    // Starts the escalation when the OS Exit event was missed (network blip
    // during the transition), or advances one already running — either way the
    // employee gets the warnings, not a clock-out from nowhere.
    await progressFenceExit(coords);
  } else if (onShift && dist <= fence.radius) {
    // Back inside with the day still open: the escalation (if any) is over and
    // the day simply never closed.
    await resetFenceExitStrikes(true);
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
  // Monitoring is over, so no warning count may survive into the next shift —
  // stale strikes would give tomorrow's first step outside an instant
  // "final warning".
  await SecureStore.setItemAsync(EXIT_STRIKE_COUNT_KEY, '0').catch(() => {});
  await SecureStore.setItemAsync(EXIT_STRIKE_TS_KEY, '0').catch(() => {});
}

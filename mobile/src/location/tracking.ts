import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { PermissionsAndroid, Platform } from 'react-native';
import { apiFetch, ApiError } from '../api/client';
import { getState, setState } from '../storage/state';
import { LOCATION_INTERVAL_MS, LOCATION_DISTANCE_M, LOCATION_MAX_QUEUE } from '../config';

export const LOCATION_TASK = 'attendance-background-location';
/** Owned by geofenceAuto, declared here so this module can ask whether the
 *  fence is armed without importing it (geofenceAuto imports this one). */
export const GEOFENCE_TASK = 'attendance-geofence-auto';

interface TrackedPoint {
  latitude: number;
  longitude: number;
  accuracy_meters: number | null;
  // GPS fix time (not send time) — the server stores this so points that are
  // batched by the OS or retried after an outage keep their true timestamps.
  tracked_at_utc: string;
}

// Points that couldn't be uploaded yet. Lives as long as the foreground
// service keeps this JS runtime alive, which is exactly the window we track in.
let pending: TrackedPoint[] = [];

// ---------------------------------------------------------------------------
// Is tracking ALIVE, not merely registered?
//
// isTrackingRunning() asks whether the task is registered, and a registration
// survives the OS killing the service — battery savers and OEM task killers
// do exactly that, often. So a phone could report "running" for hours while no
// fix arrived, nothing restarted it, and the only sign was a gap on the
// admin's map (and, at the day's end, hours settled at the last fix). The time
// of the last fix that actually reached this task is the honest signal.
// ---------------------------------------------------------------------------
const LAST_FIX_KEY = 'tracking_last_fix_ms';
/** No fix for this long while tracking should be on means it has died. Six
 *  missed fixes at the 30-second interval. */
export const TRACKING_STALE_MS = 3 * 60_000;

/** Milliseconds since the last fix arrived (or since tracking was last
 *  started), or null when there is no record. */
export async function lastFixAgeMs(): Promise<number | null> {
  const at = Number(await getState(LAST_FIX_KEY));
  return at > 0 ? Date.now() - at : null;
}

// ---------------------------------------------------------------------------
// Paused uploads: the shift is closed, but the phone is still watching.
//
// After an automatic clock-out the server refuses every upload ("no open
// shift"), and that refusal used to stop this service on the spot. But the
// phone is meant to keep watching for the employee's return — doAutoClockOut
// deliberately leaves the service running for exactly that — and Android 12+
// will not let a background task start it again. So the clock-in on return
// found no service, nothing noticed them come back, and tracking was dead for
// the rest of the shift even when the day did re-open.
//
// Now, while the geofence is still armed, that refusal PAUSES uploads instead:
// fixes keep flowing to the fence listener (which is what notices they are
// back), one upload is retried every few minutes in case the shift re-opened
// some other way, and the service stops as soon as the geofence is disarmed.
// ---------------------------------------------------------------------------
const PAUSED_PROBE_MS = 5 * 60_000;
// Watching is GPS, and someone who has genuinely gone home would keep it on
// until tomorrow. A false closure at the desk is noticed within minutes and a
// break or errand is over well inside this; after it the OS geofence, which
// costs nothing, is left to report a return on its own.
const PAUSED_MAX_WATCH_MS = 2 * 60 * 60_000;
/** When uploads were paused; 0 while uploading normally. */
let uploadsPausedAt = 0;
let lastProbeMs = 0;

/** True while the shift is closed and the service is only watching for a return. */
export function trackingUploadsPaused(): boolean {
  return uploadsPausedAt > 0;
}

async function geofenceArmed(): Promise<boolean> {
  return Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false);
}

/** The server's "your shift is closed" — as opposed to "tracking is disabled
 *  for you". The message is matched too, for a server older than the code. */
function isShiftClosed(err: ApiError): boolean {
  return err.code === 'no_open_shift' || /not clocked in/i.test(err.message);
}

/** A 403 on upload: pause if the phone is still watching for a return,
 *  otherwise there is nothing left to track — stop. */
async function onUploadRefused(err: ApiError): Promise<void> {
  if (isShiftClosed(err) && (await geofenceArmed())) {
    if (!uploadsPausedAt) uploadsPausedAt = Date.now();
    lastProbeMs = Date.now();
    return; // these points are dropped: the server would refuse them
  }
  await stopBackgroundTracking();
}

async function pingBatch(points: TrackedPoint[]): Promise<void> {
  await apiFetch('/api/live-tracking/ping', {
    method: 'POST',
    // device_now_utc lets the server measure this phone's clock error and
    // correct the point timestamps — a phone with a wrong clock otherwise
    // shows all its tracking times shifted on the admin map.
    body: { points, device_now_utc: new Date().toISOString() },
  });
  uploadsPausedAt = 0; // accepted, so the shift is open — upload normally
}

// Transient failures (no network, DNS, timeout, server 5xx) are worth
// retrying; 4xx responses mean the server understood and refused — drop those.
function shouldRetry(err: unknown): boolean {
  return !(err instanceof ApiError) || err.status >= 500;
}

// The server takes at most 500 points per upload, and refuses an accuracy
// figure over 10 km — refusing the WHOLE batch either way, with a 400 that
// counts as "do not retry". The queue holds 2000, so four hours offline (the
// outage the queue exists for) ended with the entire saved trail thrown away.
// Uploads now go oldest-first in pieces the server accepts; what is left waits
// for the next fix.
const MAX_POINTS_PER_UPLOAD = 500;
const MAX_ACCURACY_M = 10_000;

async function sendPoints(fresh: TrackedPoint[]): Promise<void> {
  // Oldest first; drop from the front when over cap so the newest survive.
  const queued = [...pending, ...fresh].slice(-LOCATION_MAX_QUEUE).map(p => (
    p.accuracy_meters != null && p.accuracy_meters > MAX_ACCURACY_M
      ? { ...p, accuracy_meters: MAX_ACCURACY_M }
      : p
  ));
  const batch = queued.slice(0, MAX_POINTS_PER_UPLOAD);
  // The rest stays queued, in order, behind this piece.
  pending = queued.slice(MAX_POINTS_PER_UPLOAD);
  try {
    await pingBatch(batch);
  } catch (err) {
    // 403 = the shift is over (clocked out / auto-closed) or the admin
    // disabled tracking. See onUploadRefused. Nothing queued will be taken.
    if (err instanceof ApiError && err.status === 403) {
      pending = [];
      await onUploadRefused(err);
      return;
    }
    if (err instanceof ApiError && err.status === 404) {
      // No active session (app relaunched in background, or the server closed
      // the session as stale during an outage) → reopen one and retry the batch
      // so the buffered path is not lost.
      const latest = batch[batch.length - 1];
      try {
        await apiFetch('/api/live-tracking/start', {
          method: 'POST',
          body: {
            latitude: latest.latitude,
            longitude: latest.longitude,
            accuracy_meters: latest.accuracy_meters,
          },
        });
        await pingBatch(batch);
      } catch (err2) {
        if (err2 instanceof ApiError && err2.status === 403) {
          pending = [];
          await onUploadRefused(err2);
          return;
        }
        if (shouldRetry(err2)) requeue(batch);
      }
      return;
    }
    // 403 = admin disabled tracking, 401 = session revoked: drop the points.
    // Offline/DNS/timeout and server 5xx are retried with the next fix.
    if (shouldRetry(err)) requeue(batch);
  }
}

/** Put a failed piece back at the FRONT, ahead of what was still waiting. */
function requeue(batch: TrackedPoint[]): void {
  pending = [...batch, ...pending].slice(-LOCATION_MAX_QUEUE);
}

// Every fresh fix is also offered to one listener, registered by geofenceAuto
// at module load. This is how the away-from-site warnings keep their one-minute
// cadence with the app swiped away: this task is the only JS that reliably runs
// every 30 seconds in the background (the foreground service keeps it alive),
// and it cannot import geofenceAuto itself — geofenceAuto already imports this
// module, and completing that circle would make module init order a coin toss.
type FixListener = (fix: { latitude: number; longitude: number; accuracy_meters: number | null }) => void;
let fixListener: FixListener | null = null;
export function setFixListener(fn: FixListener): void {
  fixListener = fn;
}

// Defined at module load so the OS can invoke it even after the app is killed
// and relaunched in the background. Import this file once from App.tsx.
TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error) return;
  const { locations } = (data ?? {}) as { locations?: Location.LocationObject[] };
  if (!locations?.length) return;
  // Send every fix in the batch (the OS may deliver several at once after
  // doze), not just the last one — otherwise the path on the admin map has gaps.
  const points = locations.map(loc => ({
    latitude: loc.coords.latitude,
    longitude: loc.coords.longitude,
    accuracy_meters: loc.coords.accuracy ?? null,
    tracked_at_utc: new Date(loc.timestamp).toISOString(),
  }));
  void setState(LAST_FIX_KEY, String(Date.now()));
  // The newest fix drives fence-exit enforcement; a listener failure must
  // never cost the batch its upload.
  try {
    fixListener?.(points[points.length - 1]);
  } catch {
    // enforcement is retried on the next fix
  }
  if (uploadsPausedAt) {
    // Watching for a return only while the fence is armed; once it is
    // disarmed (day genuinely over, logout) nothing is left to watch for.
    if (!(await geofenceArmed()) || Date.now() - uploadsPausedAt > PAUSED_MAX_WATCH_MS) {
      await stopBackgroundTracking();
      return;
    }
    if (Date.now() - lastProbeMs < PAUSED_PROBE_MS) return;
    lastProbeMs = Date.now();
  }
  await sendPoints(points);
});

// Request permissions and start the foreground-service location updates that
// continue with the screen off / app backgrounded.
// Android 13+ needs POST_NOTIFICATIONS for the foreground-service notification
// to display. Without a visible notification the OS doesn't keep the service
// alive in the background — so this is required for background tracking to work.
async function ensureNotificationPermission(): Promise<void> {
  if (Platform.OS === 'android' && typeof Platform.Version === 'number' && Platform.Version >= 33) {
    try {
      await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    } catch {
      // best effort
    }
  }
}

export async function startBackgroundTracking(): Promise<void> {
  // Every start follows a clock-in, so the shift is open: upload again. Set
  // before anything that can throw — from a background task the restart below
  // may be refused, while the service it would restart is still running.
  uploadsPausedAt = 0;
  // The staleness clock starts now: the first fix is up to an interval away.
  await setState(LAST_FIX_KEY, String(Date.now()));
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') {
    throw new Error('Location permission is required to track attendance.');
  }
  // Android 12+ lets the user grant only "Approximate" location (~2 km).
  // That's useless for attendance tracking, so insist on precise.
  if (Platform.OS === 'android' && fg.android?.accuracy === 'coarse') {
    throw new Error(
      'Precise location is off. Open Settings → Apps → Attendance → Permissions → Location and turn on "Use precise location".',
    );
  }
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (bg.status !== 'granted') {
    throw new Error('Please allow location "All the time" so tracking works with the app closed.');
  }
  // Must come before starting the service so its notification can show.
  await ensureNotificationPermission();

  // Always (re)start — if the service is already running this just applies the
  // current options, so interval/accuracy changes shipped in an app update take
  // effect instead of the service running forever with stale settings.
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: LOCATION_INTERVAL_MS,
    distanceInterval: LOCATION_DISTANCE_M,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Attendance tracking active',
      notificationBody: 'Your location is recorded while you are clocked in.',
      killServiceOnDestroy: false,
    },
  });
}

export async function stopBackgroundTracking(): Promise<void> {
  // Force-stop unconditionally. Previously this was gated on a status check —
  // if that check threw, the stop was skipped and the foreground service kept
  // running after logout. Calling stop when it isn't running just throws, which
  // we swallow, so this reliably kills tracking immediately.
  pending = [];
  uploadsPausedAt = 0;
  try {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  } catch {
    // not running / already stopped — fine
  }
}

export async function isTrackingRunning(): Promise<boolean> {
  return Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
}

/**
 * WHY tracking cannot start — checked in the order the OS enforces them.
 *
 * The "tap to fix" helper used to offer battery settings for every failure,
 * because the real reason was thrown away by a catch. On a phone whose actual
 * blocker was the location permission, allowing background activity changed
 * nothing and the same dialog returned — repeatedly, which is exactly what was
 * reported. Naming the blocker is the difference between a loop and a fix.
 */
export type TrackingBlocker = 'services' | 'foreground' | 'precise' | 'background' | 'notifications' | null;

export async function diagnoseTracking(): Promise<{ blocker: TrackingBlocker; message: string }> {
  const services = await Location.hasServicesEnabledAsync().catch(() => false);
  if (!services) {
    return { blocker: 'services', message: 'Location (GPS) is switched off on this phone.' };
  }
  const fg = await Location.getForegroundPermissionsAsync().catch(() => null);
  if (!fg?.granted) {
    return { blocker: 'foreground', message: 'This app does not have location permission.' };
  }
  if (Platform.OS === 'android' && fg.android?.accuracy === 'coarse') {
    return { blocker: 'precise', message: 'Location is set to Approximate. Attendance needs Precise.' };
  }
  const bg = await Location.getBackgroundPermissionsAsync().catch(() => null);
  if (!bg?.granted) {
    return {
      blocker: 'background',
      message: 'Location is set to "While using the app". It must be "Allow all the time".',
    };
  }
  // Android 13+ refuses to show the foreground service's notification without
  // POST_NOTIFICATIONS — and without a visible notification the OS will not
  // keep the service alive. An employee who dismissed that permission prompt
  // has perfect location settings and no tracking, which looks like nothing at
  // all is wrong. It is the one blocker nobody thinks to check.
  if (Platform.OS === 'android' && typeof Platform.Version === 'number' && Platform.Version >= 33) {
    const canNotify = await PermissionsAndroid.check(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    ).catch(() => true); // unknown → do not accuse
    if (!canNotify) {
      return {
        blocker: 'notifications',
        message: 'Notifications are blocked, so the tracking service cannot stay running.',
      };
    }
  }

  // Everything the app can see is in order, so what remains is the OS killing
  // the service — battery management, which is the one thing no API reports
  // reliably across OEMs.
  return { blocker: null, message: 'Your phone is stopping the app from running in the background.' };
}

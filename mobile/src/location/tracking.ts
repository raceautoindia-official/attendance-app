import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { PermissionsAndroid, Platform } from 'react-native';
import { apiFetch, ApiError } from '../api/client';
import { LOCATION_INTERVAL_MS, LOCATION_DISTANCE_M, LOCATION_MAX_QUEUE } from '../config';

export const LOCATION_TASK = 'attendance-background-location';

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

async function pingBatch(points: TrackedPoint[]): Promise<void> {
  await apiFetch('/api/live-tracking/ping', {
    method: 'POST',
    // device_now_utc lets the server measure this phone's clock error and
    // correct the point timestamps — a phone with a wrong clock otherwise
    // shows all its tracking times shifted on the admin map.
    body: { points, device_now_utc: new Date().toISOString() },
  });
}

// Transient failures (no network, DNS, timeout, server 5xx) are worth
// retrying; 4xx responses mean the server understood and refused — drop those.
function shouldRetry(err: unknown): boolean {
  return !(err instanceof ApiError) || err.status >= 500;
}

async function sendPoints(fresh: TrackedPoint[]): Promise<void> {
  // Oldest first; drop from the front when over cap so the newest survive.
  const batch = [...pending, ...fresh].slice(-LOCATION_MAX_QUEUE);
  pending = [];
  try {
    await pingBatch(batch);
  } catch (err) {
    // 403 = the shift is over (clocked out / auto-closed at midnight) or the
    // admin disabled tracking. Kill the service so the phone doesn't keep
    // reporting location on days the employee never logged in.
    if (err instanceof ApiError && err.status === 403) {
      await stopBackgroundTracking();
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
          await stopBackgroundTracking();
          return;
        }
        if (shouldRetry(err2)) pending = batch;
      }
      return;
    }
    // 403 = admin disabled tracking, 401 = session revoked: drop the points.
    // Offline/DNS/timeout and server 5xx are retried with the next fix.
    if (shouldRetry(err)) pending = batch;
  }
}

// Every fresh fix is also offered to one listener, registered by geofenceAuto
// at module load. This is how the away-from-site warnings keep their one-minute
// cadence with the app swiped away: this task is the only JS that reliably runs
// every 15 seconds in the background (the foreground service keeps it alive),
// and it cannot import geofenceAuto itself — geofenceAuto already imports this
// module, and completing that circle would make module init order a coin toss.
type FixListener = (coords: { latitude: number; longitude: number }) => void;
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
  // The newest fix drives fence-exit enforcement; a listener failure must
  // never cost the batch its upload.
  try {
    fixListener?.(points[points.length - 1]);
  } catch {
    // enforcement is retried on the next fix
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
  try {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  } catch {
    // not running / already stopped — fine
  }
}

export async function isTrackingRunning(): Promise<boolean> {
  return Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
}

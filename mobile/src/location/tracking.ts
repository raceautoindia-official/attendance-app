import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { PermissionsAndroid, Platform } from 'react-native';
import { apiFetch, ApiError } from '../api/client';
import { LOCATION_INTERVAL_MS, LOCATION_DISTANCE_M } from '../config';

export const LOCATION_TASK = 'attendance-background-location';

interface PingBody {
  latitude: number;
  longitude: number;
  accuracy_meters: number | null;
}

async function sendPoint(body: PingBody): Promise<void> {
  try {
    await apiFetch('/api/live-tracking/ping', { method: 'POST', body });
  } catch (err) {
    // No active session yet (e.g. app relaunched into the background) → open one.
    if (err instanceof ApiError && err.status === 404) {
      try {
        await apiFetch('/api/live-tracking/start', { method: 'POST', body });
      } catch {
        // give up this round; the next fix retries
      }
    }
    // Other errors (offline, 401-after-failed-refresh) are swallowed; the next
    // location update retries.
  }
}

// Defined at module load so the OS can invoke it even after the app is killed
// and relaunched in the background. Import this file once from App.tsx.
TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error) return;
  const { locations } = (data ?? {}) as { locations?: Location.LocationObject[] };
  const loc = locations?.[locations.length - 1];
  if (!loc) return;
  await sendPoint({
    latitude: loc.coords.latitude,
    longitude: loc.coords.longitude,
    accuracy_meters: loc.coords.accuracy ?? null,
  });
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
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (bg.status !== 'granted') {
    throw new Error('Please allow location "All the time" so tracking works with the app closed.');
  }
  // Must come before starting the service so its notification can show.
  await ensureNotificationPermission();

  const alreadyRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(
    () => false,
  );
  if (alreadyRunning) return;

  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: LOCATION_INTERVAL_MS,
    distanceInterval: LOCATION_DISTANCE_M,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Attendance tracking active',
      notificationBody: 'Your location is recorded while you are clocked in.',
    },
  });
}

export async function stopBackgroundTracking(): Promise<void> {
  // Force-stop unconditionally. Previously this was gated on a status check —
  // if that check threw, the stop was skipped and the foreground service kept
  // running after logout. Calling stop when it isn't running just throws, which
  // we swallow, so this reliably kills tracking immediately.
  try {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  } catch {
    // not running / already stopped — fine
  }
}

export async function isTrackingRunning(): Promise<boolean> {
  return Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
}

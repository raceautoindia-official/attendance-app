import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { PermissionsAndroid, Platform } from 'react-native';
import { apiFetch, ApiError } from '../api/client';
import { notifyPermissionUpdates, PermissionUpdate } from './permissionUpdates';

// ---------------------------------------------------------------------------
// The inbox heartbeat — polls for things the employee should be TOLD about,
// with the app closed.
//
// Every notification in this app is local: the phone polls the server and
// announces what it finds. With the app open that happens every minute. In the
// background it used to ride the location watch — which stops when the person
// is not clocked in or has tracking disabled. So exactly the person waiting to
// hear about tomorrow's permission, off shift with the phone in a pocket,
// had no heartbeat at all: the verdict sat unread until they next opened the
// app, and "notifications don't work outside the app" was literally true.
//
// This task is registered at login and unregistered ONLY at logout (or a dead
// session). It deliberately does not care whether the person is clocked in,
// tracked, or fenced — being told your request was approved is not a shift
// activity.
//
// Android schedules background tasks no more often than ~every 15 minutes and
// may defer them in doze, so a decision reaches a closed app within roughly
// 15–30 minutes. Instant delivery would need a push server (FCM); this is the
// honest best without one.
// ---------------------------------------------------------------------------

export const INBOX_TASK = 'attendance-inbox-poller';

interface TodayInbox {
  permission_updates?: PermissionUpdate[];
}

// Defined at module load so the OS can invoke it headlessly after the app is
// killed. Import this file once from a screen that always loads.
TaskManager.defineTask(INBOX_TASK, async () => {
  try {
    const today = await apiFetch<TodayInbox>('/api/attendance/today');
    await notifyPermissionUpdates(today.permission_updates);
  } catch (err) {
    // Logged out — nothing on this device should keep polling on their behalf.
    if (err instanceof ApiError && err.status === 401) {
      await stopInboxPoller();
    }
    // Anything else (offline, server restart) simply waits for the next run.
  }
  return BackgroundTask.BackgroundTaskResult.Success;
});

/** Registers the heartbeat. Safe to call on every app open — re-registering an
 *  already-registered task is a no-op, and calling it early also ensures the
 *  notification permission exists for someone who never started tracking. */
export async function startInboxPoller(): Promise<void> {
  // Android 13+ shows nothing without POST_NOTIFICATIONS. Tracking start also
  // requests it, but an employee can receive a permission verdict without ever
  // having tracked — the announcement must not depend on that coincidence.
  if (Platform.OS === 'android' && typeof Platform.Version === 'number' && Platform.Version >= 33) {
    try {
      await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    } catch {
      // best effort
    }
  }
  try {
    await BackgroundTask.registerTaskAsync(INBOX_TASK, {
      minimumInterval: 15, // minutes — the floor Android allows
    });
  } catch {
    // Background tasks unavailable (rare) — the in-app poll still announces.
  }
}

export async function stopInboxPoller(): Promise<void> {
  try {
    await BackgroundTask.unregisterTaskAsync(INBOX_TASK);
  } catch {
    // not registered — fine
  }
}

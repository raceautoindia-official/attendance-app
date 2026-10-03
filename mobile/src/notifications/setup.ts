import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

// ---------------------------------------------------------------------------
// One place that owns notifications.
//
// There were five: the geofence warnings, the location warnings, the permission
// decisions, the shift-end reminders and the morning reminder each declared
// their own channel and their own send helper. That left three problems.
//
//  1. PERMISSION WAS NEVER ASKED FOR by most of them. On Android 13 and up
//     POST_NOTIFICATIONS is a runtime permission — declaring it in the manifest
//     grants nothing. Only the two reminder modules asked, and only at
//     clock-in, so on a phone where that had not happened the away-from-site
//     warnings — the ones that matter most — were posted into a void with no
//     error. That is the bug behind "notifications don't work properly".
//
//  2. THE FOREGROUND HANDLER lived inside the shift-reminder module, so
//     whether a notification appeared while the app was open depended on
//     whether an unrelated feature module happened to be imported.
//
//  3. EVERY SEND re-created its channel first — a native round-trip before
//     each notification, on paths that fire from a background task where the
//     work is already tight.
//
// Channels are created once per JS context, the handler is set once, and the
// permission answer is remembered. Background tasks run in their OWN context,
// so this is written to self-initialise on first use rather than depending on
// App.tsx having run.
// ---------------------------------------------------------------------------

export const CHANNELS = {
  /** Leaving the work site: warnings, then the automatic clock-out. */
  geofence: 'geofence-auto',
  /** Location switched off, tracking stopped — enforcement warnings. */
  location: 'location-warnings',
  /** A manager approved or rejected a permission request. */
  permission: 'permission-updates',
  /** Nine hours are up, please clock out. */
  shift: 'shift-reminders',
  /** Good morning, you have not clocked in. */
  attendance: 'attendance-reminders',
} as const;

export type ChannelId = (typeof CHANNELS)[keyof typeof CHANNELS];

const CHANNEL_NAMES: Record<ChannelId, string> = {
  [CHANNELS.geofence]: 'Automatic attendance',
  [CHANNELS.location]: 'Location warnings',
  [CHANNELS.permission]: 'Permission updates',
  [CHANNELS.shift]: 'Shift reminders',
  [CHANNELS.attendance]: 'Attendance reminders',
};

let channelsReady = false;
let handlerSet = false;
/** null = not asked yet in this context. */
let permissionGranted: boolean | null = null;

/**
 * Show notifications even while the app is in the foreground.
 *
 * Without this, a warning raised while somebody is staring at the app does
 * nothing at all — which is exactly when they are most likely to be walking
 * away from site with the screen on.
 */
function ensureHandler(): void {
  if (handlerSet) return;
  handlerSet = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

async function ensureChannels(): Promise<void> {
  if (channelsReady || Platform.OS !== 'android') {
    channelsReady = true;
    return;
  }
  try {
    await Promise.all(
      (Object.values(CHANNELS) as ChannelId[]).map(id =>
        Notifications.setNotificationChannelAsync(id, {
          name: CHANNEL_NAMES[id],
          importance: Notifications.AndroidImportance.HIGH,
          sound: 'default',
          vibrationPattern: [0, 400, 200, 400],
          // Head-up on the lock screen. A warning that only lands silently in
          // the shade is not a warning.
          lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
          enableVibrate: true,
        }),
      ),
    );
    channelsReady = true;
  } catch {
    // A channel that could not be created must not stop the app; the send
    // below will still be attempted.
  }
}

/**
 * Do we have permission to post notifications?
 *
 * @param ask  Request it if it has not been granted. Only pass true from a
 *             foreground screen — a background task cannot show a dialog, and
 *             asking there would burn the one-shot prompt with nobody looking.
 */
export async function ensureNotificationPermission(ask = false): Promise<boolean> {
  if (permissionGranted === true) return true;
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) {
      permissionGranted = true;
      return true;
    }
    if (!ask) {
      permissionGranted = false;
      return false;
    }
    const asked = await Notifications.requestPermissionsAsync();
    permissionGranted = asked.granted;
    return asked.granted;
  } catch {
    permissionGranted = false;
    return false;
  }
}

/**
 * Called once when the app starts, from App.tsx.
 *
 * This is the ONLY place that prompts, and it prompts on launch rather than at
 * clock-in: the warnings that matter fire from background tasks that cannot
 * ask for anything.
 */
export async function initNotifications(): Promise<void> {
  ensureHandler();
  await ensureChannels();
  await ensureNotificationPermission(true);
}

/**
 * Post a notification now. Returns whether it was actually posted.
 *
 * The caller usually ignores the answer, but not always: a permission verdict
 * that could not be shown must NOT be recorded as announced, or the employee
 * never learns of it. "Tried and failed" and "shown" have to be tellable
 * apart, which a void return cannot do.
 *
 * Never throws: an alert failing must not take down the enforcement path that
 * raised it.
 */
export async function notify(
  channel: ChannelId,
  title: string,
  body: string,
): Promise<boolean> {
  try {
    ensureHandler();
    await ensureChannels();
    // Do not prompt here — this runs from background tasks too.
    if (!(await ensureNotificationPermission(false))) return false;
    await Notifications.scheduleNotificationAsync({
      content: { title, body, sound: 'default' },
      trigger: Platform.OS === 'android' ? { channelId: channel } : null,
    });
    return true;
  } catch {
    // never fail an attendance action over a notification
    return false;
  }
}

/** Schedule one for a specific moment, returning its identifier. */
export async function scheduleAt(
  channel: ChannelId,
  fireAt: Date,
  title: string,
  body: string,
): Promise<string | null> {
  try {
    ensureHandler();
    await ensureChannels();
    if (!(await ensureNotificationPermission(false))) return null;
    return await Notifications.scheduleNotificationAsync({
      content: { title, body, sound: 'default' },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: fireAt,
        channelId: channel,
      },
    });
  } catch {
    return null;
  }
}

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { apiFetch } from '../api/client';
import { getState, setState, removeState } from '../storage/state';

// ---------------------------------------------------------------------------
// Push: give the server this phone's address, so it can tell it things the
// moment they happen — with the app closed.
//
// Without it, the phone heard about an approval only when it asked, and a
// closed app asks only when Android lets a background task run: hours later,
// or never on a battery-strict phone. So notifications "only came when they
// opened the app".
//
// The address is the phone's Firebase Cloud Messaging token; the server sends
// to it with the Firebase project's key (lib/push.ts). Getting one needs
// google-services.json in the Android build. A build without it simply gets
// no token — the call fails, is caught here, and the app goes on announcing
// for itself exactly as before. Nothing else depends on this working.
// ---------------------------------------------------------------------------

/** `${token}|${day}` last sent, so the address is re-sent once a day (keeping
 *  it fresh on the server, and restoring it if the server dropped it) and not
 *  on every open. */
const SENT_KEY = 'push_token_sent';

export async function registerForPush(): Promise<void> {
  try {
    if (Platform.OS !== 'android') return;
    const perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) return; // nothing could be shown anyway — see health.ts
    const { data: token } = await Notifications.getDevicePushTokenAsync();
    if (typeof token !== 'string' || !token) return;
    const stamp = `${token}|${new Date().toDateString()}`;
    if ((await getState(SENT_KEY)) === stamp) return;
    await apiFetch('/api/push/register', { method: 'POST', body: { token, platform: Platform.OS } });
    await setState(SENT_KEY, stamp);
  } catch {
    // No Firebase in this build, no network, or a server without the
    // endpoint — the phone keeps announcing on its own.
  }
}

/** On sign-out: the next sign-in registers at once, for whoever it is. */
export async function forgetPushRegistration(): Promise<void> {
  await removeState(SENT_KEY);
}

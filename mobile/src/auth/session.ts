import { stopBackgroundTracking } from '../location/tracking';
import { stopGeofenceAutoMode } from '../location/geofenceAuto';
import { stopLocationWatch } from '../location/locationWatch';
import { stopInboxPoller } from '../notifications/inboxPoller';
import { cancelShiftEndReminders } from '../notifications/shiftReminder';
import { cancelClockInReminders } from '../notifications/clockInReminder';
import { clearTodayCache } from '../storage/cache';
import { forgetPushRegistration } from '../notifications/push';

/**
 * Everything a signed-out phone must stop doing.
 *
 * ONE list, used however the session ended: the dashboard's Sign out, the
 * unlock screen's Sign out, and a session the server ended (revoked, PIN
 * reset). There were two lists, and the forced-logout one stopped location
 * work but left the reminders armed and the inbox poll running — so a phone
 * whose session had been revoked went on saying "Good morning — clock in"
 * every morning for a week, to someone who could not.
 *
 * Side by side and allSettled: they are independent, and one failing must not
 * leave the rest running.
 */
export async function endLocalSession(): Promise<void> {
  await Promise.allSettled([
    stopBackgroundTracking(),
    stopGeofenceAutoMode(),
    stopLocationWatch(),
    stopInboxPoller(),
    cancelShiftEndReminders(),
    cancelClockInReminders(),
    clearTodayCache(),
    // The server forgets this phone's push address on sign-out; forget that
    // it was sent, so the next sign-in registers it straight away.
    forgetPushRegistration(),
  ]);
}

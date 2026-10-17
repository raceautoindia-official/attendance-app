import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { getState, setState, removeState } from '../storage/state';
import { apiFetch, ApiError } from '../api/client';
import {
  startBackgroundTracking,
  setFixListener,
  trackingUploadsPaused,
  GEOFENCE_TASK,
} from './tracking';
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

export { GEOFENCE_TASK };

const INNER_ID = 'fence-inner';
const OUTER_ID = 'fence-outer';
const EXIT_MARGIN_M = 150;
import { notify as sharedNotify, CHANNELS } from '../notifications/setup';

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
  /**
   * The fence the server says applies to this employee RIGHT NOW, or null when
   * geofencing has been switched off for them.
   *
   * The dashboard already stops monitoring when this goes away, but only while
   * the screen is mounted. These background paths judged from the fence stored
   * on the device and never asked again — so an admin disarming geofencing
   * disarmed the server and left every phone still enforcing, warning and
   * clocking people out from a fence that no longer existed. During an incident
   * that is precisely when the switch has just been thrown and precisely when
   * it must be obeyed.
   *
   * undefined (an older server that does not send the field) is NOT a disarm.
   * Only an explicit null is.
   */
  location?: { latitude: number; longitude: number; radius_meters: number } | null;
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

// ---------------------------------------------------------------------------
// Inside or outside — judged with the fix's own accuracy, not its bare
// distance.
//
// A position is an estimate: indoors it is routinely 20-80 m out, and the
// "Balanced" fixes these checks used to take come from Wi-Fi and cell towers
// and can be off by hundreds. Judging the bare distance against a small fence
// placed people at their desks outside it — a stray fix started the warnings,
// the person never measured as "inside" again from indoors so the count never
// reset, and a few more stray fixes over the day clocked them out. The two
// tests below lean in opposite directions on purpose: forgiving when deciding
// someone is still here, demanding when deciding they have gone.
// ---------------------------------------------------------------------------

/** Inside, giving the fix the benefit of its accuracy — capped at the radius,
 *  the same allowance the server uses to accept a fix as presence. */
function confidentlyInside(dist: number, accuracy: number | null, radius: number): boolean {
  return dist <= radius + Math.min(accuracy ?? 0, radius);
}

/** Beyond the outer ring even if the fix is off by its whole accuracy. */
function confidentlyOutside(dist: number, accuracy: number | null, radius: number): boolean {
  return dist - (accuracy ?? 0) > radius + EXIT_MARGIN_M;
}

interface Fix {
  latitude: number;
  longitude: number;
  accuracy: number | null;
}

// Sent through the shared helper: it owns the channel, the foreground handler
// and the permission check. This module used to create its channel on every
// single warning — a native round-trip on a path that runs from a background
// task — and never checked whether it was allowed to post at all, so on an
// Android 13 phone that had not granted POST_NOTIFICATIONS the four
// away-from-site warnings went nowhere and nothing said so.
async function notify(title: string, body: string): Promise<void> {
  await sharedNotify(CHANNELS.geofence, title, body);
}

async function storedFence(): Promise<Fence | null> {
  try {
    const raw = await getState(FENCE_KEY);
    return raw ? (JSON.parse(raw) as Fence) : null;
  } catch {
    return null;
  }
}

async function autoOutPending(): Promise<boolean> {
  return (await getState(AUTO_OUT_KEY)) === '1';
}

/** Auto clock-out (site exit). Returns true when the day state changed. */
async function doAutoClockOut(coords: { latitude: number; longitude: number; accuracy?: number | null }): Promise<boolean> {
  try {
    await apiFetch('/api/attendance/clock-out', {
      method: 'POST',
      body: {
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy_m: coords.accuracy ?? null,
        auto: true,
        reason: 'geofence_exit',
      },
    });
    await setState(AUTO_OUT_KEY, '1');
    // Deliberately NOT stopping the tracking foreground service here. Android
    // 12+ refuses to start a NEW foreground service from a background
    // execution context — which is exactly what this callback is — so if
    // tracking is torn down now, doAutoClockIn()'s restart on re-entry can
    // silently fail with no user in front of the phone to notice or reopen
    // the app. Confirmed in production: a real auto clock-in fired correctly,
    // then live_tracking_points went silent for 3.5+ hours because the
    // restart never landed.
    //
    // Leaving the service running through the "might come back" window avoids
    // the restart entirely — re-entry just keeps using what is already alive.
    // The cost is continued GPS use if they do not come back; that is bounded
    // by the day's own end (midnight settlement / manual logout), and cheaper
    // than an attendance system that silently stops watching someone the
    // moment it auto-clocks them back in.
    await cancelShiftEndReminders();
    await notify(
      'Auto clocked out',
      'You left the work site, so your attendance was clocked out. Re-entering will clock you in again.',
    );
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return true; // already closed elsewhere
    // 409 = the server declined: geofencing is no longer on for this employee.
    // Final, not a retry — this used to return false, leave the warning count
    // at four, and fire another refused clock-out on every 30-second fix until
    // the employee walked back inside. The fence it was enforcing is gone, so
    // stop watching it.
    if (err instanceof ApiError && err.status === 409) {
      await stopGeofenceAutoMode();
      return true;
    }
    if (err instanceof ApiError && err.status === 401) await stopGeofenceAutoMode();
    return false; // network — reconciliation retries
  }
}

/** Auto clock-in (site re-entry after our own auto clock-out). */
async function doAutoClockIn(coords: { latitude: number; longitude: number; accuracy?: number | null }): Promise<boolean> {
  try {
    await apiFetch('/api/attendance/clock-in', {
      method: 'POST',
      body: {
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy_m: coords.accuracy ?? null,
        auto: true,
      },
    });
    await removeState(AUTO_OUT_KEY);
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
      if (/already clocked in/i.test(err.message)) {
        await removeState(AUTO_OUT_KEY);
        return true;
      }
      // Any other 409 (e.g. "your work location has not been set up") is the
      // server refusing for a reason this phone cannot fix. It used to be read
      // as "already clocked in" and the pending re-entry quietly dropped;
      // standing down says the same thing honestly and stops the retries.
      await stopGeofenceAutoMode();
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
  const warnings = Number(await getState(EXIT_STRIKE_COUNT_KEY)) || 0;
  const lastMs = Number(await getState(EXIT_STRIKE_TS_KEY)) || 0;
  return { warnings, lastMs };
}

/** Wipe the escalation. With `announce`, tell the employee they made it back —
 *  but only when there was an escalation to survive, so an ordinary day inside
 *  the fence never produces a notification (or a storage write) from this. */
async function resetFenceExitStrikes(announce = false): Promise<void> {
  const { warnings } = await exitStrikes();
  if (warnings === 0) return;
  await setState(EXIT_STRIKE_COUNT_KEY, '0');
  await setState(EXIT_STRIKE_TS_KEY, '0');
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

  await setState(EXIT_STRIKE_COUNT_KEY, String(decision.warningNumber));
  await setState(EXIT_STRIKE_TS_KEY, String(Date.now()));
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
async function onTrackedFix(fix: Fix): Promise<void> {
  const fence = await storedFence();
  if (!fence) return;
  const dist = haversineMeters(fix.latitude, fix.longitude, fence.latitude, fence.longitude);

  // Shift closed, service only watching: this fix is how a return is noticed.
  if (trackingUploadsPaused()) {
    await watchForReturn(confidentlyInside(dist, fix.accuracy, fence.radius));
    return;
  }

  if (confidentlyInside(dist, fix.accuracy, fence.radius)) {
    await resetFenceExitStrikes(true);
    return;
  }
  // Not clearly gone: leave the count alone. Only a fix that is outside even
  // allowing for its error may move anyone closer to a clock-out.
  if (!confidentlyOutside(dist, fix.accuracy, fence.radius)) return;
  const { warnings } = await exitStrikes();
  if (warnings > 0) await progressFenceExit(fix);
}

// How often a watching phone asks the server whether to clock back in. Every
// fix arrives here (30 s); the question costs a request and a fresh GPS fix,
// so it is asked often only while the employee looks to be back inside.
const RETURN_CHECK_INSIDE_MS = 2 * 60_000;
const RETURN_CHECK_IDLE_MS = 10 * 60_000;
let lastReturnCheckMs = 0;

/**
 * Re-entry, noticed from the tracking fixes rather than only from the OS.
 *
 * The OS geofence reports a TRANSITION. Someone clocked out while still at
 * their desk — the false closures this whole module has been fighting — never
 * leaves the inner circle, so it never reports them entering it, and the auto
 * clock-in never came. Reconciliation decides (it knows whether the day was
 * closed for leaving and does the strict distance check); this only decides
 * when to ask. The idle checks are also what notices the day is genuinely
 * over, disarms the fence and so lets the paused service stop.
 */
async function watchForReturn(looksInside: boolean): Promise<void> {
  const gap = looksInside ? RETURN_CHECK_INSIDE_MS : RETURN_CHECK_IDLE_MS;
  if (Date.now() - lastReturnCheckMs < gap) return;
  lastReturnCheckMs = Date.now();
  await reconcileGeofenceAttendance().catch(() => {});
}

setFixListener(fix => {
  void onTrackedFix({ latitude: fix.latitude, longitude: fix.longitude, accuracy: fix.accuracy_meters });
});

async function fetchToday(): Promise<TodayResponse | null> {
  try {
    return await apiFetch<TodayResponse>('/api/attendance/today');
  } catch (err) {
    // Logged out: nothing on this device may keep watching location.
    if (err instanceof ApiError && err.status === 401) await stopGeofenceAutoMode();
    return null;
  }
}

/** A fresh fix for a decision. High accuracy: these are the readings that
 *  end or re-open somebody's day, and Balanced (Wi-Fi/cell) fixes indoors can
 *  be hundreds of metres out. They are taken rarely, so GPS costs little here. */
async function currentCoords(): Promise<Fix | null> {
  try {
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    return {
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy: pos.coords.accuracy ?? null,
    };
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

  // Geofencing switched off for this employee → tear the fence down and do
  // nothing else. An exit event that arrives after the switch was thrown must
  // not end anybody's day.
  if (today.location === null) {
    await stopGeofenceAutoMode();
    return;
  }

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
    // The OS's own exit verdict comes from whatever location it had, often a
    // coarse one. Starting the warnings needs a precise fix that puts them
    // clearly outside — no fix, no warning; reconciliation and the tracking
    // fixes pick it up if they really have gone.
    const coords = await currentCoords();
    if (!coords) return;
    const dist = haversineMeters(coords.latitude, coords.longitude, center.latitude, center.longitude);
    if (!confidentlyOutside(dist, coords.accuracy, inner)) return; // jitter — not clearly gone
    // Not an instant clock-out any more: this starts the warning escalation
    // (warning 1 of 4 fires here, at the boundary), and the tracking fixes
    // carry it forward from there.
    await progressFenceExit(coords);
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
  // Same disarm check as the event handler: this runs from the periodic
  // location watch, so it is what actually reaches a phone whose owner has not
  // opened the app since the switch was thrown.
  if (today.location === null) {
    await stopGeofenceAutoMode();
    return;
  }
  if (!today.attendance?.clock_in_utc) {
    await stopGeofenceAutoMode();
    return;
  }

  const onShift = !today.attendance.clock_out_utc;
  // Closed for leaving the site — by this phone, or by the server (which now
  // also recognises this phone's own away-from-site clock-outs, so a flag lost
  // from this phone's storage no longer decides it).
  const closedForLeaving =
    !onShift && ((await autoOutPending()) || today.attendance.auto_clocked_out === true);

  // Closed by hand, by an admin or by the end-of-day settlement: the day is
  // over and nothing here may re-open it. Stand monitoring down, as the live
  // Enter handler does — this is also what lets a phone that was only
  // watching for a return stop its location service.
  if (!onShift && !closedForLeaving) {
    await stopGeofenceAutoMode();
    return;
  }

  const coords = await currentCoords();
  if (!coords) return;
  const dist = haversineMeters(coords.latitude, coords.longitude, fence.latitude, fence.longitude);

  // Approved on-duty suppresses the repair path too, otherwise reconciliation
  // would clock out the very employee the geofence handler just spared.
  if (onShift && confidentlyOutside(dist, coords.accuracy, fence.radius)) {
    if (today.on_duty_now) {
      await resetFenceExitStrikes();
      return;
    }
    // Starts the escalation when the OS Exit event was missed (network blip
    // during the transition), or advances one already running — either way the
    // employee gets the warnings, not a clock-out from nowhere.
    await progressFenceExit(coords);
  } else if (onShift && confidentlyInside(dist, coords.accuracy, fence.radius)) {
    // Back inside with the day still open: the escalation (if any) is over and
    // the day simply never closed.
    await resetFenceExitStrikes(true);
  } else if (
    closedForLeaving &&
    // Accepting only our own closure made this repair path useless in exactly
    // the case it exists for: the OS geofence missing the re-entry after the
    // WATCHDOG ended the day, which is how nearly every one of these days ends.
    //
    // The bare distance, not the forgiving test: the server's clock-in accepts
    // nothing wider, so attempting from further out only collects refusals.
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
  await setState(FENCE_KEY, JSON.stringify({ latitude, longitude, radius: inner }));

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
  await removeState(AUTO_OUT_KEY);
  await removeState(FENCE_KEY);
  // Monitoring is over, so no warning count may survive into the next shift —
  // stale strikes would give tomorrow's first step outside an instant
  // "final warning".
  await setState(EXIT_STRIKE_COUNT_KEY, '0');
  await setState(EXIT_STRIKE_TS_KEY, '0');
}

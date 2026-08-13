import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  ScrollView,
  RefreshControl,
  StatusBar,
  Platform,
  Linking,
  ToastAndroid,
  Alert,
  AppState,
  Modal,
} from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { WebView } from 'react-native-webview';
import * as Location from 'expo-location';
import { apiFetch, logout, ApiError } from '../api/client';
import { getStoredEmployee, StoredEmployee } from '../storage/tokens';
import { saveTodayCache, getTodayCache, clearTodayCache } from '../storage/cache';
import { startBackgroundTracking, stopBackgroundTracking, isTrackingRunning, diagnoseTracking } from '../location/tracking';
import {
  startGeofenceAutoMode,
  stopGeofenceAutoMode,
  reconcileGeofenceAttendance,
  isAutoOutPending,
} from '../location/geofenceAuto';
import { startLocationWatch, stopLocationWatch, checkLocationAndWarn } from '../location/locationWatch';
import { scheduleShiftEndReminders, cancelShiftEndReminders } from '../notifications/shiftReminder';
import {
  scheduleClockInReminders,
  cancelClockInReminders,
  REMINDER_HOUR,
} from '../notifications/clockInReminder';
import { notifyPermissionUpdates, PermissionUpdate } from '../notifications/permissionUpdates';
import { startInboxPoller, stopInboxPoller } from '../notifications/inboxPoller';
import DatePicker from './DatePicker';
import TimePicker from './TimePicker';
import { requestIgnoreBatteryOptimization, openAppSettings } from '../location/batteryOptimization';
import ConsentModal from './ConsentModal';
import { colors } from '../theme';

const CONSENT_KEY = 'location_consent_v1';

// How far down the header has to start to clear the status bar.
//
// The app draws EDGE TO EDGE (edgeToEdgeEnabled=true, and Android 15 enforces
// it), so content begins at y=0 — underneath the clock and the battery icon.
// This was StatusBar.currentHeight alone, which reported too little on the
// phone in the bug report: the title, the logo and Sign out all sat under the
// status bar.
//
// A FLOOR is applied rather than trusting that number. Where currentHeight is
// right (24–48dp on most phones, more with a camera cutout) the real value
// wins; where it under-reports, 36 still clears an ordinary status bar.
//
// react-native-safe-area-context would measure this properly and was tried —
// it compiles C++ through CMake, and the object paths under this project's
// directory exceed the 260-character Windows path limit, so it cannot be built
// on the machine that produces these APKs. Not worth moving the repository for
// one padding value.
const STATUS_BAR_PAD = Platform.OS === 'android'
  ? Math.max(StatusBar.currentHeight ?? 0, 36)
  : 0;
const TZ = 'Asia/Kolkata'; // all dates/times shown in IST, matching the web app

interface TodaySession {
  in_utc: string;
  out_utc: string | null;
  out_kind: string | null;
}

interface TodayAttendance {
  /** The day's first login — never moves; clock_in_utc is the current session. */
  first_clock_in_utc?: string | null;
  clock_in_utc: string | null;
  clock_out_utc: string | null;
  total_minutes: number | null;
  banked_minutes?: number | null;
  status: string | null;
  geofence_status?: string | null;
}

interface HistoryRow {
  work_date: string;
  clock_in_utc: string | null;
  clock_out_utc: string | null;
  total_minutes: number | null;
  permission_minutes?: number | null;
  credited_minutes?: number | null;
  status: string | null;
}

interface Shift {
  name?: string;
  type?: string;
  start_time?: string;
  end_time?: string;
  required_hours?: number;
  /** "Mon".."Sat" — used so the morning reminder skips their day off. */
  working_days?: string[];
}

interface PermissionRow {
  id: number;
  permission_date: string;
  start_time: string;
  end_time: string;
  minutes: number;
  reason: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  review_notes: string | null;
}

interface PermissionBalance {
  month: string;
  monthly_limit_minutes: number;
  used_minutes: number;
  pending_minutes: number;
  remaining_minutes: number;
  max_minutes_per_request: number;
  min_minutes_per_request: number;
}

interface FenceLocation {
  latitude: number;
  longitude: number;
  radius_meters: number;
}

function minutesToHours(m: number | null): string {
  if (m == null) return '-';
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h > 0 ? `${h}h ${mm}m` : `${mm}m`;
}

function timeOnly(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '-'
    : d.toLocaleTimeString('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: true }).toLowerCase();
}

// IST calendar date (YYYY-MM-DD) — matches the server's getWorkDateIST().
/**
 * The WORK date an instant belongs to.
 *
 * The work day turns over at WORK_DAY_START_HOUR (07:00 IST), not midnight, so
 * a night that runs past 00:00 still belongs to the day it started on. This has
 * to match lib/attendance.getWorkDateIST() on the server exactly — if the phone
 * called it a new day at midnight it would cache the wrong day's attendance and
 * show a blank card to someone who is still on shift.
 */
const WORK_DAY_START_HOUR = 7;

function istYmd(date: Date): string {
  const shifted = new Date(date.getTime() - WORK_DAY_START_HOUR * 60 * 60 * 1000);
  return shifted.toLocaleDateString('en-CA', { timeZone: TZ });
}

/** The plain IST calendar date, for things that are about the wall clock
 *  rather than the work day (e.g. the default date on a permission form). */
function istCalendarYmd(date: Date): string {
  return date.toLocaleDateString('en-CA', { timeZone: TZ });
}

// Current hour 0–23 in IST (for the post-7pm clock-out reminder).
function istHour(date: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(date),
  );
}

function dateDMY(ymdStr: string): string {
  const [y, m, d] = ymdStr.split('-');
  return d && m && y ? `${d}-${m}-${y}` : ymdStr;
}

function initials(name?: string | null): string {
  if (!name) return '--';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '--';
}

// "09:30" → "9:30 am", for displaying permission windows.
function clock12(t: string): string {
  const [h, m] = t.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return t;
  const suffix = h < 12 ? 'am' : 'pm';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** "HH:MM" -> minutes since midnight, or null when malformed. */
function clockMinutes(value: string): number | null {
  const m = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Minutes between two "HH:MM" wall-clock times, or null when not a forward
 *  span. Used for the permission form, where a backwards window is invalid. */
function spanMinutes(start: string, end: string): number | null {
  const s = clockMinutes(start);
  const e = clockMinutes(end);
  if (s === null || e === null) return null;
  const diff = e - s;
  return diff > 0 ? diff : null;
}

/** Minutes the shift asks for — mirrors lib/permissions.requiredMinutesForShift,
 *  including a shift that runs past midnight (22:00-06:00 is 8h, not a fallback
 *  9h). Keeping the two in step matters because this drives the live credited
 *  figure on screen while the server computes the stored one. */
function requiredMinutes(shift: Shift | null): number {
  if (shift?.required_hours != null && Number(shift.required_hours) > 0) {
    return Math.round(Number(shift.required_hours) * 60);
  }
  if (shift?.start_time && shift?.end_time) {
    const s = clockMinutes(shift.start_time.slice(0, 5));
    const e = clockMinutes(shift.end_time.slice(0, 5));
    if (s !== null && e !== null) {
      const span = ((e - s) % 1440 + 1440) % 1440;
      if (span > 0) return span;
    }
  }
  // No schedule at all — standard 9-hour day.
  return 9 * 60;
}

// Matches the web: flexible shifts show "<name> - N hours required",
// fixed shifts show "<name> - HH:MM to HH:MM".
function scheduleLine(shift: Shift | null): string | null {
  if (!shift) return null;
  if (shift.type === 'flexible') {
    return `${shift.name ?? 'Flexible Shift'} - ${shift.required_hours ?? 9} hours required`;
  }
  const start = shift.start_time?.slice(0, 5) ?? '--:--';
  const end = shift.end_time?.slice(0, 5) ?? '--:--';
  return `${shift.name ?? 'Shift'} - ${start} to ${end}`;
}

function toast(msg: string): void {
  if (Platform.OS === 'android') ToastAndroid.show(msg, ToastAndroid.SHORT);
}

export interface FixPayload {
  latitude: number;
  longitude: number;
  /** Android reports when a fix came from a mock-location provider. */
  is_mocked?: boolean;
  accuracy_m?: number | null;
}

async function getCoords(): Promise<FixPayload> {
  const perm = await Location.requestForegroundPermissionsAsync();
  if (perm.status !== 'granted') throw new Error('Location permission is required.');
  // Clock-in must feel instant, and a fresh GPS lock is the one thing that
  // cannot be made instant — cold, indoors, it takes 5–30 seconds, and it has
  // NO timeout, which is exactly the "clock in takes time" complaint. So:
  //
  //   1. a cached fix from the last 2 minutes — instant, covers mid-shift;
  //   2. else a fresh fix RACED against 8 seconds;
  //   3. on timeout, any fix from the last 10 minutes — its own accuracy is
  //      sent along, so the server judges it honestly;
  //   4. only with no cached fix at all do we keep waiting for the lock —
  //      there is genuinely nothing else to offer.
  const last = await Location.getLastKnownPositionAsync({ maxAge: 120_000, requiredAccuracy: 250 });
  let pos = last;
  if (!pos) {
    const fresh = Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    pos = await Promise.race([
      fresh,
      new Promise<null>(resolve => setTimeout(() => resolve(null), 8_000)),
    ]);
    if (!pos) {
      pos = (await Location.getLastKnownPositionAsync({ maxAge: 600_000 })) ?? (await fresh);
    }
  }
  // `mocked` is set by Android when the fix came from a fake-GPS app. Pass it
  // through rather than deciding here — the server records the attempt.
  return {
    latitude: pos.coords.latitude,
    longitude: pos.coords.longitude,
    is_mocked: (pos as { mocked?: boolean }).mocked === true,
    accuracy_m: pos.coords.accuracy ?? null,
  };
}

export default function DashboardScreen({ onLogout }: { onLogout: () => void }) {
  const [employee, setEmployee] = useState<StoredEmployee | null>(null);
  const [attendance, setAttendance] = useState<TodayAttendance | null>(null);
  const [shift, setShift] = useState<Shift | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tracking, setTracking] = useState(false);
  // The reason tracking is not running, in the employee's words. Thrown away
  // before, which left "tap to fix" offering battery settings for problems
  // battery settings cannot fix.
  const [trackingIssue, setTrackingIssue] = useState<string | null>(null);
  const [trackingEnabled, setTrackingEnabled] = useState(true); // admin per-employee toggle
  const [multiSession, setMultiSession] = useState(false); // plant: several clock-ins per day
  const [fenceLocation, setFenceLocation] = useState<FenceLocation | null>(null);
  const [todaySessions, setTodaySessions] = useState<TodaySession[]>([]);
  // Google Play prominent-disclosure consent. null = not yet loaded.
  const [hasConsent, setHasConsent] = useState<boolean | null>(null);
  const [consentVisible, setConsentVisible] = useState(false);
  // Which action the consent modal should continue with after acceptance.
  const consentActionRef = useRef<'in' | 'out'>('in');
  // True once /today has actually answered — effects that stop/start the
  // geofence auto mode must not act on the initial empty state.
  const [todayLoaded, setTodayLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(new Date());
  const [liveCoords, setLiveCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [dailyUpdate, setDailyUpdate] = useState('');
  const [savingUpdate, setSavingUpdate] = useState(false);

  // Permission hours — short paid time off inside the working day.
  const [permissions, setPermissions] = useState<PermissionRow[]>([]);
  const [permissionBalance, setPermissionBalance] = useState<PermissionBalance | null>(null);
  const [todayPermissionMinutes, setTodayPermissionMinutes] = useState(0);
  const [permFormOpen, setPermFormOpen] = useState(false);
  const [permDate, setPermDate] = useState(istCalendarYmd(new Date()));
  const [permDateOpen, setPermDateOpen] = useState(false);
  // The server refuses dates more than 3 days back (PERMISSION_MAX_PAST_DAYS),
  // so the calendar greys those out instead of letting someone pick a day the
  // submit will bounce.
  const permMinDate = istCalendarYmd(new Date(Date.now() - 3 * 86_400_000));
  // "Mon, 11 Aug" — what a person calls a day. Anchored to noon so the label
  // cannot slip a day in any timezone.
  const permDateLabel = (() => {
    const d = new Date(`${permDate}T12:00:00Z`);
    return Number.isNaN(d.getTime())
      ? permDate
      : d.toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  })();
  // Times are PICKED on a clock face, not typed. They used to be a text field
  // plus an AM/PM toggle, propped up by a rule that guessed PM for an hour of
  // 1–7 — a guess that existed only because typing let people enter times they
  // did not mean. A dial cannot produce "25:99", cannot be left half-finished,
  // and is how a time is set on a phone everywhere else.
  //
  // Held as 24-hour "HH:MM", which is what the server takes; the dial is the
  // only thing that speaks AM/PM.
  const [permStart24, setPermStart24] = useState<string | null>(null);
  const [permEnd24, setPermEnd24] = useState<string | null>(null);
  const [permTimeOpen, setPermTimeOpen] = useState<'start' | 'end' | null>(null);

  /** "14:30" → "2:30 PM" for the button face. */
  const timeLabel = (hhmm: string | null): string => {
    if (!hhmm) return 'Tap to choose';
    const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
    if (!m) return 'Tap to choose';
    const h = Number(m[1]);
    const suffix = h < 12 ? 'AM' : 'PM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${m[2]} ${suffix}`;
  };
  const [permReason, setPermReason] = useState('');
  const [permError, setPermError] = useState<string | null>(null);
  const [permBusy, setPermBusy] = useState(false);

  const clockedIn = !!attendance?.clock_in_utc;
  const clockedOut = !!attendance?.clock_out_utc;
  const today = istYmd(now);
  const showClockOutReminder = clockedIn && !clockedOut && istHour(now) >= 19;

  // Hours ticks live while clocked in (matches the web). Multi-session (plant)
  // employees carry minutes banked from earlier sessions today.
  const liveWorkedMinutes = useMemo(() => {
    if (!attendance?.clock_in_utc || attendance?.clock_out_utc) return attendance?.total_minutes ?? null;
    const ms = new Date(attendance.clock_in_utc).getTime();
    if (Number.isNaN(ms)) return attendance?.total_minutes ?? null;
    return Number(attendance?.banked_minutes ?? 0) + Math.max(0, Math.floor((now.getTime() - ms) / 60_000));
  }, [attendance, now]);

  // Approved permission tops the day back up to the shift length — never past
  // it, so hours are not double-counted when the employee stayed clocked in
  // through the permission window. Mirrors lib/permissions.creditedMinutes.
  const liveCreditedMinutes = useMemo(() => {
    if (liveWorkedMinutes == null) return null;
    if (todayPermissionMinutes <= 0) return liveWorkedMinutes;
    return Math.min(
      liveWorkedMinutes + todayPermissionMinutes,
      Math.max(liveWorkedMinutes, requiredMinutes(shift)),
    );
  }, [liveWorkedMinutes, todayPermissionMinutes, shift]);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const loadToday = useCallback(async () => {
    try {
      const data = await apiFetch<{
        attendance: TodayAttendance | null;
        schedule: { shift?: Shift; location?: { latitude: number | string; longitude: number | string; radius_meters: number | string } | null } | null;
        multi_session?: boolean;
        permission_minutes?: number;
        permission_balance?: PermissionBalance;
        permission_updates?: PermissionUpdate[];
        today_sessions?: TodaySession[];
      }>('/api/attendance/today');
      setTodaySessions(data.today_sessions ?? []);
      // Announce approved/rejected permission decisions — deduped internally,
      // so calling on every refresh is safe.
      void notifyPermissionUpdates(data.permission_updates);
      setAttendance(data.attendance);
      setShift(data.schedule?.shift ?? null);
      setMultiSession(data.multi_session === true);
      setTodayPermissionMinutes(Number(data.permission_minutes ?? 0));
      if (data.permission_balance) setPermissionBalance(data.permission_balance);
      const loc = data.schedule?.location;
      setFenceLocation(
        loc
          ? {
              latitude: Number(loc.latitude),
              longitude: Number(loc.longitude),
              radius_meters: Number(loc.radius_meters) || 200,
            }
          : null,
      );
      saveTodayCache(istYmd(new Date()), data.attendance);
      setTodayLoaded(true);
    } catch (e) {
      if (e instanceof Error && e.message.includes('log in again')) onLogout();
    }
  }, [onLogout]);

  // Whether the admin has enabled live tracking for THIS employee.
  const loadTrackingEnabled = useCallback(async () => {
    try {
      const data = await apiFetch<{ enabled: boolean }>('/api/live-tracking/status');
      setTrackingEnabled(data.enabled !== false);
    } catch {
      /* default to enabled if the check fails */
    }
  }, []);

  const loadHistory = useCallback(async () => {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 6);
    try {
      const data = await apiFetch<{ records: HistoryRow[] }>(
        `/api/attendance?from_date=${istYmd(from)}&to_date=${istYmd(to)}&limit=7&page=1`,
      );
      setHistory(data.records ?? []);
    } catch {
      /* non-fatal */
    }
  }, []);

  const loadDailyUpdate = useCallback(async () => {
    const d = istYmd(new Date());
    try {
      const data = await apiFetch<{ updates: Array<{ update_text: string }> }>(
        `/api/daily-updates?from_date=${d}&to_date=${d}&limit=1&page=1`,
      );
      setDailyUpdate(data.updates?.[0]?.update_text ?? '');
    } catch {
      /* non-fatal */
    }
  }, []);

  // This month's permission requests plus the remaining entitlement.
  const loadPermissions = useCallback(async () => {
    const monthStart = `${istYmd(new Date()).slice(0, 7)}-01`;
    try {
      const [list, balance] = await Promise.all([
        apiFetch<{ permissions: PermissionRow[] }>(
          `/api/permissions?from_date=${monthStart}&limit=5&page=1`,
        ),
        apiFetch<PermissionBalance>('/api/permissions/balance'),
      ]);
      setPermissions(list.permissions ?? []);
      setPermissionBalance(balance);
    } catch {
      /* non-fatal — the card just shows what it has */
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      const [emp, cached, running] = await Promise.all([
        getStoredEmployee(),
        getTodayCache<TodayAttendance | null>(istYmd(new Date())),
        isTrackingRunning(),
      ]);
      // Consent: stored flag, or grandfathered for existing installs that
      // already granted background location before this screen existed.
      let consent = (await SecureStore.getItemAsync(CONSENT_KEY)) === '1';
      if (!consent) {
        const bg = await Location.getBackgroundPermissionsAsync().catch(() => null);
        if (bg?.granted) {
          consent = true;
          await SecureStore.setItemAsync(CONSENT_KEY, '1');
        }
      }
      if (!active) return;
      setHasConsent(consent);
      setEmployee(emp);
      if (cached !== null) setAttendance(cached);
      setTracking(running);
      setLoading(false);
      loadToday();
      loadHistory();
      loadDailyUpdate();
      loadTrackingEnabled();
      loadPermissions();
    })();
    return () => {
      active = false;
    };
  }, [loadToday, loadHistory, loadDailyUpdate, loadTrackingEnabled, loadPermissions]);

  // Keep the live map updated while clocked in. Also auto-resume background
  // tracking — when the app is reopened mid-shift, the OS may have stopped the
  // service, so we restart it here so "tracking is on" and points keep flowing.
  useEffect(() => {
    if (loading) return; // don't touch the service before cached state arrives
    // Admin disabled tracking for this employee → make sure nothing is
    // running, including a location watch registered on an earlier day.
    if (!trackingEnabled) {
      void stopBackgroundTracking();
      void stopLocationWatch();
      setTracking(false);
      setLiveCoords(null);
      return;
    }
    if (!clockedIn || clockedOut) {
      // Not on shift: kill any leftover service from a previous day (e.g. the
      // employee never clocked out and attendance was auto-closed) so the
      // phone doesn't keep reporting location while they are not logged in.
      void stopBackgroundTracking();
      setTracking(false);
      setLiveCoords(null);
      return;
    }
    // No auto-start (or map polling) before the disclosure has been accepted.
    // No auto-start before the disclosure is accepted. Say so on the pill —
    // this branch returns without starting anything, and the pill's generic
    // "off" plus a battery dialog could never fix a missing consent flag. A
    // silent dead end is how an employee ends up with perfect settings and no
    // tracking.
    if (hasConsent !== true) {
      setTracking(false);
      setTrackingIssue('Location consent not accepted');
      return;
    }
    let active = true;

    const ensureTracking = async () => {
      try {
        const running = await isTrackingRunning();
        if (!running) {
          await startBackgroundTracking();
        }
        if (active) { setTracking(true); setTrackingIssue(null); }
      } catch (e) {
        // startBackgroundTracking throws a precise, actionable message — keep
        // it. Discarding it is what made the fix helper useless.
        if (active) {
          setTracking(false);
          setTrackingIssue(e instanceof Error ? e.message : null);
        }
      }
    };

    const fetchPos = async () => {
      try {
        const perm = await Location.getForegroundPermissionsAsync();
        if (perm.status !== 'granted') return;
        // Last-known fix is instant → the map shows immediately.
        const last = await Location.getLastKnownPositionAsync({ maxAge: 120_000 });
        if (last && active) setLiveCoords({ lat: last.coords.latitude, lng: last.coords.longitude });
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (active) setLiveCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      } catch {
        /* ignore transient GPS misses */
      }
    };

    ensureTracking();
    fetchPos();
    // Location-off enforcement: background check every ~15 min plus a fast
    // in-app check every minute while the dashboard is open (strike spacing
    // is enforced inside checkLocationAndWarn, so this cannot spam).
    void startLocationWatch();
    // Inbox heartbeat: announces permission decisions with the app closed.
    // Independent of shift/tracking state — it dies only at logout.
    void startInboxPoller();
    void checkLocationAndWarn();
    const watchId = setInterval(() => void checkLocationAndWarn(), 60_000);
    const id = setInterval(fetchPos, 20_000);
    // When the app returns to the foreground mid-shift, the OS may have killed
    // the tracking service (battery saver, task swipe) — restart it right away
    // instead of waiting for the user to notice the "tracking is off" pill.
    const appState = AppState.addEventListener('change', state => {
      if (state === 'active') {
        // Refresh server truth first — a background auto clock-out may have
        // closed the day while this screen still shows an open shift.
        loadToday();
        ensureTracking();
        fetchPos();
        // Check location health straight away rather than waiting up to a
        // minute for the interval. Android throttles the background task hard,
        // so opening the app is often the first reliable chance to notice that
        // location has been off — and to deliver the warning for it.
        void checkLocationAndWarn();
      }
    });
    return () => {
      active = false;
      clearInterval(id);
      clearInterval(watchId);
      appState.remove();
    };
  }, [clockedIn, clockedOut, trackingEnabled, loading, hasConsent, loadToday]);

  const refresh = useCallback(() => {
    loadToday();
    loadHistory();
    loadDailyUpdate();
    loadTrackingEnabled();
    loadPermissions();
  }, [loadToday, loadHistory, loadDailyUpdate, loadTrackingEnabled, loadPermissions]);

  // OS-level "shift over, please clock out" notifications — they fire on the
  // lock screen even with the app closed, exactly 9 hours after clock-in.
  // Reopening the app mid-shift (or reinstalling) re-schedules them from the
  // same clock-in time; clocking out cancels them.
  useEffect(() => {
    if (loading) return;
    if (clockedIn && !clockedOut && attendance?.clock_in_utc) {
      void scheduleShiftEndReminders(attendance.clock_in_utc);
    } else {
      void cancelShiftEndReminders();
    }
  }, [attendance?.clock_in_utc, clockedIn, clockedOut, loading]);

  // MORNING REMINDER — "you have not clocked in yet", each working day.
  //
  // Armed whenever they are not currently on the clock and dropped the moment
  // they are, so nobody is nagged about a day they have already started. It is
  // re-armed on the next app open, which is also what puts tomorrow's back
  // after today's clock-out.
  //
  // Their own working days are passed through so it stays quiet on their day
  // off; with no roster on the phone it reminds every morning, which is the
  // honest default when there is nothing to read.
  useEffect(() => {
    if (loading || hasConsent !== true) return;
    if (clockedIn && !clockedOut) {
      void cancelClockInReminders();
    } else {
      void scheduleClockInReminders(shift?.working_days ?? null);
    }
  }, [clockedIn, clockedOut, loading, hasConsent, shift?.working_days]);

  // Auto attendance: after the day's first MANUAL clock-in the phone watches
  // the work-site geofence. LEAVING clocks out — for everyone with a fence, so
  // nobody stays on the clock after walking off site. RETURNING clocks back in
  // only for plant staff, whose day may legitimately have several sessions;
  // that rule lives in the geofence task itself, so it is safe to run the
  // watch for single-session employees too.
  //
  // Gated on todayLoaded: acting on the initial empty state would stop
  // monitoring on every app open, permanently killing re-entry auto clock-in
  // during a break. While auto-clocked-out (our own pending flag), monitoring
  // is re-ensured and missed events are reconciled.
  useEffect(() => {
    if (loading || hasConsent !== true || !todayLoaded) return;
    if (!fenceLocation || !trackingEnabled) {
      void stopGeofenceAutoMode();
      return;
    }
    if (clockedIn && !clockedOut) {
      void (async () => {
        await startGeofenceAutoMode(
          fenceLocation.latitude,
          fenceLocation.longitude,
          fenceLocation.radius_meters,
        );
        await reconcileGeofenceAttendance().catch(() => {});
      })();
    } else if (clockedIn && clockedOut) {
      void (async () => {
        if (await isAutoOutPending()) {
          await startGeofenceAutoMode(
            fenceLocation.latitude,
            fenceLocation.longitude,
            fenceLocation.radius_meters,
          );
          await reconcileGeofenceAttendance().catch(() => {});
        }
      })();
    }
  }, [clockedIn, clockedOut, multiSession, fenceLocation, trackingEnabled, loading, hasConsent, todayLoaded]);

  // Consent must precede ANY location access (Google Play prominent
  // disclosure). Clock-in itself needs coordinates, so without consent we show
  // the notice instead of proceeding.
  const handleClockIn = async () => {
    if (!hasConsent) {
      consentActionRef.current = 'in';
      setConsentVisible(true);
      return;
    }
    await performClockIn();
  };

  const acceptConsent = async () => {
    await SecureStore.setItemAsync(CONSENT_KEY, '1');
    setHasConsent(true);
    setConsentVisible(false);
    if (consentActionRef.current === 'in') await performClockIn();
    else await performClockOut();
  };

  const performClockIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const coords = await getCoords();
      await apiFetch('/api/attendance/clock-in', {
        method: 'POST',
        body: coords,
      });
      // Only start location tracking if the admin enabled it for this employee.
      if (trackingEnabled) {
        await startBackgroundTracking();
        setTracking(true);
        // One-time: ask the OS to keep tracking alive in the background.
        const prompted = await SecureStore.getItemAsync('battery_prompted');
        if (!prompted) {
          await SecureStore.setItemAsync('battery_prompted', '1');
          Alert.alert(
            'Keep tracking running',
            'So your location keeps recording while the screen is off, tap "Allow" on the next screen.',
            [{ text: 'OK', onPress: () => { void requestIgnoreBatteryOptimization(); } }],
          );
        }
      }
      refresh();
      toast('Clocked in successfully ✓');
    } catch (e) {
      // Away from the work site — refused, with no way through it from here.
      // A reason box used to open at this point and let them in; it is gone,
      // because it was being used to step straight back onto the clock from
      // the spot the fence had just closed the day at.
      //
      // Shown as an alert rather than a toast because it asks them to DO
      // something — walk back to the site — and a toast is gone before they
      // have finished reading it. The server's message carries the site, the
      // radius and how far out they are, so it says how far there is to walk.
      if (e instanceof ApiError
          && (e.code === 'outside_fence' || e.code === 'fence_closed_day')) {
        setBusy(false);
        Alert.alert(
          e.code === 'fence_closed_day'
            ? 'Come back to the site to clock in'
            : 'You are not at your work site',
          `${e.message}

If you are working away from the site today, ask your `
            + 'manager to approve on-duty work for you.',
          [{ text: 'OK' }],
        );
        return;
      }
      const msg = e instanceof Error ? e.message : 'Clock-in failed.';
      setError(msg);
      toast(msg);
    } finally {
      setBusy(false);
    }
  };

  // Consent must precede ALL location access — clock-out also reads GPS, so a
  // restored session on a fresh install goes through the notice first too.
  const handleClockOut = async () => {
    if (!hasConsent) {
      consentActionRef.current = 'out';
      setConsentVisible(true);
      return;
    }
    await performClockOut();
  };

  const performClockOut = async () => {
    setBusy(true);
    setError(null);
    try {
      const coords = await getCoords();
      await apiFetch('/api/attendance/clock-out', { method: 'POST', body: coords });
      await stopBackgroundTracking();
      // Manual clock-out means done for the day — end geofence auto mode and
      // the location-off watchdog.
      await stopGeofenceAutoMode();
      await stopLocationWatch();
      setTracking(false);
      refresh();
      toast('Clocked out successfully ✓');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Clock-out failed.';
      setError(msg);
      toast(msg);
    } finally {
      setBusy(false);
    }
  };

  const handleSaveUpdate = async () => {
    if (!dailyUpdate.trim()) {
      toast('Write something first');
      return;
    }
    setSavingUpdate(true);
    try {
      await apiFetch('/api/daily-updates', {
        method: 'POST',
        body: { work_date: today, update_text: dailyUpdate.trim() },
      });
      toast('Daily update saved ✓');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to save update');
    } finally {
      setSavingUpdate(false);
    }
  };

  // --- Permission hours ------------------------------------------------------

  const handleApplyPermission = async () => {
    setPermError(null);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(permDate.trim())) {
      setPermError('Date must be YYYY-MM-DD');
      return;
    }
    if (!permStart24 || !permEnd24) {
      setPermError('Choose a From and a To time');
      return;
    }
    const minutes = spanMinutes(permStart24, permEnd24);
    if (minutes === null) {
      setPermError('The end time must be after the start time');
      return;
    }
    if (permissionBalance) {
      if (minutes < permissionBalance.min_minutes_per_request) {
        setPermError(`Permission must be at least ${minutesToHours(permissionBalance.min_minutes_per_request)}`);
        return;
      }
      if (minutes > permissionBalance.max_minutes_per_request) {
        setPermError(`A single permission cannot exceed ${minutesToHours(permissionBalance.max_minutes_per_request)}`);
        return;
      }
      if (minutes > permissionBalance.remaining_minutes) {
        setPermError(
          permissionBalance.remaining_minutes <= 0
            ? "This month's permission hours are used up"
            : `Only ${minutesToHours(permissionBalance.remaining_minutes)} left this month`,
        );
        return;
      }
    }

    setPermBusy(true);
    try {
      await apiFetch('/api/permissions', {
        method: 'POST',
        body: {
          permission_date: permDate.trim(),
          start_time: permStart24,
          end_time: permEnd24,
          reason: permReason.trim() || null,
        },
      });
      setPermFormOpen(false);
      setPermStart24(null);
      setPermEnd24(null);
      setPermReason('');
      toast('Permission sent for approval ✓');
      await loadPermissions();
    } catch (e) {
      setPermError(e instanceof Error ? e.message : 'Failed to apply');
    } finally {
      setPermBusy(false);
    }
  };

  const handleCancelPermission = (row: PermissionRow) => {
    Alert.alert(
      'Withdraw request',
      `Cancel the permission on ${dateDMY(row.permission_date)} (${clock12(row.start_time.slice(0, 5))} – ${clock12(row.end_time.slice(0, 5))})?`,
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Withdraw',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await apiFetch(`/api/permissions/${row.id}`, {
                  method: 'PATCH',
                  body: { action: 'cancel' },
                });
                toast('Request withdrawn');
                await loadPermissions();
              } catch (e) {
                toast(e instanceof Error ? e.message : 'Failed to cancel');
              }
            })();
          },
        },
      ],
    );
  };

  const handleLogout = async () => {
    await stopBackgroundTracking().catch(() => {});
    await stopGeofenceAutoMode().catch(() => {});
    await stopLocationWatch().catch(() => {});
    await stopInboxPoller().catch(() => {});
    await cancelShiftEndReminders();
    await clearTodayCache();
    await logout();
    onLogout();
  };

  // Shown when tracking is off. Diagnoses the ACTUAL blocker and offers the
  // one action that clears it — the old version offered battery settings for
  // everything, so an employee whose real problem was the location permission
  // could grant background activity all day and see the same dialog return.
  const fixTracking = async () => {
    // Consent first: nothing else can start without it, and no settings screen
    // can grant it — it is a tap inside this app.
    if (hasConsent !== true) {
      consentActionRef.current = 'in';
      setConsentVisible(true);
      return;
    }
    const { blocker, message } = await diagnoseTracking();

    // Nothing the app can see is wrong: try starting the service right now. If
    // it starts, there was nothing to fix and saying so beats another dialog.
    if (blocker === null) {
      try {
        await startBackgroundTracking();
        setTracking(true);
        setTrackingIssue(null);
        toast('Tracking started ✓');
        return;
      } catch (e) {
        setTrackingIssue(e instanceof Error ? e.message : null);
      }
    }

    const retryAfter = async () => {
      // Give the settings screen a moment to apply, then re-check so the pill
      // turns green without the employee wondering whether it worked.
      setTimeout(() => {
        void (async () => {
          const again = await diagnoseTracking();
          if (again.blocker === null) {
            try {
              await startBackgroundTracking();
              setTracking(true);
              setTrackingIssue(null);
              toast('Tracking started ✓');
            } catch { /* the pill still shows the reason */ }
          }
        })();
      }, 1500);
    };

    if (blocker === 'services') {
      Alert.alert('Turn on location', `${message} Switch GPS on from the quick settings, then tap the pill again.`,
        [{ text: 'OK' }]);
      return;
    }
    if (blocker === 'notifications') {
      Alert.alert(
        'Allow notifications',
        `${message}\n\nAndroid keeps the tracking service alive only while its notification can be shown. Turn Notifications on for this app.`,
        [
          { text: 'Open app settings', onPress: () => { void openAppSettings(); void retryAfter(); } },
          { text: 'Cancel', style: 'cancel' },
        ],
      );
      return;
    }
    if (blocker === 'foreground' || blocker === 'precise' || blocker === 'background') {
      Alert.alert(
        'Location permission needed',
        `${message}\n\nOpen Permissions → Location and choose "Allow all the time" with Precise turned on.`,
        [
          {
            text: 'Fix permission',
            onPress: () => {
              void (async () => {
                // Ask directly first — on Android 11+ the OS itself sends the
                // employee to the right settings page for "all the time".
                await Location.requestForegroundPermissionsAsync().catch(() => null);
                await Location.requestBackgroundPermissionsAsync().catch(() => null);
                await retryAfter();
              })();
            },
          },
          { text: 'Open app settings', onPress: () => { void openAppSettings(); void retryAfter(); } },
          { text: 'Cancel', style: 'cancel' },
        ],
      );
      return;
    }

    // Permissions are all in order — this is battery management.
    Alert.alert(
      'Allow background activity',
      `${message}\n\nAllow it to run in the background. On Oppo, Realme, Vivo and Xiaomi phones also turn on "Auto-start" and set Battery to "Don't optimise" for this app.`,
      [
        { text: 'Allow background', onPress: () => { void requestIgnoreBatteryOptimization(); void retryAfter(); } },
        { text: 'Open app settings', onPress: () => { void openAppSettings(); void retryAfter(); } },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  const dateStr = now.toLocaleDateString('en-IN', {
    timeZone: TZ,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const timeStr = now
    .toLocaleTimeString('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })
    .toLowerCase();

  return (
    <View style={styles.container}>
      <ConsentModal
        visible={consentVisible}
        onAccept={acceptConsent}
        onDecline={() => {
          setConsentVisible(false);
          setError('Location consent is required to mark attendance.');
        }}
      />

      <View style={styles.header}>
        <View style={styles.brandRow}>
          <View style={styles.logo}>
            <Text style={styles.logoCheck}>✓</Text>
          </View>
          <Text style={styles.brandName}>Attendance</Text>
        </View>
        <View style={styles.headerRight}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials(employee?.name)}</Text>
          </View>
          <TouchableOpacity onPress={handleLogout}>
            <Text style={styles.signOut}>Sign out</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} tintColor={colors.textMuted} />}
      >
        <Text style={styles.hello}>Hello, {employee?.name?.split(' ')[0] ?? 'there'}</Text>
        <Text style={styles.date}>{dateStr}</Text>
        <Text style={styles.clock}>{timeStr}</Text>

        {/* How far from the work site, refreshed with the 20s position poll.
            When the fence is armed, being outside means clock-in will be
            REFUSED — say so before they tap, not after, and say how far there
            is to walk. It used to promise a reason box; there is no longer one
            to promise. */}
        {fenceLocation && liveCoords && (() => {
          const toRad = (d: number) => (d * Math.PI) / 180;
          const dLat = toRad(fenceLocation.latitude - liveCoords.lat);
          const dLng = toRad(fenceLocation.longitude - liveCoords.lng);
          const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(liveCoords.lat)) * Math.cos(toRad(fenceLocation.latitude)) * Math.sin(dLng / 2) ** 2;
          const dist = Math.round(6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
          const inside = dist <= fenceLocation.radius_meters;
          const distText = dist >= 1000 ? `${(dist / 1000).toFixed(1)} km` : `${dist} m`;
          return (
            <View style={[styles.fenceBanner, inside ? styles.fenceBannerIn : styles.fenceBannerOut]}>
              <Text style={[styles.fenceBannerText, inside ? styles.fenceBannerTextIn : styles.fenceBannerTextOut]}>
                {inside
                  ? `✓ At your work site — ${distText} from centre (limit ${fenceLocation.radius_meters} m)`
                  : `⚠ Away from your work site — ${distText} away. You cannot clock in from here.`}
              </Text>
            </View>
          );
        })()}

        {/* TODAY */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>TODAY</Text>
          <View style={styles.statsRow}>
            <View style={styles.statCol}>
              <Text style={styles.statLabel}>Clock In</Text>
              <Text style={styles.statValue}>{timeOnly(attendance?.first_clock_in_utc ?? attendance?.clock_in_utc ?? null)}</Text>
            </View>
            <View style={styles.statCol}>
              <Text style={styles.statLabel}>Clock Out</Text>
              <Text style={styles.statValue}>{timeOnly(attendance?.clock_out_utc ?? null)}</Text>
            </View>
            <View style={styles.statCol}>
              <Text style={styles.statLabel}>Hours</Text>
              <Text style={styles.statValue}>{minutesToHours(liveCreditedMinutes)}</Text>
            </View>
          </View>

          {/* EVERY clock-in and clock-out of the day, always — not only once
              there are two of them.

              It used to appear at length > 1, so the first session of the day
              was invisible and the list arrived out of nowhere on the second.
              The row above shows the day's FIRST in and LAST out, which is a
              summary; this is the record, and the record is the point.

              Falls back to the attendance row when the audit log has no
              sessions to pair (an older day, or entries that failed to write):
              a clock-in that happened must never show an empty list. */}
          {(() => {
            const sessions = todaySessions.length
              ? todaySessions
              : attendance?.clock_in_utc
                ? [{
                    in_utc: attendance.first_clock_in_utc ?? attendance.clock_in_utc,
                    out_utc: attendance.clock_out_utc ?? null,
                    out_kind: null as string | null,
                  }]
                : [];
            if (!sessions.length) return null;
            // Just the times: in to out, one line each. No numbering and no
            // reason the session ended — asked for plainly, and the times are
            // what anyone is checking here anyway. The reason a day was closed
            // by the fence still lives on the admin's Notifications page and in
            // the day-wise report.
            return (
              <View style={styles.sessionList}>
                {sessions.map((sess, i) => (
                  <Text key={`${sess.in_utc}-${i}`} style={styles.sessionRow}>
                    <Text style={styles.sessionTime}>{timeOnly(sess.in_utc)}</Text>
                    {'  to  '}
                    <Text style={styles.sessionTime}>
                      {sess.out_utc ? timeOnly(sess.out_utc) : 'still in'}
                    </Text>
                  </Text>
                ))}
              </View>
            );
          })()}

          {todayPermissionMinutes > 0 && (
            <Text style={styles.permissionNote}>
              Includes approved permission: {minutesToHours(liveWorkedMinutes)} worked +{' '}
              {minutesToHours(todayPermissionMinutes)} permission
            </Text>
          )}

          {scheduleLine(shift) && <Text style={styles.schedule}>{scheduleLine(shift)}</Text>}

          {attendance?.status && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{attendance.status}</Text>
            </View>
          )}

          {showClockOutReminder && (
            <View style={styles.warnBox}>
              <Text style={styles.warnTitle}>⏰ Please clock out</Text>
              <Text style={styles.warnText}>
                Your shift has ended. Clock out before midnight — otherwise it will be auto-closed with your
                standard 9-hour shift.
              </Text>
            </View>
          )}

          {error && (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          {(!clockedIn || (clockedOut && multiSession)) && (
            <TouchableOpacity style={styles.action} onPress={handleClockIn} disabled={busy} activeOpacity={0.8}>
              {busy ? <ActivityIndicator color={colors.text} /> : (
                <Text style={styles.actionText}>
                  {clockedOut ? '→  Clock In Again' : '→  Clock In'}
                </Text>
              )}
            </TouchableOpacity>
          )}
          {/* Say the reminder exists. A notification nobody was told to expect
              reads as the app misbehaving the first time it appears. */}
          {!clockedIn && (
            <Text style={styles.reminderNote}>
              We&apos;ll remind you at {REMINDER_HOUR > 12 ? REMINDER_HOUR - 12 : REMINDER_HOUR}
              :00 {REMINDER_HOUR >= 12 ? 'pm' : 'am'} if you have not clocked in.
            </Text>
          )}
          {clockedIn && !clockedOut && (
            <TouchableOpacity style={styles.action} onPress={handleClockOut} disabled={busy} activeOpacity={0.8}>
              {busy ? <ActivityIndicator color={colors.text} /> : <Text style={styles.actionText}>←  Clock Out</Text>}
            </TouchableOpacity>
          )}
          {clockedIn && clockedOut && !multiSession && <Text style={styles.done}>Attendance completed for today ✓</Text>}
        </View>

        {/* Geofence warning */}
        {attendance?.geofence_status === 'outside' && (
          <View style={[styles.warnBox, { marginTop: 16 }]}>
            <Text style={styles.warnText}>⚠️ You clocked in outside the designated work location.</Text>
          </View>
        )}

        {/* Permission hours — apply here, an admin approves */}
        <View style={[styles.card, { marginTop: 20 }]}>
          <View style={styles.permHeader}>
            <View style={styles.permHeaderText}>
              <Text style={styles.cardTitle}>Permission Hours</Text>
              <Text style={styles.permSubtitle}>
                Short time off inside a working day. Approved hours count towards your day&apos;s hours.
              </Text>
            </View>
            <TouchableOpacity
              style={styles.permApplyBtn}
              onPress={() => { setPermError(null); setPermDate(today); setPermFormOpen(o => !o); }}
              activeOpacity={0.85}
            >
              <Text style={styles.permApplyText}>{permFormOpen ? 'Close' : 'Apply'}</Text>
            </TouchableOpacity>
          </View>

          {permissionBalance && (
            <View style={styles.statsRow}>
              {/* "Left this month" used to lead this row. Permission quantity
                  is unlimited now — every request stands on the manager's
                  approval — so a countdown that always reads ~744h would only
                  confuse. */}
              <View style={styles.statCol}>
                <Text style={styles.statLabel}>Approved</Text>
                <Text style={styles.statValue}>{minutesToHours(permissionBalance.used_minutes)}</Text>
              </View>
              <View style={styles.statCol}>
                <Text style={styles.statLabel}>Awaiting</Text>
                <Text style={styles.statValue}>{minutesToHours(permissionBalance.pending_minutes)}</Text>
              </View>
            </View>
          )}

          {permFormOpen && (
            <View style={styles.permForm}>
              <Text style={styles.permFieldLabel}>Date</Text>
              <TouchableOpacity style={styles.permInput} onPress={() => setPermDateOpen(true)}>
                <Text style={styles.permDateText}>{permDateLabel}</Text>
              </TouchableOpacity>
              {/* Applying for a future day has always been allowed — the
                  calendar has no upper bound and the server takes up to 90 days
                  ahead — but it was hidden behind opening the calendar and
                  knowing to look. Tomorrow is the one people actually want, so
                  it is one tap. */}
              <View style={styles.permQuickRow}>
                {([['Today', 0], ['Tomorrow', 1]] as const).map(([label, offset]) => {
                  const ymd = istCalendarYmd(new Date(Date.now() + offset * 86_400_000));
                  const on = permDate === ymd;
                  return (
                    <TouchableOpacity
                      key={label}
                      style={[styles.permQuickBtn, on && styles.permQuickBtnOn]}
                      onPress={() => setPermDate(ymd)}
                    >
                      <Text style={[styles.permQuickText, on && styles.permQuickTextOn]}>{label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <DatePicker
                visible={permDateOpen}
                value={permDate}
                minYmd={permMinDate}
                onPick={setPermDate}
                onClose={() => setPermDateOpen(false)}
              />
              {/* Tap to open the clock. Nothing here is typed, so there is no
                  half-entered time to validate and no AM/PM to forget. */}
              <View style={styles.permTimeRow}>
                <View style={styles.permTimeCol}>
                  <Text style={styles.permFieldLabel}>From</Text>
                  <TouchableOpacity style={styles.permInput} onPress={() => setPermTimeOpen('start')}>
                    <Text style={permStart24 ? styles.permDateText : styles.permTimePlaceholder}>
                      {timeLabel(permStart24)}
                    </Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.permTimeCol}>
                  <Text style={styles.permFieldLabel}>To</Text>
                  <TouchableOpacity style={styles.permInput} onPress={() => setPermTimeOpen('end')}>
                    <Text style={permEnd24 ? styles.permDateText : styles.permTimePlaceholder}>
                      {timeLabel(permEnd24)}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
              <TimePicker
                visible={permTimeOpen !== null}
                title={permTimeOpen === 'end' ? 'To' : 'From'}
                // Opening "To" with the start time already showing saves the
                // usual case: an hour or two later on the same dial.
                value={(permTimeOpen === 'end' ? permEnd24 ?? permStart24 : permStart24) ?? ''}
                onPick={hhmm => {
                  if (permTimeOpen === 'end') setPermEnd24(hhmm);
                  else setPermStart24(hhmm);
                }}
                onClose={() => setPermTimeOpen(null)}
              />
              {permStart24 != null && permEnd24 != null && spanMinutes(permStart24, permEnd24) !== null && (
                <Text style={styles.permDuration}>
                  Duration: {minutesToHours(spanMinutes(permStart24, permEnd24))}
                </Text>
              )}
              <Text style={styles.permFieldLabel}>Reason</Text>
              <TextInput
                style={[styles.permInput, styles.permReasonInput]}
                value={permReason}
                onChangeText={setPermReason}
                placeholder="Bank work, doctor visit…"
                placeholderTextColor={colors.textFaint}
                multiline
                maxLength={500}
                textAlignVertical="top"
              />
              {permError && (
                <View style={styles.errorBox}>
                  <Text style={styles.errorText}>{permError}</Text>
                </View>
              )}
              <TouchableOpacity
                style={[styles.saveBtn, permBusy && { opacity: 0.6 }]}
                onPress={handleApplyPermission}
                disabled={permBusy}
                activeOpacity={0.85}
              >
                {permBusy
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={styles.saveBtnText}>Submit for Approval</Text>}
              </TouchableOpacity>
            </View>
          )}

          {permissions.length === 0 ? (
            <Text style={styles.empty}>No permission requests this month.</Text>
          ) : (
            permissions.map(p => (
              <View key={p.id} style={styles.permRow}>
                <View style={styles.permRowMain}>
                  <Text style={styles.permRowTitle}>
                    {dateDMY(p.permission_date)} · {clock12(p.start_time.slice(0, 5))} – {clock12(p.end_time.slice(0, 5))}
                  </Text>
                  <Text style={styles.permRowSub}>
                    {minutesToHours(Number(p.minutes))}
                    {p.reason ? ` · ${p.reason}` : ''}
                    {p.status === 'rejected' && p.review_notes ? ` · ${p.review_notes}` : ''}
                  </Text>
                </View>
                <View style={styles.permRowRight}>
                  <Text
                    style={[
                      styles.permStatus,
                      p.status === 'approved' && { color: colors.greenText },
                      p.status === 'pending' && { color: '#fbbf24' },
                      p.status === 'rejected' && { color: colors.redText },
                    ]}
                  >
                    {p.status}
                  </Text>
                  {p.status === 'pending' && (
                    <TouchableOpacity onPress={() => handleCancelPermission(p)}>
                      <Text style={styles.permCancel}>Withdraw</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            ))
          )}
        </View>

        {/* Daily Work Update */}
        <View style={[styles.card, { marginTop: 20 }]}>
          <Text style={styles.cardTitle}>Daily Work Update</Text>
          <TextInput
            style={styles.textarea}
            value={dailyUpdate}
            onChangeText={setDailyUpdate}
            multiline
            numberOfLines={3}
            maxLength={1000}
            placeholder="What did you work on today?"
            placeholderTextColor={colors.textFaint}
            textAlignVertical="top"
          />
          <TouchableOpacity
            style={[styles.saveBtn, savingUpdate && { opacity: 0.6 }]}
            onPress={handleSaveUpdate}
            disabled={savingUpdate}
            activeOpacity={0.85}
          >
            {savingUpdate ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveBtnText}>Save Update</Text>}
          </TouchableOpacity>
        </View>

        {/* Live tracking status + map */}
        {!trackingEnabled ? (
          <View style={styles.trackPill}>
            <View style={[styles.dot, { backgroundColor: colors.textFaint }]} />
            <Text style={[styles.trackText, { color: colors.textMuted }]}>Location tracking is disabled</Text>
          </View>
        ) : (
          <TouchableOpacity
            style={styles.trackPill}
            activeOpacity={tracking ? 1 : 0.7}
            onPress={tracking ? undefined : () => { void fixTracking(); }}
            disabled={tracking}
          >
            <View style={[styles.dot, { backgroundColor: tracking ? colors.greenText : colors.textFaint }]} />
            <Text style={[styles.trackText, { color: tracking ? colors.greenText : '#fbbf24' }]}>
              {tracking
                ? 'Location tracking is on'
                : `${trackingIssue ?? 'Location tracking is off'} — tap to fix`}
            </Text>
          </TouchableOpacity>
        )}

        {trackingEnabled && clockedIn && !clockedOut && liveCoords && (
          <View style={[styles.card, styles.mapCard]}>
            <View style={styles.mapHeader}>
              <Text style={styles.liveCoordsText}>
                Live: {liveCoords.lat.toFixed(6)}, {liveCoords.lng.toFixed(6)}
              </Text>
              <TouchableOpacity
                onPress={() => Linking.openURL(`https://www.google.com/maps?q=${liveCoords.lat},${liveCoords.lng}`)}
              >
                <Text style={styles.openMaps}>Open in Maps</Text>
              </TouchableOpacity>
            </View>
            <WebView
              source={{
                baseUrl: 'https://maps.google.com',
                html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"><style>html,body{margin:0;height:100%;overflow:hidden;background:#1e293b}iframe{border:0;width:100%;height:100%}</style></head><body><iframe src="https://maps.google.com/maps?q=${liveCoords.lat},${liveCoords.lng}&z=16&output=embed" allowfullscreen loading="lazy"></iframe></body></html>`,
              }}
              style={styles.map}
              originWhitelist={['*']}
              javaScriptEnabled
              domStorageEnabled
            />
          </View>
        )}

        {/* Last 7 days */}
        <View style={[styles.card, { marginTop: 20 }]}>
          <Text style={styles.cardTitle}>Last 7 days</Text>
          <View style={styles.histHead}>
            <Text style={[styles.histHeadText, styles.colDate]}>DATE</Text>
            <Text style={[styles.histHeadText, styles.colTime]}>IN</Text>
            <Text style={[styles.histHeadText, styles.colTime]}>OUT</Text>
            <Text style={[styles.histHeadText, styles.colHrs]}>HRS</Text>
          </View>
          {history.length === 0 ? (
            <Text style={styles.empty}>No records yet.</Text>
          ) : (
            history.map((r, i) => (
              <View key={`${r.work_date}-${i}`} style={styles.histRow}>
                <View style={styles.colDate}>
                  <Text style={styles.histDate}>{dateDMY(r.work_date)}</Text>
                  {r.status && (
                    <Text style={[styles.histStatus, { color: r.status === 'present' ? colors.greenText : colors.textMuted }]}>
                      {r.status}
                    </Text>
                  )}
                </View>
                <Text style={[styles.histCell, styles.colTime]}>{timeOnly(r.clock_in_utc)}</Text>
                <Text style={[styles.histCell, styles.colTime]}>{timeOnly(r.clock_out_utc)}</Text>
                <View style={styles.colHrsWrap}>
                  <Text style={[styles.histCell, styles.histHrs]}>
                    {minutesToHours(r.credited_minutes ?? r.total_minutes)}
                  </Text>
                  {!!r.permission_minutes && (
                    <Text style={styles.histPermission}>
                      +{minutesToHours(Number(r.permission_minutes))} P
                    </Text>
                  )}
                </View>
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, backgroundColor: colors.bg, justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: STATUS_BAR_PAD + 12,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  logo: { width: 32, height: 32, borderRadius: 10, backgroundColor: colors.brand, alignItems: 'center', justifyContent: 'center' },
  logoCheck: { color: '#fff', fontSize: 18, fontWeight: '900', lineHeight: 20 },
  brandName: { fontSize: 18, fontWeight: '700', color: colors.text },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.avatar, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  signOut: { color: colors.textMuted, fontSize: 14 },
  content: { padding: 20, paddingBottom: 50 },
  hello: { color: colors.text, fontSize: 28, fontWeight: '700' },
  date: { color: colors.textMuted, fontSize: 15, marginTop: 6 },
  clock: { color: colors.accent, fontSize: 38, fontWeight: '800', marginTop: 4, letterSpacing: 1 },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 16, padding: 20, marginTop: 24 },
  cardLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '600', letterSpacing: 0.5, marginBottom: 14 },
  cardTitle: { color: colors.text, fontSize: 17, fontWeight: '700', marginBottom: 14 },
  statsRow: { flexDirection: 'row', justifyContent: 'space-between' },
  statCol: { flex: 1 },
  statLabel: { color: colors.textMuted, fontSize: 13, marginBottom: 4 },
  statValue: { color: colors.text, fontSize: 18, fontWeight: '700' },
  schedule: { color: colors.textMuted, fontSize: 14, marginTop: 18 },
  badge: { alignSelf: 'flex-start', backgroundColor: colors.greenBg, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5, marginTop: 14 },
  badgeText: { color: colors.greenText, fontSize: 13, fontWeight: '600', textTransform: 'lowercase' },
  warnBox: { backgroundColor: 'rgba(245,158,11,0.12)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.35)', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, marginTop: 16 },
  warnTitle: { color: '#fbbf24', fontSize: 14, fontWeight: '700', marginBottom: 4 },
  warnText: { color: '#fcd34d', fontSize: 13, lineHeight: 18 },
  errorBox: { backgroundColor: colors.redBg, borderWidth: 1, borderColor: colors.redBorder, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, marginTop: 16 },
  errorText: { color: colors.redText, fontSize: 13 },
  action: { borderWidth: 1, borderColor: colors.borderInput, borderRadius: 12, paddingVertical: 16, alignItems: 'center', marginTop: 20 },
  actionText: { color: colors.text, fontSize: 16, fontWeight: '600' },
  done: { color: colors.greenText, textAlign: 'center', marginTop: 20, fontSize: 15, fontWeight: '600' },
  reminderNote: { color: colors.textFaint, textAlign: 'center', marginTop: 10, fontSize: 12 },
  textarea: {
    borderWidth: 1,
    borderColor: colors.borderInput,
    backgroundColor: colors.bg,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.text,
    fontSize: 15,
    minHeight: 84,
  },
  saveBtn: { backgroundColor: colors.brand, borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 12, alignSelf: 'flex-end', paddingHorizontal: 24 },
  saveBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  trackPill: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 20, paddingHorizontal: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  trackText: { fontSize: 13, fontWeight: '600' },
  mapCard: { marginTop: 20, padding: 0, overflow: 'hidden' },
  mapHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14 },
  liveCoordsText: { color: colors.textMuted, fontSize: 13, flex: 1 },
  openMaps: { color: colors.accent, fontSize: 14, fontWeight: '600' },
  map: { height: 220, width: '100%', backgroundColor: colors.card },
  histHead: { flexDirection: 'row', alignItems: 'center', paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  histHeadText: { color: colors.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  histRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  colDate: { flex: 1.4 },
  colTime: { flex: 1, textAlign: 'left' },
  colHrs: { flex: 1, textAlign: 'right' },
  colHrsWrap: { flex: 1, alignItems: 'flex-end' },
  histDate: { color: colors.text, fontSize: 13, fontWeight: '600' },
  histStatus: { fontSize: 12, marginTop: 2, textTransform: 'lowercase' },
  histCell: { color: colors.textLabel, fontSize: 13 },
  histHrs: { color: colors.text, fontWeight: '700' },
  histPermission: { color: colors.accent, fontSize: 11, marginTop: 2 },
  empty: { color: colors.textMuted, fontSize: 14, paddingVertical: 12 },

  // --- Permission hours ------------------------------------------------------
  permissionNote: { color: colors.accent, fontSize: 12, marginTop: 10 },
  permHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  permHeaderText: { flex: 1 },
  permSubtitle: { color: colors.textMuted, fontSize: 12, marginTop: -8, marginBottom: 14, lineHeight: 17 },
  permApplyBtn: { backgroundColor: colors.brand, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 16 },
  permApplyText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  permForm: { marginTop: 16, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 14 },
  permFieldLabel: { color: colors.textLabel, fontSize: 13, fontWeight: '600', marginBottom: 6 },
  permInput: {
    borderWidth: 1,
    borderColor: colors.borderInput,
    backgroundColor: colors.bg,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 15,
    marginBottom: 12,
  },
  permReasonInput: { minHeight: 64 },
  permTimeRow: { flexDirection: 'row', gap: 12 },
  permTimeCol: { flex: 1 },
  fenceBanner: { borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, marginTop: 14, borderWidth: 1 },
  fenceBannerIn: { backgroundColor: 'rgba(22,163,74,0.12)', borderColor: 'rgba(22,163,74,0.4)' },
  fenceBannerOut: { backgroundColor: 'rgba(239,68,68,0.12)', borderColor: 'rgba(239,68,68,0.4)' },
  fenceBannerText: { fontSize: 13, lineHeight: 18 },
  fenceBannerTextIn: { color: '#86efac' },
  fenceBannerTextOut: { color: '#fca5a5' },
  sessionList: { marginTop: 12, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10, gap: 6 },
  sessionRow: { color: colors.textMuted, fontSize: 13, flexShrink: 1 },
  sessionTime: { color: colors.text, fontWeight: '600' },
  permDateText: { color: colors.text, fontSize: 14, paddingVertical: 2 },
  permTimePlaceholder: { color: colors.textFaint, fontSize: 14, paddingVertical: 2 },
  permQuickRow: { flexDirection: 'row', gap: 8, marginTop: 8, marginBottom: 4 },
  permQuickBtn: {
    paddingVertical: 5, paddingHorizontal: 12, borderRadius: 999,
    borderWidth: 1, borderColor: colors.borderInput, backgroundColor: colors.bg,
  },
  permQuickBtnOn: { backgroundColor: colors.brand, borderColor: colors.brand },
  permQuickText: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  permQuickTextOn: { color: '#ffffff' },
  permDuration: { color: colors.textLabel, fontSize: 13, marginBottom: 12 },
  permRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  permRowMain: { flex: 1 },
  permRowTitle: { color: colors.text, fontSize: 13, fontWeight: '600' },
  permRowSub: { color: colors.textMuted, fontSize: 12, marginTop: 3, lineHeight: 16 },
  permRowRight: { alignItems: 'flex-end' },
  permStatus: { fontSize: 12, fontWeight: '700', textTransform: 'lowercase', color: colors.textMuted },
  permCancel: { color: colors.redText, fontSize: 12, marginTop: 4 },
});

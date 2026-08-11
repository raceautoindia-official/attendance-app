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
import { startBackgroundTracking, stopBackgroundTracking, isTrackingRunning } from '../location/tracking';
import {
  startGeofenceAutoMode,
  stopGeofenceAutoMode,
  reconcileGeofenceAttendance,
  isAutoOutPending,
} from '../location/geofenceAuto';
import { startLocationWatch, stopLocationWatch, checkLocationAndWarn } from '../location/locationWatch';
import { scheduleShiftEndReminders, cancelShiftEndReminders } from '../notifications/shiftReminder';
import { requestIgnoreBatteryOptimization, openAppSettings } from '../location/batteryOptimization';
import ConsentModal from './ConsentModal';
import { colors } from '../theme';

const CONSENT_KEY = 'location_consent_v1';

const STATUS_BAR_PAD = Platform.OS === 'android' ? StatusBar.currentHeight ?? 0 : 0;
const TZ = 'Asia/Kolkata'; // all dates/times shown in IST, matching the web app

interface TodayAttendance {
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
  // Use a recent cached fix first — instant, so clock-in doesn't hang on a
  // fresh GPS lock (during which the connection could drop).
  const last = await Location.getLastKnownPositionAsync({ maxAge: 60_000, requiredAccuracy: 200 });
  const pos = last ?? await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
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
  const [trackingEnabled, setTrackingEnabled] = useState(true); // admin per-employee toggle
  const [multiSession, setMultiSession] = useState(false); // plant: several clock-ins per day
  const [fenceLocation, setFenceLocation] = useState<FenceLocation | null>(null);
  // Google Play prominent-disclosure consent. null = not yet loaded.
  const [hasConsent, setHasConsent] = useState<boolean | null>(null);
  const [consentVisible, setConsentVisible] = useState(false);
  // Set when the server refuses a clock-in with code 'outside_fence'. Holding
  // the server's own numbers — the site, its radius, how far out — means the
  // prompt tells the employee exactly what it is asking them to explain.
  const [fenceRefusal, setFenceRefusal] = useState<{
    message: string;
    locationName: string | null;
    distanceM: number | null;
    radiusM: number | null;
  } | null>(null);
  const [reasonText, setReasonText] = useState('');
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
  const [permStart, setPermStart] = useState('');
  const [permEnd, setPermEnd] = useState('');
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
      }>('/api/attendance/today');
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
    if (hasConsent !== true) return;
    let active = true;

    const ensureTracking = async () => {
      try {
        const running = await isTrackingRunning();
        if (!running) {
          await startBackgroundTracking();
        }
        if (active) setTracking(true);
      } catch {
        if (active) setTracking(false);
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

  const performClockIn = async (outOfFenceReason?: string) => {
    setBusy(true);
    setError(null);
    try {
      const coords = await getCoords();
      await apiFetch('/api/attendance/clock-in', {
        method: 'POST',
        body: outOfFenceReason ? { ...coords, out_of_fence_reason: outOfFenceReason } : coords,
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
      toast(outOfFenceReason ? 'Clocked in — your manager has been notified' : 'Clocked in successfully ✓');
    } catch (e) {
      // Away from the work site. Being refused outright is right for someone
      // trying it on and wrong for the ordinary case — a delivery, a customer
      // visit — where the employee could previously do nothing at all. Ask why,
      // and send it: the day is still recorded as outside the fence and an
      // admin is told, so this is an exception on the record, not a way round it.
      //
      // Only offered once per attempt: `outOfFenceReason` is already set on the
      // retry, so a second refusal is shown as an error instead of looping.
      if (!outOfFenceReason && e instanceof ApiError && e.code === 'outside_fence') {
        setBusy(false);
        setFenceRefusal({
          message: e.message,
          locationName: (e.info?.location_name as string | null) ?? null,
          distanceM: (e.info?.distance_m as number | null) ?? null,
          radiusM: (e.info?.radius_m as number | undefined) ?? null,
        });
        setReasonText('');
        return;
      }
      const msg = e instanceof Error ? e.message : 'Clock-in failed.';
      setError(msg);
      toast(msg);
    } finally {
      setBusy(false);
    }
  };

  const submitOutOfFenceReason = async () => {
    const reason = reasonText.trim();
    if (reason.length < 5) {
      setError('Please say why you are clocking in from here — at least a few words.');
      return;
    }
    setFenceRefusal(null);
    await performClockIn(reason);
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
    const minutes = spanMinutes(permStart, permEnd);
    if (minutes === null) {
      setPermError('Enter times as HH:MM (24-hour), with the end after the start');
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
          start_time: permStart.trim(),
          end_time: permEnd.trim(),
          reason: permReason.trim() || null,
        },
      });
      setPermFormOpen(false);
      setPermStart('');
      setPermEnd('');
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
    await cancelShiftEndReminders();
    await clearTodayCache();
    await logout();
    onLogout();
  };

  // Shown when tracking is off — helps the employee re-enable background tracking.
  const fixTracking = () => {
    Alert.alert(
      'Turn on background tracking',
      'Your phone is stopping the app from tracking in the background. Allow it to run in the background, then it will keep recording your location.',
      [
        { text: 'Allow background', onPress: () => { void requestIgnoreBatteryOptimization(); } },
        { text: 'Open app settings', onPress: () => { void openAppSettings(); } },
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

      {/* Clocking in away from the work site. The refusal already told us the
          site, its radius and how far out they are, so the prompt can say what
          it is asking about rather than "you are outside". */}
      <Modal visible={!!fenceRefusal} transparent animationType="fade" onRequestClose={() => setFenceRefusal(null)}>
        <View style={styles.reasonBackdrop}>
          <View style={styles.reasonCard}>
            <Text style={styles.reasonTitle}>You are away from your work site</Text>
            <Text style={styles.reasonBody}>
              {fenceRefusal?.distanceM != null && fenceRefusal?.radiusM != null
                ? `You are about ${fenceRefusal.distanceM} m from ${fenceRefusal.locationName ?? 'your work location'}, which has a ${fenceRefusal.radiusM} m boundary.`
                : fenceRefusal?.message}
            </Text>
            <Text style={styles.reasonBody}>
              You can still clock in — tell us why. Your manager is notified and the
              day is recorded as off-site.
            </Text>
            <TextInput
              style={styles.reasonInput}
              placeholder="e.g. Customer visit at Ambattur"
              placeholderTextColor={colors.textFaint}
              value={reasonText}
              onChangeText={setReasonText}
              multiline
              numberOfLines={3}
              maxLength={500}
              autoFocus
            />
            <View style={styles.reasonActions}>
              <TouchableOpacity
                style={styles.reasonCancel}
                onPress={() => { setFenceRefusal(null); setReasonText(''); }}
              >
                <Text style={styles.reasonCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.reasonSubmit, reasonText.trim().length < 5 && styles.reasonSubmitOff]}
                disabled={reasonText.trim().length < 5}
                onPress={() => { void submitOutOfFenceReason(); }}
              >
                <Text style={styles.reasonSubmitText}>Clock in anyway</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
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

        {/* TODAY */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>TODAY</Text>
          <View style={styles.statsRow}>
            <View style={styles.statCol}>
              <Text style={styles.statLabel}>Clock In</Text>
              <Text style={styles.statValue}>{timeOnly(attendance?.clock_in_utc ?? null)}</Text>
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
                  {clockedOut ? '⏻  Clock In Again' : '⏻  Clock In'}
                </Text>
              )}
            </TouchableOpacity>
          )}
          {clockedIn && !clockedOut && (
            <TouchableOpacity style={styles.action} onPress={handleClockOut} disabled={busy} activeOpacity={0.8}>
              {busy ? <ActivityIndicator color={colors.text} /> : <Text style={styles.actionText}>⏻  Clock Out</Text>}
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
              <View style={styles.statCol}>
                <Text style={styles.statLabel}>Left this month</Text>
                <Text style={styles.statValue}>{minutesToHours(permissionBalance.remaining_minutes)}</Text>
              </View>
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
              <Text style={styles.permFieldLabel}>Date (YYYY-MM-DD)</Text>
              <TextInput
                style={styles.permInput}
                value={permDate}
                onChangeText={setPermDate}
                placeholder="2026-08-04"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
              />
              <View style={styles.permTimeRow}>
                <View style={styles.permTimeCol}>
                  <Text style={styles.permFieldLabel}>From (24h)</Text>
                  <TextInput
                    style={styles.permInput}
                    value={permStart}
                    onChangeText={setPermStart}
                    placeholder="10:00"
                    placeholderTextColor={colors.textFaint}
                    keyboardType="numbers-and-punctuation"
                  />
                </View>
                <View style={styles.permTimeCol}>
                  <Text style={styles.permFieldLabel}>To (24h)</Text>
                  <TextInput
                    style={styles.permInput}
                    value={permEnd}
                    onChangeText={setPermEnd}
                    placeholder="12:00"
                    placeholderTextColor={colors.textFaint}
                    keyboardType="numbers-and-punctuation"
                  />
                </View>
              </View>
              {spanMinutes(permStart, permEnd) !== null && (
                <Text style={styles.permDuration}>
                  Duration: {minutesToHours(spanMinutes(permStart, permEnd))}
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
            onPress={tracking ? undefined : fixTracking}
            disabled={tracking}
          >
            <View style={[styles.dot, { backgroundColor: tracking ? colors.greenText : colors.textFaint }]} />
            <Text style={[styles.trackText, { color: tracking ? colors.greenText : '#fbbf24' }]}>
              {tracking ? 'Location tracking is on' : 'Location tracking is off — tap to fix'}
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
  // Away-from-site reason prompt.
  reasonBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center', paddingHorizontal: 20,
  },
  reasonCard: {
    backgroundColor: colors.card, borderRadius: 14, padding: 20,
    borderWidth: 1, borderColor: colors.border,
  },
  reasonTitle: { color: colors.text, fontSize: 17, fontWeight: '700', marginBottom: 10 },
  reasonBody: { color: colors.textMuted, fontSize: 13, lineHeight: 19, marginBottom: 10 },
  reasonInput: {
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.borderInput,
    borderRadius: 10, color: colors.text, paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 14, minHeight: 76, textAlignVertical: 'top', marginTop: 4, marginBottom: 16,
  },
  reasonActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  reasonCancel: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10 },
  reasonCancelText: { color: colors.textMuted, fontSize: 14, fontWeight: '600' },
  reasonSubmit: {
    backgroundColor: colors.brand, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10,
  },
  reasonSubmitOff: { opacity: 0.45 },
  reasonSubmitText: { color: '#ffffff', fontSize: 14, fontWeight: '700' },
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

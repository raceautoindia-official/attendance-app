import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
} from 'react-native';
import { WebView } from 'react-native-webview';
import * as Location from 'expo-location';
import { apiFetch, logout } from '../api/client';
import { getStoredEmployee, StoredEmployee } from '../storage/tokens';
import { saveTodayCache, getTodayCache, clearTodayCache } from '../storage/cache';
import { startBackgroundTracking, stopBackgroundTracking, isTrackingRunning } from '../location/tracking';
import { colors } from '../theme';

const STATUS_BAR_PAD = Platform.OS === 'android' ? StatusBar.currentHeight ?? 0 : 0;
const TZ = 'Asia/Kolkata'; // all dates/times shown in IST, matching the web app

interface TodayAttendance {
  clock_in_utc: string | null;
  clock_out_utc: string | null;
  total_minutes: number | null;
  status: string | null;
  geofence_status?: string | null;
}

interface HistoryRow {
  work_date: string;
  clock_in_utc: string | null;
  clock_out_utc: string | null;
  total_minutes: number | null;
  status: string | null;
}

interface Shift {
  name?: string;
  type?: string;
  start_time?: string;
  end_time?: string;
  required_hours?: number;
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
function istYmd(date: Date): string {
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

async function getCoords(): Promise<{ latitude: number; longitude: number }> {
  const perm = await Location.requestForegroundPermissionsAsync();
  if (perm.status !== 'granted') throw new Error('Location permission is required.');
  // Use a recent cached fix first — instant, so clock-in doesn't hang on a
  // fresh GPS lock (during which the connection could drop).
  const last = await Location.getLastKnownPositionAsync({ maxAge: 60_000, requiredAccuracy: 200 });
  if (last) return { latitude: last.coords.latitude, longitude: last.coords.longitude };
  const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  return { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
}

export default function DashboardScreen({ onLogout }: { onLogout: () => void }) {
  const [employee, setEmployee] = useState<StoredEmployee | null>(null);
  const [attendance, setAttendance] = useState<TodayAttendance | null>(null);
  const [shift, setShift] = useState<Shift | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tracking, setTracking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(new Date());
  const [liveCoords, setLiveCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [dailyUpdate, setDailyUpdate] = useState('');
  const [savingUpdate, setSavingUpdate] = useState(false);

  const clockedIn = !!attendance?.clock_in_utc;
  const clockedOut = !!attendance?.clock_out_utc;
  const today = istYmd(now);
  const showClockOutReminder = clockedIn && !clockedOut && istHour(now) >= 19;

  // Hours ticks live while clocked in (matches the web).
  const liveWorkedMinutes = useMemo(() => {
    if (!attendance?.clock_in_utc || attendance?.clock_out_utc) return attendance?.total_minutes ?? null;
    const ms = new Date(attendance.clock_in_utc).getTime();
    if (Number.isNaN(ms)) return attendance?.total_minutes ?? null;
    return Math.max(0, Math.floor((now.getTime() - ms) / 60_000));
  }, [attendance, now]);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const loadToday = useCallback(async () => {
    try {
      const data = await apiFetch<{ attendance: TodayAttendance | null; schedule: { shift?: Shift } | null }>(
        '/api/attendance/today',
      );
      setAttendance(data.attendance);
      setShift(data.schedule?.shift ?? null);
      saveTodayCache(istYmd(new Date()), data.attendance);
    } catch (e) {
      if (e instanceof Error && e.message.includes('log in again')) onLogout();
    }
  }, [onLogout]);

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

  useEffect(() => {
    let active = true;
    (async () => {
      const [emp, cached, running] = await Promise.all([
        getStoredEmployee(),
        getTodayCache<TodayAttendance | null>(istYmd(new Date())),
        isTrackingRunning(),
      ]);
      if (!active) return;
      setEmployee(emp);
      if (cached !== null) setAttendance(cached);
      setTracking(running);
      setLoading(false);
      loadToday();
      loadHistory();
      loadDailyUpdate();
    })();
    return () => {
      active = false;
    };
  }, [loadToday, loadHistory, loadDailyUpdate]);

  // Keep the live map updated while clocked in.
  useEffect(() => {
    if (!clockedIn || clockedOut) {
      setLiveCoords(null);
      return;
    }
    let active = true;
    const fetchPos = async () => {
      try {
        const perm = await Location.getForegroundPermissionsAsync();
        if (perm.status !== 'granted') return;
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (active) setLiveCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      } catch {
        /* ignore */
      }
    };
    fetchPos();
    const id = setInterval(fetchPos, 20_000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [clockedIn, clockedOut]);

  const refresh = useCallback(() => {
    loadToday();
    loadHistory();
    loadDailyUpdate();
  }, [loadToday, loadHistory, loadDailyUpdate]);

  const handleClockIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const coords = await getCoords();
      await apiFetch('/api/attendance/clock-in', { method: 'POST', body: coords });
      await startBackgroundTracking();
      setTracking(true);
      refresh();
      toast('Clocked in successfully ✓');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Clock-in failed.';
      setError(msg);
      toast(msg);
    } finally {
      setBusy(false);
    }
  };

  const handleClockOut = async () => {
    setBusy(true);
    setError(null);
    try {
      const coords = await getCoords();
      await apiFetch('/api/attendance/clock-out', { method: 'POST', body: coords });
      await stopBackgroundTracking();
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

  const handleLogout = async () => {
    await stopBackgroundTracking().catch(() => {});
    await clearTodayCache();
    await logout();
    onLogout();
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
              <Text style={styles.statValue}>{minutesToHours(liveWorkedMinutes)}</Text>
            </View>
          </View>

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

          {!clockedIn && (
            <TouchableOpacity style={styles.action} onPress={handleClockIn} disabled={busy} activeOpacity={0.8}>
              {busy ? <ActivityIndicator color={colors.text} /> : <Text style={styles.actionText}>⏻  Clock In</Text>}
            </TouchableOpacity>
          )}
          {clockedIn && !clockedOut && (
            <TouchableOpacity style={styles.action} onPress={handleClockOut} disabled={busy} activeOpacity={0.8}>
              {busy ? <ActivityIndicator color={colors.text} /> : <Text style={styles.actionText}>⏻  Clock Out</Text>}
            </TouchableOpacity>
          )}
          {clockedIn && clockedOut && <Text style={styles.done}>Attendance completed for today ✓</Text>}
        </View>

        {/* Geofence warning */}
        {attendance?.geofence_status === 'outside' && (
          <View style={[styles.warnBox, { marginTop: 16 }]}>
            <Text style={styles.warnText}>⚠️ You clocked in outside the designated work location.</Text>
          </View>
        )}

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
        <View style={styles.trackPill}>
          <View style={[styles.dot, { backgroundColor: tracking ? colors.greenText : colors.textFaint }]} />
          <Text style={[styles.trackText, { color: tracking ? colors.greenText : colors.textMuted }]}>
            {tracking ? 'Location tracking is on' : 'Location tracking is off'}
          </Text>
        </View>

        {clockedIn && !clockedOut && liveCoords && (
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
                <Text style={[styles.histCell, styles.colHrs, styles.histHrs]}>{minutesToHours(r.total_minutes)}</Text>
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
  histDate: { color: colors.text, fontSize: 13, fontWeight: '600' },
  histStatus: { fontSize: 12, marginTop: 2, textTransform: 'lowercase' },
  histCell: { color: colors.textLabel, fontSize: 13 },
  histHrs: { color: colors.text, fontWeight: '700' },
  empty: { color: colors.textMuted, fontSize: 14, paddingVertical: 12 },
});

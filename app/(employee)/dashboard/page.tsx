'use client';

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format, subDays } from 'date-fns';
import Badge from '@/components/ui/Badge';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import Spinner from '@/components/ui/Spinner';
import Table from '@/components/ui/Table';
import Pagination from '@/components/ui/Pagination';
import { useCurrentUser } from '@/lib/useCurrentUser';
import { REQUIRED_SHIFT_HOURS } from '@/lib/constants';
import type { AttendanceRecord, AttendanceStatus, ApiResponse } from '@/lib/types';
import { cn } from '@/lib/cn';
import { formatDateOnly } from '@/lib/date';

const IST_LOCALE = 'en-IN';
const TZ = 'Asia/Kolkata';

function toIST(d: Date | string | null | undefined) {
  if (!d) return null;
  return new Date(d).toLocaleTimeString(IST_LOCALE, { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: true });
}

function statusBadge(status: AttendanceStatus) {
  const map: Record<AttendanceStatus, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
    present: 'success', late: 'warning', absent: 'danger',
    early_departure: 'warning', leave: 'info', holiday: 'info',
  };
  return <Badge variant={map[status]}>{status.replace('_', ' ')}</Badge>;
}

function minutesToHours(m: number | null | undefined) {
  if (m == null) return '-';
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

type TodayData = {
  attendance: AttendanceRecord | null;
  schedule?: {
    shift?: {
      type?: string;
      name?: string;
      start_time?: string | null;
      end_time?: string | null;
      required_hours?: number | null;
    } | null;
  } | null;
};

type LiveTrackingStatusData = {
  enabled: boolean;
  session: {
    id: number;
    started_at_utc: string;
    last_ping_utc: string | null;
  } | null;
};

type LiveTrackingLiveRow = {
  session_id: number;
  employee_id: number;
  emp_id: string;
  employee_name: string;
  started_at_utc: string;
  last_ping_utc: string | null;
  tracked_at_utc: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracy_meters: number | null;
};
type LoginActivitySummary = {
  total_login_days: number;
  current_month_login_days: number;
  last_login_at: string | null;
};

export default function DashboardPage() {
  const qc = useQueryClient();
  const user = useCurrentUser();
  const [mounted, setMounted] = useState(false);

  const [now, setNow] = useState(new Date());
  const [isDesktopClient, setIsDesktopClient] = useState(false);
  const [historyPage, setHistoryPage] = useState(1);
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    setMounted(true);
  }, []);
  useEffect(() => {
    const ua = navigator.userAgent.toLowerCase();
    const isMobile = /android|iphone|ipad|ipod|mobile|windows phone/.test(ua);
    setIsDesktopClient(!isMobile);
  }, []);

  const { data: todayData, isLoading: todayLoading } = useQuery({
    queryKey: ['attendance', 'today'],
    queryFn: async () => {
      const res = await fetch('/api/attendance/today', { cache: 'no-store' });
      return res.json() as Promise<ApiResponse<TodayData>>;
    },
    refetchInterval: 60_000,
  });

  const today = format(now, 'yyyy-MM-dd');
  const sevenDaysAgo = format(subDays(new Date(), 7), 'yyyy-MM-dd');

  const { data: historyData, isLoading: historyLoading } = useQuery({
    queryKey: ['attendance', 'history', historyPage],
    queryFn: async () => {
      const res = await fetch(`/api/attendance?from_date=${sevenDaysAgo}&to_date=${today}&limit=7&page=${historyPage}`, { cache: 'no-store' });
      return res.json() as Promise<ApiResponse<{ records: AttendanceRecord[]; pagination: { total: number; totalPages: number } }>>;
    },
  });

  const { data: liveTrackingStatus, refetch: refetchLiveTrackingStatus } = useQuery({
    queryKey: ['live-tracking', 'status'],
    queryFn: async () => {
      const res = await fetch('/api/live-tracking/status');
      return res.json() as Promise<ApiResponse<LiveTrackingStatusData>>;
    },
    refetchInterval: 30_000,
  });

  const { data: liveTrackingLiveData } = useQuery({
    queryKey: ['live-tracking', 'live-self'],
    queryFn: async () => {
      const res = await fetch('/api/live-tracking/live?include_path=0');
      return res.json() as Promise<ApiResponse<{ sessions: LiveTrackingLiveRow[] }>>;
    },
    refetchInterval: 5_000,
  });
  const { data: workUpdatesData } = useQuery({
    queryKey: ['daily-updates', 'self', today],
    queryFn: async () => {
      const res = await fetch(`/api/daily-updates?from_date=${today}&to_date=${today}&limit=1&page=1`);
      return res.json() as Promise<ApiResponse<{ updates: Array<{ update_text: string }> }>>;
    },
  });
  const { data: loginActivityData } = useQuery({
    queryKey: ['login-activity', 'summary'],
    queryFn: async () => {
      const res = await fetch('/api/login-activity/summary');
      return res.json() as Promise<ApiResponse<LoginActivitySummary>>;
    },
    refetchInterval: 60_000,
  });

  const [gpsError, setGpsError] = useState<string | null>(null);
  const [trackingHaltedMessage, setTrackingHaltedMessage] = useState<string | null>(null);
  const [dailyUpdateText, setDailyUpdateText] = useState('');
  const trackingWatchIdRef = useRef<number | null>(null);
  const lastTrackingPushMsRef = useRef<number>(0);
  const clockOutReminderNotifiedRef = useRef(false);

  const getCoords = useCallback(
    () =>
      new Promise<GeolocationCoordinates>((resolve, reject) => {
        if (!navigator.geolocation) {
          reject(new Error('Geolocation is not supported by your device.'));
          return;
        }
        navigator.geolocation.getCurrentPosition(
          pos => resolve(pos.coords),
          err => {
            switch (err.code) {
              case err.PERMISSION_DENIED:
                reject(new Error('Location permission denied. Turn on location permission and try again.'));
                break;
              case err.POSITION_UNAVAILABLE:
                reject(new Error('Location is turned off or unavailable. Please turn on GPS/location and try again.'));
                break;
              default:
                reject(new Error('Unable to get location. Please turn on GPS/location and try again.'));
            }
          },
          // maximumAge lets the device return a recent fix instantly instead of
          // waiting for a fresh GPS lock, so clock-in/out feels immediate.
          { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 },
        );
      }),
    [],
  );

  const clockMutation = useMutation({
    mutationFn: async (action: 'clock-in' | 'clock-out') => {
      setGpsError(null);
      const coords = await getCoords();
      const res = await fetch(`/api/attendance/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ latitude: coords.latitude, longitude: coords.longitude }),
      });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? `${action} failed`);
      return json;
    },
    // Flip the button instantly on tap; reconcile with the server afterwards.
    onMutate: async (action: 'clock-in' | 'clock-out') => {
      await qc.cancelQueries({ queryKey: ['attendance', 'today'] });
      const prev = qc.getQueryData<ApiResponse<TodayData>>(['attendance', 'today']);
      const nowIso = new Date().toISOString() as unknown as Date;
      qc.setQueryData<ApiResponse<TodayData>>(['attendance', 'today'], old => {
        const cur = (old?.data?.attendance ?? {}) as AttendanceRecord;
        const att: AttendanceRecord = action === 'clock-in'
          ? { ...cur, clock_in_utc: nowIso, clock_out_utc: null, status: 'present' }
          : { ...cur, clock_out_utc: nowIso };
        return { success: true, data: { attendance: att, schedule: old?.data?.schedule ?? null } };
      });
      return { prev };
    },
    onSuccess: (json) => {
      // Replace the optimistic record with the server's authoritative one.
      const rec = (json as unknown as ApiResponse<AttendanceRecord>)?.data;
      if (rec) {
        qc.setQueryData<ApiResponse<TodayData>>(['attendance', 'today'], old => ({
          success: true,
          data: { attendance: rec, schedule: old?.data?.schedule ?? null },
        }));
      }
    },
    onError: (err: Error, _action, context) => {
      // Roll the button back to its previous state if the request failed.
      const ctx = context as { prev?: ApiResponse<TodayData> } | undefined;
      if (ctx?.prev) qc.setQueryData(['attendance', 'today'], ctx.prev);
      if (err.message.toLowerCase().includes('location') || err.message.includes('permission')) {
        setGpsError(err.message);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['attendance'] });
      qc.invalidateQueries({ queryKey: ['live-tracking', 'status'] });
      qc.invalidateQueries({ queryKey: ['live-tracking', 'live-self'] });
      refetchLiveTrackingStatus();
    },
  });

  const liveTrackingMutation = useMutation({
    mutationFn: async ({
      action,
      coords,
    }: {
      action: 'start' | 'ping' | 'stop';
      coords?: Pick<GeolocationCoordinates, 'latitude' | 'longitude' | 'accuracy'>;
    }) => {
      const resolvedCoords = coords ?? (await getCoords());
      const res = await fetch(`/api/live-tracking/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          latitude: resolvedCoords.latitude,
          longitude: resolvedCoords.longitude,
          accuracy_meters: resolvedCoords.accuracy ?? null,
        }),
      });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? `${action} failed`);
      return json;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['live-tracking', 'live-self'] });
      refetchLiveTrackingStatus();
    },
    onError: (err: Error) => {
      if (err.message.toLowerCase().includes('location') || err.message.includes('permission')) {
        setGpsError(err.message);
      }
    },
  });

  const haltTrackingMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/live-tracking/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Failed to halt tracking');
      return json;
    },
    onSuccess: () => {
      setTrackingHaltedMessage('Live tracking was halted because GPS/location was unavailable.');
      refetchLiveTrackingStatus();
    },
  });
  const saveDailyUpdateMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/daily-updates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ work_date: today, update_text: dailyUpdateText }),
      });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Failed to save daily update');
      return json;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['daily-updates'] });
    },
  });

  const attendance = todayData?.data?.attendance;
  const liveSelf = liveTrackingLiveData?.data?.sessions?.[0] ?? null;
  const schedule = todayData?.data?.schedule;
  const clockedIn = !!attendance?.clock_in_utc;
  const clockedOut = !!attendance?.clock_out_utc;
  const canClockIn = !clockedIn;
  const canClockOut = clockedIn && !clockedOut;
  const liveTrackingAllowed = liveTrackingStatus?.data?.enabled !== false;
  const activeLiveSession = liveTrackingStatus?.data?.session ?? liveSelf;
  const shouldTrackLive = liveTrackingAllowed && clockedIn && !clockedOut;
  const trackingActive = shouldTrackLive && !!activeLiveSession;
  const trackingStatusLabel = trackingActive
    ? 'Tracking On'
    : shouldTrackLive
      ? 'Starting Tracking'
      : liveTrackingAllowed
        ? 'Waiting for Clock-In'
        : 'Tracking Off';

  const displayDate = mounted
    ? now.toLocaleDateString(IST_LOCALE, { timeZone: TZ, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    : '-';
  const displayTime = mounted
    ? now.toLocaleTimeString(IST_LOCALE, { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })
    : '--:--:--';

  // Current hour in IST (0–23). Used for the post-7pm clock-out reminder.
  const istHour = mounted
    ? Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(now))
    : 0;
  // Grace window: shift has ended, reminder runs from 19:00 until midnight.
  const showClockOutReminder = mounted && clockedIn && !clockedOut && istHour >= 19;

  const history = historyData?.data?.records ?? [];
  const loginSummary = loginActivityData?.data;
  useEffect(() => {
    setDailyUpdateText(workUpdatesData?.data?.updates?.[0]?.update_text ?? '');
  }, [workUpdatesData?.data?.updates]);
  const historyPagination = historyData?.data?.pagination;
  const liveWorkedMinutes = useMemo(() => {
    if (!attendance?.clock_in_utc || attendance?.clock_out_utc) return attendance?.total_minutes ?? null;
    const clockInMs = new Date(attendance.clock_in_utc).getTime();
    if (Number.isNaN(clockInMs)) return attendance?.total_minutes ?? null;
    const diff = Math.max(0, Math.floor((now.getTime() - clockInMs) / 60_000));
    return diff;
  }, [attendance?.clock_in_utc, attendance?.clock_out_utc, attendance?.total_minutes, now]);

  useEffect(() => {
    if (!shouldTrackLive) return;
    if (!navigator.geolocation) {
      setGpsError('Location/GPS is not supported on this device.');
      return;
    }

    const pushPing = (coords: GeolocationCoordinates) => {
      // Throttle high-frequency GPS events to avoid flooding API calls.
      const nowMs = Date.now();
      if (nowMs - lastTrackingPushMsRef.current < 15_000) return;
      lastTrackingPushMsRef.current = nowMs;

      liveTrackingMutation.mutate(
        {
          action: 'ping',
          coords: {
            latitude: coords.latitude,
            longitude: coords.longitude,
            accuracy: coords.accuracy,
          },
        },
        {
          onError: (err: Error) => {
            const m = err.message.toLowerCase();
            const isGpsDisconnect = m.includes('location') || m.includes('permission') || m.includes('gps');
            if (isGpsDisconnect && !haltTrackingMutation.isPending) {
              haltTrackingMutation.mutate();
            }
          },
        },
      );
    };

    const watchId = navigator.geolocation.watchPosition(
      pos => {
        setGpsError(null);
        pushPing(pos.coords);
      },
      () => {
        setGpsError('Location is turned off or unavailable. Please turn on GPS/location and try again.');
        if (!haltTrackingMutation.isPending) haltTrackingMutation.mutate();
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 10_000 },
    );

    trackingWatchIdRef.current = watchId;
    return () => {
      if (trackingWatchIdRef.current != null) {
        navigator.geolocation.clearWatch(trackingWatchIdRef.current);
        trackingWatchIdRef.current = null;
      }
    };
  }, [shouldTrackLive, liveTrackingMutation, haltTrackingMutation]);

  // Post-7pm clock-out reminder: fire a one-time local browser notification
  // (in addition to the in-app banner) while the dashboard is open.
  useEffect(() => {
    if (!showClockOutReminder) {
      clockOutReminderNotifiedRef.current = false; // reset for the next day
      return;
    }
    if (clockOutReminderNotifiedRef.current) return;
    if (typeof window === 'undefined' || !('Notification' in window)) return;

    const fire = () => {
      try {
        new Notification('Clock-out reminder', {
          body: 'Your shift has ended. Please clock out before midnight.',
        });
        clockOutReminderNotifiedRef.current = true;
      } catch {
        // Notification construction can throw on some browsers; ignore.
      }
    };

    if (Notification.permission === 'granted') {
      fire();
    } else if (Notification.permission !== 'denied') {
      void Notification.requestPermission().then(p => {
        if (p === 'granted') fire();
      });
    }
  }, [showClockOutReminder]);

  return (
    <div className="space-y-6">
      {/* Greeting + live clock */}
      <div>
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">
          {user?.name ? `Hello, ${user.name.split(' ')[0]}` : 'Hello'}
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{displayDate}</p>
        <p className="text-3xl font-bold text-blue-600 dark:text-blue-400 mt-1 tabular-nums">{displayTime}</p>
      </div>

      {/* Today card */}
      <Card>
        <h2 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-4">Today</h2>
        {todayLoading ? (
          <div className="flex justify-center py-4"><Spinner /></div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-4 mb-5">
              {[
                { label: 'Clock In', value: toIST(attendance?.clock_in_utc) ?? '-' },
                { label: 'Clock Out', value: toIST(attendance?.clock_out_utc) ?? '-' },
                { label: 'Hours', value: minutesToHours(liveWorkedMinutes) },
              ].map(item => (
                <div key={item.label}>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{item.label}</p>
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-200 mt-0.5">{item.value}</p>
                </div>
              ))}
            </div>
            {schedule?.shift && (
              <div className="mb-4 text-sm text-slate-600 dark:text-slate-300">
                {schedule.shift.type === 'flexible'
                  ? `${schedule.shift.name ?? 'Flexible Shift'} - ${REQUIRED_SHIFT_HOURS} hours required`
                  : `${schedule.shift.name ?? 'Shift'} - ${schedule.shift.start_time?.slice(0, 5) ?? '--:--'} to ${schedule.shift.end_time?.slice(0, 5) ?? '--:--'}`}
              </div>
            )}

            {attendance && <div className="mb-5">{statusBadge(attendance.status)}</div>}

            {/* Post-7pm clock-out reminder (grace window until midnight) */}
            {showClockOutReminder && (
              <div className="mb-5 flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-4 py-3">
                <svg className="w-5 h-5 flex-shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div>
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-300">Please clock out</p>
                  <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                    Your shift has ended. Clock out before midnight — otherwise it will be auto-closed with your standard shift hours.
                  </p>
                </div>
              </div>
            )}

            {/* Clock button */}
            {isDesktopClient ? (
              <div className="w-full text-center py-3 text-sm text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg">
                Desktop login is enabled. Attendance marking is mobile-only.
              </div>
            ) : canClockIn || canClockOut ? (
              <Button
                size="lg"
                className="w-full"
                variant={canClockIn ? 'primary' : 'secondary'}
                loading={clockMutation.isPending}
                onClick={() => clockMutation.mutate(canClockIn ? 'clock-in' : 'clock-out')}
              >
                {/* Label is driven by state, which flips optimistically on tap,
                    so the button changes immediately; the spinner shows the
                    in-flight request. */}
                {canClockIn ? (
                  <><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                  </svg>Clock In</>
                ) : (
                  <><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                  </svg>Clock Out</>
                )}
              </Button>
            ) : clockedOut ? (
              <div className="w-full text-center py-3 text-sm text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-700/50 rounded-lg">
                Done for today
              </div>
            ) : null}

            {/* Error */}
            {(gpsError || clockMutation.isError) && (
              <div className="mt-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-4 py-3">
                <p className="text-sm text-red-700 dark:text-red-300">
                  {gpsError ?? (clockMutation.error as Error)?.message}
                </p>
                {gpsError && (
                  <p className="text-xs text-red-500 dark:text-red-400 mt-1">
                    Turn on your device location and allow browser permission: Site settings, Location, Allow.
                  </p>
                )}
              </div>
            )}
            {trackingHaltedMessage && (
              <div className="mt-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-4 py-3">
                <p className="text-sm text-amber-700 dark:text-amber-300">{trackingHaltedMessage}</p>
              </div>
            )}
          </>
        )}
      </Card>

      {isDesktopClient && (
        <Card>
          <h2 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-4">Desktop Login Activity</h2>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <p className="text-xs text-slate-500 dark:text-slate-400">Total Login Days</p>
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-200 mt-0.5">
                {loginSummary?.total_login_days ?? 0}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500 dark:text-slate-400">This Month</p>
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-200 mt-0.5">
                {loginSummary?.current_month_login_days ?? 0}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500 dark:text-slate-400">Last Login</p>
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-200 mt-0.5">
                {loginSummary?.last_login_at ? toIST(loginSummary.last_login_at) : '-'}
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* Geofence warning */}
      {attendance?.geofence_status === 'outside' && (
        <div className={cn(
          'flex items-start gap-2 rounded-lg px-4 py-3 text-sm',
          'bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300',
        )}>
          <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span>You clocked in outside the designated work location.</span>
        </div>
      )}

      <Card>
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Daily Work Update</h2>
          <textarea
            value={dailyUpdateText}
            onChange={e => setDailyUpdateText(e.target.value)}
            rows={3}
            maxLength={1000}
            className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
            placeholder="What did you work on today?"
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={() => saveDailyUpdateMutation.mutate()}
              loading={saveDailyUpdateMutation.isPending}
            >
              Save Update
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Live Tracking</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Auto-enabled after clock-in. Location updates continuously while tracking is on.
            </p>
            {trackingActive && liveSelf?.last_ping_utc && (
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                Last update: {toIST(liveSelf.last_ping_utc)}
              </p>
            )}
          </div>
          <span className={`w-fit shrink-0 whitespace-nowrap text-xs font-medium px-3 py-1.5 rounded-full ${
            trackingActive
              ? 'text-green-700 bg-green-100 dark:text-green-300 dark:bg-green-900/30'
              : shouldTrackLive
                ? 'text-blue-700 bg-blue-100 dark:text-blue-300 dark:bg-blue-900/30'
                : 'text-slate-600 bg-slate-100 dark:text-slate-300 dark:bg-slate-700/50'
          }`}>
            {trackingStatusLabel}
          </span>
        </div>
        {trackingActive && liveSelf?.latitude != null && liveSelf?.longitude != null && (
          <div className="mt-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Live coordinates: {Number(liveSelf.latitude).toFixed(6)}, {Number(liveSelf.longitude).toFixed(6)}
              </p>
              <a
                href={`https://www.google.com/maps?q=${Number(liveSelf.latitude)},${Number(liveSelf.longitude)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
              >
                Open in Maps
              </a>
            </div>
            <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
              <iframe
                title="My live tracking map"
                src={`https://www.google.com/maps?q=${Number(liveSelf.latitude)},${Number(liveSelf.longitude)}&z=17&output=embed`}
                className="w-full h-64"
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
              />
            </div>
          </div>
        )}
      </Card>

      {/* 7-day history */}
      <Card padding={false}>
        <div className="px-4 py-4 border-b border-slate-200 dark:border-slate-700">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Last 7 days</h2>
        </div>
        {historyLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : (
          <>
            <div className="md:hidden">
              {history.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400">
                  No attendance records yet.
                </div>
              ) : (
                <div>
                  {/* Column headers */}
                  <div className="grid grid-cols-[1.5fr_0.95fr_0.95fr_0.7fr] gap-2 px-4 py-2.5 bg-slate-50 dark:bg-slate-900/60 border-b border-slate-200 dark:border-slate-700">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Date</span>
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">In</span>
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Out</span>
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 text-right">Hrs</span>
                  </div>
                  {/* Rows */}
                  <div className="divide-y divide-slate-100 dark:divide-slate-700/50">
                    {history.map(record => (
                      <div
                        key={record.id}
                        className="grid grid-cols-[1.5fr_0.95fr_0.95fr_0.7fr] gap-2 px-4 py-3 items-center"
                      >
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-slate-800 dark:text-slate-200 tabular-nums">
                            {formatDateOnly(record.work_date)}
                          </p>
                          <div className="mt-1">
                            {statusBadge(record.status)}
                          </div>
                        </div>
                        <p className="text-xs text-slate-700 dark:text-slate-300 tabular-nums">
                          {toIST(record.clock_in_utc) ?? '-'}
                        </p>
                        <p className="text-xs text-slate-700 dark:text-slate-300 tabular-nums">
                          {toIST(record.clock_out_utc) ?? '-'}
                        </p>
                        <p className="text-xs font-semibold text-slate-800 dark:text-slate-200 tabular-nums text-right">
                          {minutesToHours(record.total_minutes)}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="hidden md:block">
              <Table
                columns={[
                  { key: 'work_date', header: 'Date', render: r => formatDateOnly((r as AttendanceRecord).work_date) },
                  { key: 'clock_in_utc', header: 'In', render: r => toIST((r as AttendanceRecord).clock_in_utc) ?? '-' },
                  { key: 'clock_out_utc', header: 'Out', render: r => toIST((r as AttendanceRecord).clock_out_utc) ?? '-' },
                  { key: 'total_minutes', header: 'Hours', render: r => minutesToHours((r as AttendanceRecord).total_minutes) },
                  { key: 'status', header: 'Status', render: r => statusBadge((r as AttendanceRecord).status) },
                ]}
                data={history as object[]}
                emptyMessage="No attendance records yet."
              />
            </div>
          </>
        )}
        {!historyLoading && historyPagination && historyPagination.totalPages > 1 && (
          <div className="px-4 py-4 border-t border-slate-200 dark:border-slate-700">
            <Pagination page={historyPage} totalPages={historyPagination.totalPages} onPageChange={setHistoryPage} />
          </div>
        )}
      </Card>
    </div>
  );
}

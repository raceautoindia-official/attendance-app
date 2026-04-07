'use client';

import { useEffect, useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import Badge from '@/components/ui/Badge';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import Spinner from '@/components/ui/Spinner';
import Table from '@/components/ui/Table';
import { getStoredUser } from '@/lib/user';
import type { AttendanceRecord, AttendanceStatus, ApiResponse } from '@/lib/types';
import { cn } from '@/lib/cn';

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
  if (m == null) return '—';
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

type TodayData = {
  attendance: AttendanceRecord | null;
};

export default function DashboardPage() {
  const qc = useQueryClient();
  const user = getStoredUser();

  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const { data: todayData, isLoading: todayLoading } = useQuery({
    queryKey: ['attendance', 'today'],
    queryFn: async () => {
      const res = await fetch('/api/attendance/today');
      return res.json() as Promise<ApiResponse<TodayData>>;
    },
    refetchInterval: 60_000,
  });

  const today = format(now, 'yyyy-MM-dd');
  const sevenDaysAgo = format(new Date(Date.now() - 7 * 86400_000), 'yyyy-MM-dd');

  const { data: historyData, isLoading: historyLoading } = useQuery({
    queryKey: ['attendance', 'history'],
    queryFn: async () => {
      const res = await fetch(`/api/attendance?from_date=${sevenDaysAgo}&to_date=${today}&limit=7`);
      return res.json() as Promise<ApiResponse<{ records: AttendanceRecord[] }>>;
    },
  });

  const [gpsError, setGpsError] = useState<string | null>(null);

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
                reject(new Error('Location permission denied. Please allow location access and try again.'));
                break;
              case err.POSITION_UNAVAILABLE:
                reject(new Error('Location unavailable. Please check your GPS settings.'));
                break;
              default:
                reject(new Error('Failed to get your location. Please try again.'));
            }
          },
          { enableHighAccuracy: true, timeout: 15_000 },
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['attendance'] }),
    onError: (err: Error) => {
      if (err.message.toLowerCase().includes('location') || err.message.includes('permission')) {
        setGpsError(err.message);
      }
    },
  });

  const attendance = todayData?.data?.attendance;
  const clockedIn = !!attendance?.clock_in_utc;
  const clockedOut = !!attendance?.clock_out_utc;
  const canClockIn = !clockedIn;
  const canClockOut = clockedIn && !clockedOut;

  const displayDate = now.toLocaleDateString(IST_LOCALE, { timeZone: TZ, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const displayTime = now.toLocaleTimeString(IST_LOCALE, { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

  const history = historyData?.data?.records ?? [];

  return (
    <div className="space-y-6">
      {/* Greeting + live clock */}
      <div>
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">
          Hello, {user?.name?.split(' ')[0] ?? 'there'} 👋
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
                { label: 'Clock In', value: toIST(attendance?.clock_in_utc) ?? '—' },
                { label: 'Clock Out', value: toIST(attendance?.clock_out_utc) ?? '—' },
                { label: 'Hours', value: minutesToHours(attendance?.total_minutes) },
              ].map(item => (
                <div key={item.label}>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{item.label}</p>
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-200 mt-0.5">{item.value}</p>
                </div>
              ))}
            </div>

            {attendance && <div className="mb-5">{statusBadge(attendance.status)}</div>}

            {/* Clock button */}
            {canClockIn || canClockOut ? (
              <Button
                size="lg"
                className="w-full"
                variant={canClockIn ? 'primary' : 'secondary'}
                loading={clockMutation.isPending}
                onClick={() => clockMutation.mutate(canClockIn ? 'clock-in' : 'clock-out')}
              >
                {clockMutation.isPending ? 'Getting location…' : canClockIn ? (
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
                Done for today ✓
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
                    Go to browser settings → Site permissions → Location to enable it.
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </Card>

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

      {/* 7-day history */}
      <Card padding={false}>
        <div className="px-4 py-4 border-b border-slate-200 dark:border-slate-700">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Last 7 days</h2>
        </div>
        {historyLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : (
          <Table
            columns={[
              { key: 'work_date', header: 'Date' },
              { key: 'clock_in_utc', header: 'In', render: r => toIST((r as AttendanceRecord).clock_in_utc) ?? '—' },
              { key: 'clock_out_utc', header: 'Out', render: r => toIST((r as AttendanceRecord).clock_out_utc) ?? '—' },
              { key: 'total_minutes', header: 'Hours', render: r => minutesToHours((r as AttendanceRecord).total_minutes) },
              { key: 'status', header: 'Status', render: r => statusBadge((r as AttendanceRecord).status) },
            ]}
            data={history as object[]}
            emptyMessage="No attendance records yet."
          />
        )}
      </Card>
    </div>
  );
}

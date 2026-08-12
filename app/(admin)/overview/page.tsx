'use client';

import { useEffect, useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import StatCard from '@/components/ui/StatCard';
import Badge from '@/components/ui/Badge';
import Table from '@/components/ui/Table';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import Spinner from '@/components/ui/Spinner';
import { useCurrentUser } from '@/lib/useCurrentUser';
import type { AttendanceRecord, AttendanceStatus, ApiResponse, Employee } from '@/lib/types';
import { formatDateOnly } from '@/lib/date';

type AttRow = AttendanceRecord & { employee_name?: string; emp_id?: string };
type DailyUpdateRow = {
  id: number;
  employee_id: number;
  employee_name: string;
  employee_emp_id: string;
  work_date: string;
  update_text: string;
  updated_at: string;
};

const STATUS_BADGE: Record<AttendanceStatus, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  present: 'success', late: 'warning', absent: 'danger',
  early_departure: 'warning', leave: 'info', holiday: 'info',
};

// The values /api/attendance accepts for its status filter. Anything else is
// ignored there, so the dropdown must not offer one.
const STATUS_FILTERS: AttendanceStatus[] = [
  'present', 'late', 'absent', 'early_departure', 'leave', 'holiday',
];

const IST = 'Asia/Kolkata';
const IST_LOCALE = 'en-IN';
function toIST(d: Date | string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleTimeString(IST_LOCALE, { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: true });
}
function minutesToHours(m: number | null | undefined) {
  if (m == null) return '—';
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export default function OverviewPage() {
  const today = format(new Date(), 'yyyy-MM-dd');
  const qc = useQueryClient();
  const currentUser = useCurrentUser();
  const isManager = currentUser?.role === 'manager';

  // Manager self-attendance
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const [gpsError, setGpsError] = useState<string | null>(null);

  const getCoords = useCallback(
    () => new Promise<GeolocationCoordinates>((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error('Location/GPS is not supported on this device')); return; }
      navigator.geolocation.getCurrentPosition(
        pos => resolve(pos.coords),
        err => {
          switch (err.code) {
            case err.PERMISSION_DENIED: reject(new Error('Location permission denied. Turn on location permission and try again.')); break;
            case err.POSITION_UNAVAILABLE: reject(new Error('Location is turned off or unavailable. Please turn on GPS/location and try again.')); break;
            default: reject(new Error('Unable to get location. Please turn on GPS/location and try again.'));
          }
        },
        { enableHighAccuracy: true, timeout: 15_000 },
      );
    }),
    [],
  );

  const { data: selfAttData, isLoading: selfAttLoading } = useQuery({
    queryKey: ['attendance', 'today-self'],
    queryFn: async () => {
      const res = await fetch('/api/attendance/today');
      return res.json() as Promise<ApiResponse<{ attendance: AttendanceRecord | null }>>;
    },
    enabled: isManager,
    refetchInterval: 60_000,
  });

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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['attendance', 'today-self'] });
      qc.invalidateQueries({ queryKey: ['attendance', 'today-list'] });
    },
    onError: (err: Error) => {
      if (err.message.toLowerCase().includes('location') || err.message.includes('permission')) {
        setGpsError(err.message);
      }
    },
  });

  const selfAtt = selfAttData?.data?.attendance;
  const clockedIn = !!selfAtt?.clock_in_utc;
  const clockedOut = !!selfAtt?.clock_out_utc;
  const canClockIn = !clockedIn;
  const canClockOut = clockedIn && !clockedOut;

  const { data: empData, isLoading: empLoading } = useQuery({
    queryKey: ['employees', 'count'],
    queryFn: async () => {
      const res = await fetch('/api/employees?limit=1');
      return res.json() as Promise<ApiResponse<{ employees: Employee[]; pagination: { total: number } }>>;
    },
    refetchInterval: 60_000,
  });

  // Status filter for the day's table. Applied by the SERVER, not by hiding
  // rows here: the list is capped at 100 records, so filtering after the fetch
  // would search only the first hundred and quietly miss the rest.
  const [statusFilter, setStatusFilter] = useState<AttendanceStatus | ''>('');

  const dayQuery = useCallback((status: AttendanceStatus | '') => ({
    queryKey: ['attendance', 'today-list', today, status] as const,
    queryFn: async () => {
      const res = await fetch(
        `/api/attendance?from_date=${today}&to_date=${today}&limit=100`
        + (status ? `&status=${status}` : ''),
      );
      return res.json() as Promise<ApiResponse<{ records: AttRow[]; pagination: { total: number } }>>;
    },
    refetchInterval: 60_000,
  }), [today]);

  // The table honours the filter; the stat cards never do. Counting "present"
  // off a list filtered to 'absent' would report nobody present all day.
  // With no filter set both hooks resolve to the SAME query key, so this is
  // one request until somebody actually filters.
  const { data: attData, isLoading: attLoading } = useQuery(dayQuery(statusFilter));
  const { data: allDayData } = useQuery(dayQuery(''));

  const { data: absentData } = useQuery({
    queryKey: ['attendance', 'absent-today', today],
    queryFn: async () => {
      const res = await fetch(`/api/attendance/absent-today?date=${today}`);
      return res.json() as Promise<ApiResponse<{ count: number; employees: Array<{ id: number; name: string }> }>>;
    },
    refetchInterval: 60_000,
  });

  const { data: dailyUpdatesData, isLoading: dailyUpdatesLoading } = useQuery({
    queryKey: ['daily-updates', 'admin', today],
    queryFn: async () => {
      const res = await fetch(`/api/daily-updates?from_date=${today}&to_date=${today}&limit=50&page=1`);
      return res.json() as Promise<ApiResponse<{ updates: DailyUpdateRow[] }>>;
    },
    refetchInterval: 60_000,
  });


  const totalEmployees = empData?.data?.pagination.total ?? 0;
  const records = attData?.data?.records ?? [];
  const dailyUpdates = dailyUpdatesData?.data?.updates ?? [];
  const allDayRecords = allDayData?.data?.records ?? records;
  const present = allDayRecords.filter(r => r.status === 'present' || r.status === 'late').length;
  // Absent comes from the server, which applies the same rule the end-of-day
  // job does. Counting rows here showed 0 all day every day: an 'absent' row
  // is only written after the day FINISHES. Deriving it in the browser instead
  // would need the schedules, the weekly-off rule and the leave table — three
  // chances to disagree with the job that decides.
  const absent = absentData?.data?.count ?? 0;
  const absentNames = absentData?.data?.employees ?? [];

  const isLoading = empLoading || attLoading;

  const displayTime = now.toLocaleTimeString(IST_LOCALE, { timeZone: IST, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

  return (
    <div className="space-y-6">
      {/* Manager self-attendance widget */}
      {isManager && (
        <Card>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200">My Attendance</h2>
              <p className="text-xs text-slate-400 tabular-nums mt-0.5">{displayTime}</p>
            </div>
            {selfAtt && (
              <Badge variant={
                selfAtt.status === 'present' ? 'success' :
                selfAtt.status === 'late' ? 'warning' :
                selfAtt.status === 'absent' ? 'danger' : 'neutral'
              }>
                {selfAtt.status.replace('_', ' ')}
              </Badge>
            )}
          </div>

          {selfAttLoading ? (
            <div className="flex justify-center py-3"><Spinner /></div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-4 mb-4">
                {[
                  { label: 'Clock In',  value: toIST(selfAtt?.clock_in_utc  ?? null) },
                  { label: 'Clock Out', value: toIST(selfAtt?.clock_out_utc ?? null) },
                  { label: 'Hours',     value: minutesToHours(selfAtt?.total_minutes) },
                ].map(item => (
                  <div key={item.label}>
                    <p className="text-xs text-slate-500 dark:text-slate-400">{item.label}</p>
                    <p className="text-sm font-semibold text-slate-800 dark:text-slate-200 mt-0.5">{item.value}</p>
                  </div>
                ))}
              </div>

              {canClockIn || canClockOut ? (
                <Button
                  className="w-full"
                  variant={canClockIn ? 'primary' : 'secondary'}
                  loading={clockMutation.isPending}
                  onClick={() => clockMutation.mutate(canClockIn ? 'clock-in' : 'clock-out')}
                >
                  {clockMutation.isPending ? 'Getting location…' : canClockIn ? 'Clock In' : 'Clock Out'}
                </Button>
              ) : clockedOut ? (
                <div className="w-full text-center py-2 text-sm text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-700/50 rounded-lg">
                  Done for today ✓
                </div>
              ) : null}

              {(gpsError || clockMutation.isError) && (
                <div className="mt-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-4 py-3">
                  <p className="text-sm text-red-700 dark:text-red-300">
                    {gpsError ?? (clockMutation.error as Error)?.message}
                  </p>
                </div>
              )}
            </>
          )}
        </Card>
      )}

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard
          label="Total Employees"
          value={totalEmployees}
          loading={isLoading}
          variant="info"
          icon={
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
          }
        />
        <StatCard
          label="Present Today"
          value={present}
          loading={isLoading}
          variant="success"
          icon={
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
        <StatCard
          label="Not In Yet"
          value={absent}
          loading={isLoading}
          variant="danger"
          // Naming them is the point. A count tells an admin something is
          // wrong; the names tell them who to ring.
          subLabel={absentNames.length
            ? absentNames.slice(0, 3).map(e => e.name).join(', ')
              + (absentNames.length > 3 ? ` +${absentNames.length - 3} more` : '')
            : undefined}
          icon={
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />

      </div>

      {/* Today attendance table */}
      <Card padding={false}>
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-slate-800 dark:text-slate-200">Today Attendance</h2>
            {/* Which day this actually is. The table is a live view of one
                work day and said so nowhere — an admin reading it at 7am,
                when the work day has just rolled over, had no way to tell
                which day they were looking at. */}
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {new Date(`${today}T12:00:00Z`).toLocaleDateString('en-IN', {
                timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
              })}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              Status
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value as AttendanceStatus | '')}
                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1.5 text-xs text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">All</option>
                {STATUS_FILTERS.map(s => (
                  <option key={s} value={s}>{s.replace('_', ' ')}</option>
                ))}
              </select>
            </label>
            <span className="hidden sm:inline text-xs text-slate-400 dark:text-slate-500">
              Auto-refreshes every 60s
            </span>
          </div>
        </div>

        {attLoading ? (
          <div className="flex justify-center py-12"><Spinner /></div>
        ) : (
          <Table
            columns={[
              {
                key: 'employee_name',
                header: 'Employee Name',
                render: r => (
                  <span className="font-medium text-slate-800 dark:text-slate-200">
                    {(r as AttRow).employee_name ?? '—'}
                  </span>
                ),
              },
              {
                key: 'emp_id',
                header: 'Employee ID',
                render: r => (
                  <span className="text-slate-500 dark:text-slate-400 tabular-nums">
                    {(r as AttRow).emp_id ?? '—'}
                  </span>
                ),
              },
              {
                key: 'clock_in_utc',
                header: 'Check-in',
                render: r => {
                  const row = r as AttRow;
                  // The day's FIRST arrival, not the current session's start —
                  // on a multi-session day clock_in_utc moves to the afternoon
                  // and would report someone in at 9:10 as having arrived at 2pm.
                  const first = row.first_clock_in_utc ?? row.clock_in_utc;
                  return (
                    <div>
                      <span className="tabular-nums">{toIST(first)}</span>
                      {/* Clocked in from outside the work site. The Geofence
                          column that used to carry this is gone, but the fact
                          is not: it belongs to the check-in itself. */}
                      {row.geofence_status === 'outside' && (
                        <p
                          className="text-[11px] text-red-600 dark:text-red-400"
                          title={row.out_of_fence_reason ?? 'Clocked in away from the work site'}
                        >
                          off-site
                        </p>
                      )}
                    </div>
                  );
                },
              },
              {
                key: 'clock_out_utc',
                header: 'Check-out',
                render: r => <span className="tabular-nums">{toIST((r as AttRow).clock_out_utc)}</span>,
              },
              {
                key: 'break_minutes',
                header: 'Break',
                render: r => {
                  const m = (r as AttRow).break_minutes;
                  if (m == null) return <span className="text-slate-400">—</span>;
                  return <span className="tabular-nums">{minutesToHours(m)}</span>;
                },
              },
              {
                key: 'total_minutes',
                header: 'Total Hours',
                render: r => {
                  const row = r as AttRow;
                  // worked_minutes counts the sessions already banked, so an
                  // employee back from lunch shows the morning rather than a
                  // blank until they clock out for the day.
                  const m = row.worked_minutes ?? row.total_minutes;
                  return (
                    <span className="tabular-nums font-medium text-slate-800 dark:text-slate-200">
                      {minutesToHours(m)}
                    </span>
                  );
                },
              },
              {
                key: 'late_minutes',
                header: 'Late',
                render: r => {
                  const m = (r as AttRow).late_minutes;
                  // null and 0 mean different things: null is "this day has no
                  // start time to be late against" (flexible shift, or nobody
                  // rostered them), 0 is "they made it".
                  if (m == null) return <span className="text-slate-400">—</span>;
                  if (m === 0) return <span className="text-slate-400">On time</span>;
                  return (
                    <span className="tabular-nums text-amber-600 dark:text-amber-400">
                      {minutesToHours(m)}
                    </span>
                  );
                },
              },
              {
                key: 'overtime_minutes',
                header: 'Overtime',
                render: r => {
                  const m = (r as AttRow).overtime_minutes ?? 0;
                  if (m <= 0) return <span className="text-slate-400">—</span>;
                  return (
                    <span className="tabular-nums text-green-600 dark:text-green-400">
                      +{minutesToHours(m)}
                    </span>
                  );
                },
              },
              {
                key: 'status',
                header: 'Status',
                render: r => (
                  <Badge variant={STATUS_BADGE[(r as AttRow).status]}>
                    {(r as AttRow).status.replace('_', ' ')}
                  </Badge>
                ),
              },
              // Location, Geofence and Date columns used to follow. The date is
              // now on the heading (the table is one day), and the location is
              // on the Live Tracking page beside the map that shows it. The one
              // thing that was load-bearing — an off-site clock-in — moved onto
              // the Check-in cell rather than being dropped.
              //
              // A "Signal" column used to sit here too. It cast an attendance
              // row to a live-tracking row and read last_ping_utc, which belongs
              // to live_tracking_sessions and is not returned by this endpoint —
              // so it rendered "Unknown" for every employee, every day, since it
              // was written.
            ]}
            data={records as object[]}
            emptyMessage={
              statusFilter
                ? `No one is "${statusFilter.replace('_', ' ')}" today.`
                : 'No attendance records for today.'
            }
          />
        )}
      </Card>

      {/* Daily work updates */}
      <Card padding={false}>
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700">
          <h2 className="font-semibold text-slate-800 dark:text-slate-200">Daily Work Updates</h2>
        </div>
        {dailyUpdatesLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : (
          <Table
            columns={[
              {
                key: 'employee_name',
                header: 'Employee',
                render: r => (
                  <div>
                    <p className="font-medium text-slate-800 dark:text-slate-200">{(r as DailyUpdateRow).employee_name}</p>
                    <p className="text-xs text-slate-400">{(r as DailyUpdateRow).employee_emp_id}</p>
                  </div>
                ),
              },
              { key: 'work_date', header: 'Date', render: r => formatDateOnly((r as DailyUpdateRow).work_date) },
              { key: 'update_text', header: 'Update', render: r => (r as DailyUpdateRow).update_text },
              { key: 'updated_at', header: 'Updated', render: r => toIST((r as DailyUpdateRow).updated_at) },
            ]}
            data={dailyUpdates as object[]}
            emptyMessage="No daily updates submitted today."
          />
        )}
      </Card>

    </div>
  );
}

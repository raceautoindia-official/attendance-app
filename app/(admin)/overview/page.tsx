'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
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
  path?: Array<{
    tracked_at_utc: string;
    latitude: number;
    longitude: number;
    accuracy_meters: number | null;
  }>;
};
type DailyUpdateRow = {
  id: number;
  employee_id: number;
  employee_name: string;
  employee_emp_id: string;
  work_date: string;
  update_text: string;
  updated_at: string;
};
type LiveRangePreset = '30m' | '2h' | '8h' | '24h' | 'custom';

const STATUS_BADGE: Record<AttendanceStatus, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  present: 'success', late: 'warning', absent: 'danger',
  early_departure: 'warning', leave: 'info', holiday: 'info',
};

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

function getSignalAgeMinutes(lastPingUtc: string | null): number | null {
  if (!lastPingUtc) return null;
  const ms = new Date(lastPingUtc).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 60_000));
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
  const [selectedLiveSessionId, setSelectedLiveSessionId] = useState<number | null>(null);
  const [liveEmployeeFilter, setLiveEmployeeFilter] = useState<'all' | number>('all');
  const [liveRangePreset, setLiveRangePreset] = useState<LiveRangePreset>('2h');
  const [customFromLocal, setCustomFromLocal] = useState('');
  const [customToLocal, setCustomToLocal] = useState('');

  const liveRange = useMemo(() => {
    const now = new Date();
    if (liveRangePreset === 'custom') {
      const fromDate = customFromLocal ? new Date(customFromLocal) : null;
      const toDate = customToLocal ? new Date(customToLocal) : null;
      return {
        fromUtc: fromDate && !Number.isNaN(fromDate.getTime()) ? fromDate.toISOString() : null,
        toUtc: toDate && !Number.isNaN(toDate.getTime()) ? toDate.toISOString() : null,
      };
    }
    const minutesMap: Record<Exclude<LiveRangePreset, 'custom'>, number> = {
      '30m': 30,
      '2h': 120,
      '8h': 480,
      '24h': 1440,
    };
    const from = new Date(now.getTime() - minutesMap[liveRangePreset] * 60_000);
    return { fromUtc: from.toISOString(), toUtc: now.toISOString() };
  }, [liveRangePreset, customFromLocal, customToLocal]);

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

  const { data: attData, isLoading: attLoading } = useQuery({
    queryKey: ['attendance', 'today-list', today],
    queryFn: async () => {
      const res = await fetch(`/api/attendance?from_date=${today}&to_date=${today}&limit=100`);
      return res.json() as Promise<ApiResponse<{ records: AttRow[]; pagination: { total: number } }>>;
    },
    refetchInterval: 60_000,
  });

  const { data: liveData, isLoading: liveLoading } = useQuery({
    queryKey: ['live-tracking', 'live-admin', liveRange.fromUtc, liveRange.toUtc],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (liveRange.fromUtc) params.set('from_utc', liveRange.fromUtc);
      if (liveRange.toUtc) params.set('to_utc', liveRange.toUtc);
      const query = params.toString();
      const res = await fetch(`/api/live-tracking/live${query ? `?${query}` : ''}`);
      return res.json() as Promise<ApiResponse<{ sessions: LiveTrackingLiveRow[] }>>;
    },
    refetchInterval: 5_000,
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
  const liveSessions = useMemo(
    () => liveData?.data?.sessions ?? [],
    [liveData?.data?.sessions],
  );
  const liveEmployeeOptions = useMemo(() => {
    const seen = new Set<number>();
    const opts: Array<{ id: number; label: string }> = [];
    for (const s of liveSessions) {
      if (seen.has(s.employee_id)) continue;
      seen.add(s.employee_id);
      opts.push({ id: s.employee_id, label: `${s.employee_name} (${s.emp_id})` });
    }
    return opts.sort((a, b) => a.label.localeCompare(b.label));
  }, [liveSessions]);
  const filteredLiveSessions = useMemo(
    () =>
      liveEmployeeFilter === 'all'
        ? liveSessions
        : liveSessions.filter(s => s.employee_id === liveEmployeeFilter),
    [liveSessions, liveEmployeeFilter],
  );
  const selectedLiveSession =
    filteredLiveSessions.find(s => s.session_id === selectedLiveSessionId) ??
    filteredLiveSessions[0] ??
    null;
  const selectedLat =
    selectedLiveSession?.latitude != null ? Number(selectedLiveSession.latitude) : null;
  const selectedLng =
    selectedLiveSession?.longitude != null ? Number(selectedLiveSession.longitude) : null;
  const selectedHasCoords =
    selectedLat != null &&
    selectedLng != null &&
    Number.isFinite(selectedLat) &&
    Number.isFinite(selectedLng);
  const selectedPath = useMemo(
    () => selectedLiveSession?.path ?? [],
    [selectedLiveSession?.path],
  );
  // Builds a self-contained Leaflet + OpenStreetMap page that draws the EXACT
  // route the employee walked (blue polyline), with a green start marker and a
  // red latest marker, on a real street map. Keyless — no Google Cloud needed.
  const routeMapSrc = useMemo(() => {
    let pts = selectedPath
      .map(p => [Number(p.latitude), Number(p.longitude)] as [number, number])
      .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
    if (pts.length < 1 && selectedHasCoords) {
      pts = [[Number(selectedLat), Number(selectedLng)]];
    }
    if (pts.length < 1) return null;
    const data = JSON.stringify(pts);
    return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>html,body,#map{margin:0;height:100%;width:100%}</style></head>
<body><div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
var pts=${data};
var map=L.map('map');
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(map);
if(pts.length>1){var line=L.polyline(pts,{color:'#2563eb',weight:4,opacity:0.9}).addTo(map);map.fitBounds(line.getBounds(),{padding:[25,25]});}else{map.setView(pts[0],17);}
L.circleMarker(pts[0],{color:'#16a34a',fillColor:'#16a34a',fillOpacity:1,radius:6}).addTo(map).bindPopup('Start');
L.circleMarker(pts[pts.length-1],{color:'#dc2626',fillColor:'#dc2626',fillOpacity:1,radius:6}).addTo(map).bindPopup('Latest');
</script></body></html>`;
  }, [selectedPath, selectedHasCoords, selectedLat, selectedLng]);
  const present = records.filter(r => r.status === 'present' || r.status === 'late').length;
  const absent = records.filter(r => r.status === 'absent').length;
  const totalMinutes = records.reduce((s, r) => s + (r.total_minutes ?? 0), 0);
  const avgHours = records.length > 0 ? (totalMinutes / records.length / 60).toFixed(1) : '0';

  const isLoading = empLoading || attLoading;

  const displayTime = now.toLocaleTimeString(IST_LOCALE, { timeZone: IST, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

  useEffect(() => {
    if (!filteredLiveSessions.length) {
      setSelectedLiveSessionId(null);
      return;
    }
    if (
      !selectedLiveSessionId ||
      !filteredLiveSessions.some(s => s.session_id === selectedLiveSessionId)
    ) {
      setSelectedLiveSessionId(filteredLiveSessions[0].session_id);
    }
  }, [filteredLiveSessions, selectedLiveSessionId]);

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
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
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
          label="Absent Today"
          value={absent}
          loading={isLoading}
          variant="danger"
          icon={
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
        <StatCard
          label="Avg Hours Today"
          value={isLoading ? '…' : `${avgHours}h`}
          loading={isLoading}
          variant="warning"
          icon={
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
      </div>

      {/* Today attendance table */}
      <Card padding={false}>
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <h2 className="font-semibold text-slate-800 dark:text-slate-200">Today Attendance</h2>
          <span className="text-xs text-slate-400 dark:text-slate-500">
            Auto-refreshes every 60s
          </span>
        </div>

        {attLoading ? (
          <div className="flex justify-center py-12"><Spinner /></div>
        ) : (
          <Table
            columns={[
              {
                key: 'employee_name',
                header: 'Employee',
                render: r => (
                  <div>
                    <p className="font-medium text-slate-800 dark:text-slate-200">{(r as AttRow).employee_name ?? '—'}</p>
                    <p className="text-xs text-slate-400">{(r as AttRow).emp_id}</p>
                  </div>
                ),
              },
              {
                key: 'clock_in_utc',
                header: 'Clock In',
                render: r => toIST((r as AttRow).clock_in_utc),
              },
              {
                key: 'clock_out_utc',
                header: 'Clock Out',
                render: r => toIST((r as AttRow).clock_out_utc),
              },
              {
                key: 'total_minutes',
                header: 'Hours',
                render: r => {
                  const m = (r as AttRow).total_minutes;
                  return m != null ? `${Math.floor(m / 60)}h ${m % 60}m` : '—';
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
              {
                key: 'location_name',
                header: 'Location',
                render: r => {
                  const row = r as AttRow;
                  return row.location_name ? (
                    <div>
                      <p className="text-sm">{row.location_name}</p>
                      <p className="text-xs text-slate-400">{row.location_address ?? ''}</p>
                    </div>
                  ) : <span className="text-slate-400 text-xs">No location assigned</span>;
                },
              },
              {
                key: 'geofence_status',
                header: 'Geofence',
                render: r => {
                  const g = (r as AttRow).geofence_status;
                  if (g === 'not_required') return <span className="text-slate-400 text-xs">—</span>;
                  return <Badge variant={g === 'inside' ? 'success' : 'danger'}>{g}</Badge>;
                },
              },
              { key: 'work_date', header: 'Date', render: r => formatDateOnly((r as AttRow).work_date) },
              {
                key: 'signal',
                header: 'Signal',
                render: r => {
                  const age = getSignalAgeMinutes((r as LiveTrackingLiveRow).last_ping_utc);
                  if (age == null) return <Badge variant="neutral">Unknown</Badge>;
                  if (age <= 2) return <Badge variant="success">Active</Badge>;
                  if (age <= 5) return <Badge variant="warning">Delayed</Badge>;
                  return <Badge variant="danger">Lost</Badge>;
                },
              },
            ]}
            data={records as object[]}
            emptyMessage="No attendance records for today."
          />
        )}
      </Card>

      {/* Live tracking table */}
      <Card padding={false}>
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-slate-800 dark:text-slate-200">Live Tracking</h2>
            <span className="text-xs text-slate-400 dark:text-slate-500">Auto-refreshes every 5s</span>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={liveEmployeeFilter}
              onChange={e => {
                const v = e.target.value;
                setLiveEmployeeFilter(v === 'all' ? 'all' : Number(v));
              }}
              className="text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1"
            >
              <option value="all">All employees</option>
              {liveEmployeeOptions.map(opt => (
                <option key={opt.id} value={opt.id}>{opt.label}</option>
              ))}
            </select>
            <select
              value={liveRangePreset}
              onChange={e => setLiveRangePreset(e.target.value as LiveRangePreset)}
              className="text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1"
            >
              <option value="30m">Last 30 min</option>
              <option value="2h">Last 2 hours</option>
              <option value="8h">Last 8 hours</option>
              <option value="24h">Last 24 hours</option>
              <option value="custom">Custom</option>
            </select>
            {liveRangePreset === 'custom' && (
              <>
                <input
                  type="datetime-local"
                  value={customFromLocal}
                  onChange={e => setCustomFromLocal(e.target.value)}
                  className="text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1"
                />
                <input
                  type="datetime-local"
                  value={customToLocal}
                  onChange={e => setCustomToLocal(e.target.value)}
                  className="text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1"
                />
              </>
            )}
          </div>
        </div>
        {liveLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : (
          <Table
            columns={[
              {
                key: 'employee_name',
                header: 'Employee',
                render: r => (
                  <div>
                    <p className="font-medium text-slate-800 dark:text-slate-200">{(r as LiveTrackingLiveRow).employee_name}</p>
                    <p className="text-xs text-slate-400">{(r as LiveTrackingLiveRow).emp_id}</p>
                  </div>
                ),
              },
              { key: 'last_ping_utc', header: 'Last Update', render: r => toIST((r as LiveTrackingLiveRow).last_ping_utc) },
              {
                key: 'coords',
                header: 'Coordinates',
                render: r => {
                  const row = r as LiveTrackingLiveRow;
                  if (row.latitude == null || row.longitude == null) return '—';
                  const lat = Number(row.latitude);
                  const lng = Number(row.longitude);
                  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '—';
                  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
                },
              },
              {
                key: 'accuracy_meters',
                header: 'Accuracy',
                render: r => {
                  const a = (r as LiveTrackingLiveRow).accuracy_meters;
                  if (a == null) return '—';
                  const accuracy = Number(a);
                  return Number.isFinite(accuracy) ? `±${accuracy.toFixed(0)}m` : '—';
                },
              },
              {
                key: 'path_points',
                header: 'Path Points',
                render: r => ((r as LiveTrackingLiveRow).path?.length ?? 0),
              },
            ]}
            data={filteredLiveSessions as object[]}
            emptyMessage="No active live-tracking sessions."
            onRowClick={row => setSelectedLiveSessionId((row as LiveTrackingLiveRow).session_id)}
            rowClassName={row =>
              (row as LiveTrackingLiveRow).session_id === selectedLiveSessionId
                ? 'bg-blue-50 dark:bg-blue-900/20'
                : ''
            }
          />
        )}
        {selectedLiveSession && (
          <div className="p-4 border-t border-slate-200 dark:border-slate-700 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Live Map: {selectedLiveSession.employee_name} ({selectedLiveSession.emp_id})
              </p>
              {selectedHasCoords && (
                <a
                  href={`https://www.google.com/maps?q=${selectedLat},${selectedLng}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                >
                  Open in Maps
                </a>
              )}
            </div>
            {routeMapSrc ? (
              <div className="space-y-2">
                <p className="text-xs font-medium text-slate-600 dark:text-slate-300">
                  Movement route ({selectedPath.length} point{selectedPath.length === 1 ? '' : 's'})
                </p>
                <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
                  <iframe
                    title="Movement route map"
                    srcDoc={routeMapSrc}
                    className="w-full h-80"
                    loading="lazy"
                  />
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Blue line is the exact path taken · green is start · red is latest location.
                </p>
              </div>
            ) : (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Waiting for tracking points — they appear here as the employee moves.
              </p>
            )}
          </div>
        )}
      </Card>

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

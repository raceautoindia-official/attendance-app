'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Table from '@/components/ui/Table';
import Card from '@/components/ui/Card';
import Spinner from '@/components/ui/Spinner';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// Live Tracking, as its own panel.
//
// It used to be one section of the Overview page, below the day's attendance.
// It is the screen an admin watches while someone is out of the office, so it
// now has a page of its own in the sidebar.
// ---------------------------------------------------------------------------

export type LiveTrackingLiveRow = {
  /** NULL when the employee is on shift but their phone is not reporting. */
  session_id: number | null;
  employee_id: number;
  emp_id: string;
  employee_name: string;
  started_at_utc: string;
  last_ping_utc: string | null;
  tracked_at_utc: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracy_meters: number | null;
  /** The work site this employee marks attendance at */
  location_name?: string | null;
  location_address?: string | null;
  path?: Array<{
    tracked_at_utc: string;
    latitude: number;
    longitude: number;
    accuracy_meters: number | null;
  }>;
  /** Every fix recorded, unfiltered — what the location log shows */
  recorded_path?: Array<{
    tracked_at_utc: string;
    latitude: number;
    longitude: number;
    accuracy_meters: number | null;
  }>;
  recorded_count?: number;
};

type LiveRangePreset = '30m' | '2h' | '8h' | '24h' | 'custom';

const IST = 'Asia/Kolkata';
const IST_LOCALE = 'en-IN';

function toIST(d: Date | string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleTimeString(IST_LOCALE, { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: true });
}

/** Time with seconds — the movement log needs finer resolution than hh:mm. */
function toISTSeconds(d: Date | string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleTimeString(IST_LOCALE, {
    timeZone: IST, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  });
}

/** Metres between two coordinates — used for the step distance in the log. */
function metresBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** "1m 20s" / "45s" — gap between consecutive tracking points. */
function gapLabel(fromIso: string, toIso: string): string {
  const secs = Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 1000);
  if (!Number.isFinite(secs) || secs < 0) return '';
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/**
 * Whether this employee's phone is actually reporting.
 *
 * The page lists everyone who is CLOCKED IN, so a phone that has stopped
 * sending now appears as a row of dashes rather than vanishing. Without a
 * column saying so, that row looks like a fault in the page — which is exactly
 * the confusion the old behaviour caused, only quieter.
 */
function phoneState(row: LiveTrackingLiveRow): { label: string; tone: string; title: string } {
  if (row.session_id == null) {
    return {
      label: 'Not reporting',
      tone: 'text-red-600 dark:text-red-400',
      title: 'Clocked in, but no live-tracking session. The app is not running on their phone.',
    };
  }
  if (!row.last_ping_utc) {
    return {
      label: 'No fixes yet',
      tone: 'text-amber-600 dark:text-amber-400',
      title: 'Tracking started but the phone has not sent a location yet.',
    };
  }
  const mins = Math.max(0, Math.floor((Date.now() - new Date(row.last_ping_utc).getTime()) / 60_000));
  if (mins <= 2) return { label: 'Live', tone: 'text-green-600 dark:text-green-400', title: `Last fix ${mins} min ago` };
  if (mins <= 15) return { label: `${mins} min ago`, tone: 'text-amber-600 dark:text-amber-400', title: 'Reporting, but slower than the 15-second interval — battery optimisation is likely on.' };
  return { label: `${mins} min ago`, tone: 'text-red-600 dark:text-red-400', title: 'The phone has gone quiet. Check location permission and battery optimisation.' };
}

export default function LiveTrackingPanel() {
  // Selection is keyed on EMPLOYEE, not session: an employee whose phone is not
  // reporting has no session id at all, and keying on that would make every
  // such row unselectable — and indistinguishable from each other.
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<number | null>(null);
  // 'recorded' = every fix the phone sent; 'route' = the jitter-filtered path
  // drawn on the map. Defaults to recorded so the log is a true audit trail.
  const [logMode, setLogMode] = useState<'recorded' | 'route'>('recorded');
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
      '30m': 30, '2h': 120, '8h': 480, '24h': 1440,
    };
    const from = new Date(now.getTime() - minutesMap[liveRangePreset] * 60_000);
    return { fromUtc: from.toISOString(), toUtc: now.toISOString() };
  }, [liveRangePreset, customFromLocal, customToLocal]);

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
    filteredLiveSessions.find(s => s.employee_id === selectedEmployeeId) ??
    filteredLiveSessions[0] ??
    null;
  const selectedLat =
    selectedLiveSession?.latitude != null ? Number(selectedLiveSession.latitude) : null;
  const selectedLng =
    selectedLiveSession?.longitude != null ? Number(selectedLiveSession.longitude) : null;
  const selectedHasCoords =
    selectedLat != null && selectedLng != null &&
    Number.isFinite(selectedLat) && Number.isFinite(selectedLng);
  const selectedPath = useMemo(
    () => selectedLiveSession?.path ?? [],
    [selectedLiveSession?.path],
  );
  // The log defaults to EVERY recorded fix — "exactly where, and when". The
  // map's filtered route is available as a second view for reading movement.
  const selectedRecordedPath = useMemo(
    () => selectedLiveSession?.recorded_path ?? [],
    [selectedLiveSession?.recorded_path],
  );
  const logPoints = logMode === 'recorded' ? selectedRecordedPath : selectedPath;
  const recordedTotal = selectedLiveSession?.recorded_count ?? selectedRecordedPath.length;

  // Stable JSON signature of the route points. Because it's a string compared
  // by value, the map iframe below only re-renders when the path actually
  // changes — not on every 5s poll — so live updates are smooth (no reload
  // flicker) and feel real-time.
  const routePointsJson = useMemo(() => {
    const fmt = (iso: string | null | undefined) =>
      iso
        ? new Date(iso).toLocaleTimeString(IST_LOCALE, {
            timeZone: IST, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
          })
        : '';
    let pts = selectedPath
      .map(p => ({ lat: Number(p.latitude), lng: Number(p.longitude), t: fmt(p.tracked_at_utc) }))
      .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (pts.length < 1 && selectedHasCoords) {
      pts = [{ lat: Number(selectedLat), lng: Number(selectedLng), t: '' }];
    }
    return pts.length ? JSON.stringify(pts) : null;
  }, [selectedPath, selectedHasCoords, selectedLat, selectedLng]);

  // Self-contained Leaflet + OpenStreetMap page drawing the exact route on real
  // streets — white casing under a bold blue line, a clickable dot at every
  // recorded point that shows the IST time the employee was there, green start
  // + red latest markers. Keyless (no Google Cloud).
  const routeMapSrc = useMemo(() => {
    if (!routePointsJson) return null;
    return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>html,body,#map{margin:0;height:100%;width:100%}.leaflet-popup-content{font:13px system-ui;margin:8px 12px}</style></head>
<body><div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
var pts=${routePointsJson};
var ll=pts.map(function(p){return [p.lat,p.lng];});
var map=L.map('map',{zoomControl:true});
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(map);
function popup(prefix,p){return '<b>'+prefix+'</b><br/>🕐 '+(p.t||'-');}
if(ll.length>1){
  L.polyline(ll,{color:'#ffffff',weight:9,opacity:0.95,lineJoin:'round',lineCap:'round'}).addTo(map);
  var line=L.polyline(ll,{color:'#2563eb',weight:5,opacity:1,lineJoin:'round',lineCap:'round'}).addTo(map);
  for(var i=1;i<pts.length-1;i++){
    L.circleMarker(ll[i],{radius:5,color:'#2563eb',fillColor:'#ffffff',fillOpacity:1,weight:2}).addTo(map).bindPopup(popup('Was here at',pts[i]));
  }
  map.fitBounds(line.getBounds(),{padding:[35,35]});
}else{map.setView(ll[0],17);}
L.circleMarker(ll[0],{color:'#ffffff',weight:3,fillColor:'#16a34a',fillOpacity:1,radius:8}).addTo(map).bindPopup(popup('Start',pts[0]));
L.circleMarker(ll[ll.length-1],{color:'#ffffff',weight:3,fillColor:'#dc2626',fillOpacity:1,radius:8}).addTo(map).bindPopup(popup('Latest',pts[pts.length-1]));
</script></body></html>`;
  }, [routePointsJson]);

  useEffect(() => {
    if (!filteredLiveSessions.length) {
      setSelectedEmployeeId(null);
      return;
    }
    if (
      selectedEmployeeId == null ||
      !filteredLiveSessions.some(s => s.employee_id === selectedEmployeeId)
    ) {
      setSelectedEmployeeId(filteredLiveSessions[0].employee_id);
    }
  }, [filteredLiveSessions, selectedEmployeeId]);

  const reporting = filteredLiveSessions.filter(s => s.session_id != null && s.last_ping_utc).length;

  return (
    <Card padding={false}>
      <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="font-semibold text-slate-800 dark:text-slate-200">Live Tracking</h2>
          <span className="text-xs text-slate-400 dark:text-slate-500">
            {filteredLiveSessions.length} on shift · {reporting} reporting · auto-refreshes every 5s
          </span>
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
            {
              key: 'phone',
              header: 'Phone',
              render: r => {
                const s = phoneState(r as LiveTrackingLiveRow);
                return <span className={`text-xs font-medium ${s.tone}`} title={s.title}>{s.label}</span>;
              },
            },
            { key: 'last_ping_utc', header: 'Last Update', render: r => toIST((r as LiveTrackingLiveRow).last_ping_utc) },
            {
              key: 'location_name',
              header: 'Attendance Location',
              render: r => {
                const row = r as LiveTrackingLiveRow;
                if (!row.location_name) {
                  return <span className="text-slate-400" title="No work site assigned in Schedules">Not set</span>;
                }
                return (
                  <div className="min-w-0">
                    <p className="truncate font-medium text-slate-700 dark:text-slate-300">{row.location_name}</p>
                    {row.location_address && (
                      <p className="truncate text-xs text-slate-400">{row.location_address}</p>
                    )}
                  </div>
                );
              },
            },
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
          emptyMessage="Nobody is clocked in right now."
          onRowClick={row => setSelectedEmployeeId((row as LiveTrackingLiveRow).employee_id)}
          rowClassName={row =>
            (row as LiveTrackingLiveRow).employee_id === selectedEmployeeId
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

              {/* Numbered movement log: every recorded location in order,
                  with the exact IST time the employee was there. */}
              {logPoints.length > 0 && (
                <div className="rounded-lg border border-slate-200 dark:border-slate-700">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-700">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      Location Log — {logPoints.length} point{logPoints.length === 1 ? '' : 's'}
                      {logMode === 'recorded' && recordedTotal > logPoints.length && (
                        <span className="ml-1 font-normal normal-case text-amber-600 dark:text-amber-400">
                          (latest {logPoints.length} of {recordedTotal})
                        </span>
                      )}
                    </p>
                    <div className="flex items-center gap-2">
                      <div className="flex gap-1 rounded-md bg-slate-100 p-0.5 dark:bg-slate-800">
                        {([['recorded', 'Every fix'], ['route', 'Movement only']] as const).map(([key, label]) => (
                          <button
                            key={key}
                            onClick={() => setLogMode(key)}
                            className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                              logMode === key
                                ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
                                : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <p className="text-xs tabular-nums text-slate-400">
                        {toISTSeconds(logPoints[0].tracked_at_utc)}
                        {' → '}
                        {toISTSeconds(logPoints[logPoints.length - 1].tracked_at_utc)}
                      </p>
                    </div>
                  </div>
                  <div className="max-h-72 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-700/50">
                    {logPoints.map((p, i) => {
                      const lat = Number(p.latitude);
                      const lng = Number(p.longitude);
                      const prev = i > 0 ? logPoints[i - 1] : null;
                      const step = prev
                        ? Math.round(metresBetween(Number(prev.latitude), Number(prev.longitude), lat, lng))
                        : null;
                      const gap = prev ? gapLabel(prev.tracked_at_utc, p.tracked_at_utc) : '';
                      const isLast = i === logPoints.length - 1;
                      return (
                        <div key={`${p.tracked_at_utc}-${i}`} className="flex items-start gap-3 px-3 py-2">
                          <span
                            className={`mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                              i === 0
                                ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
                                : isLast
                                  ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                                  : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
                            }`}
                          >
                            {i + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-medium tabular-nums text-slate-800 dark:text-slate-200">
                              {toISTSeconds(p.tracked_at_utc)}
                              {i === 0 && <span className="ml-2 font-normal text-green-600 dark:text-green-400">start</span>}
                              {isLast && i !== 0 && <span className="ml-2 font-normal text-red-600 dark:text-red-400">latest</span>}
                            </p>
                            <p className="mt-0.5 truncate text-xs tabular-nums text-slate-500 dark:text-slate-400">
                              {lat.toFixed(6)}, {lng.toFixed(6)}
                              {p.accuracy_meters != null && ` · ±${Number(p.accuracy_meters).toFixed(0)}m`}
                              {step != null && ` · moved ${step}m in ${gap}`}
                            </p>
                          </div>
                          <a
                            href={`https://www.google.com/maps?q=${lat},${lng}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-0.5 flex-shrink-0 text-xs text-blue-600 hover:underline dark:text-blue-400"
                          >
                            Map ↗
                          </a>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {selectedLiveSession.session_id == null
                ? 'This phone is not sending locations. Check that the app is installed and updated, that location permission is "Allow all the time", and that battery optimisation is off for the app.'
                : 'Waiting for tracking points — they appear here as the employee moves.'}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

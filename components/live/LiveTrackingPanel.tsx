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

/**
 * Minutes in one spot before it counts as STOOD STILL, and is drawn orange.
 *
 * One constant so the map badge, the ring, the popup and the employee list
 * cannot come to different conclusions about the same stop.
 *
 * "One spot" is within the same 40 m jitter radius the numbered marks already
 * merge on — a stationary phone's GPS wanders a few metres per fix, and
 * treating that wander as movement is what once turned somebody sitting at a
 * desk into a pile of 79 separate badges.
 */
const STATIONARY_MIN = 10;
/** Same 40 m the numbered marks merge on — see STATIONARY_MIN. */
const STATIONARY_JITTER_M = 40;

/**
 * How long this employee has been standing in the same place, right now.
 *
 * Walks BACKWARDS from the newest fix while each one stays within the jitter
 * radius of it, and returns the span covered. Backwards because the question
 * is about the present: a two-hour stop this morning is history, whereas
 * "has not moved for 40 minutes" is the thing worth noticing on a live screen.
 *
 * Returns 0 when they are moving, so the caller can simply compare against
 * STATIONARY_MIN.
 */
function stationaryMinutes(
  path: Array<{ latitude: number | string; longitude: number | string; tracked_at_utc: string }>,
): number {
  if (!path.length) return 0;
  const last = path[path.length - 1];
  const lat = Number(last.latitude);
  const lng = Number(last.longitude);
  const endMs = new Date(last.tracked_at_utc).getTime();
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Number.isNaN(endMs)) return 0;

  let startMs = endMs;
  for (let i = path.length - 2; i >= 0; i--) {
    const p = path[i];
    const pLat = Number(p.latitude);
    const pLng = Number(p.longitude);
    const ms = new Date(p.tracked_at_utc).getTime();
    if (!Number.isFinite(pLat) || !Number.isFinite(pLng) || Number.isNaN(ms)) continue;
    if (metresBetween(lat, lng, pLat, pLng) > STATIONARY_JITTER_M) break;
    startMs = ms;
  }
  return Math.max(0, Math.round((endMs - startMs) / 60_000));
}

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
      title: 'The app on their phone has stopped sending. The coordinates shown are their last known position — ask them to open the app once to restart tracking.',
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
  if (mins <= 15) return { label: `${mins} min ago`, tone: 'text-amber-600 dark:text-amber-400', title: 'Reporting, but slower than the 30-second interval — battery optimisation is likely on.' };
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
  // REVIEWING A FINISHED DAY. Empty = live.
  //
  // Live only ever lists people who are clocked in RIGHT NOW, so once everybody
  // has gone home the page is empty and the day cannot be looked at. With a
  // date it lists that day's people whether or not they clocked out, and draws
  // the whole day's path.
  const [reviewDate, setReviewDate] = useState('');

  const liveRange = useMemo(() => {
    const now = new Date();
    // Reviewing a day, the server bounds the points to that work day. Sending a
    // "last 2 hours" window as well would cut the morning off it.
    if (reviewDate) return { fromUtc: null, toUtc: null };
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
  }, [liveRangePreset, customFromLocal, customToLocal, reviewDate]);

  const { data: liveData, isLoading: liveLoading } = useQuery({
    queryKey: ['live-tracking', 'live-admin', liveRange.fromUtc, liveRange.toUtc, reviewDate],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (reviewDate) params.set('date', reviewDate);
      if (liveRange.fromUtc) params.set('from_utc', liveRange.fromUtc);
      if (liveRange.toUtc) params.set('to_utc', liveRange.toUtc);
      const query = params.toString();
      const res = await fetch(`/api/live-tracking/live${query ? `?${query}` : ''}`);
      return res.json() as Promise<ApiResponse<{ sessions: LiveTrackingLiveRow[] }>>;
    },
    // A finished day does not change, so stop polling it. Left at 5s, reviewing
    // yesterday would re-run the whole day's path query twelve times a minute
    // for as long as the tab stayed open.
    refetchInterval: reviewDate ? false : 5_000,
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
  // One numbered mark per MINUTE of the employee's trail — 1 where the window
  // starts, counting up to the latest position. The raw fixes arrive every 15
  // seconds, which as anonymous dots is unreadable: you can see WHERE somebody
  // was but not in what order. Numbered minute-marks make the route read like
  // a story — 1, 2, 3 … — which is what an admin actually follows.
  //
  // The LAST fix inside each minute wins its bucket (where the minute ended),
  // and long windows are thinned to at most 120 marks, renumbered so the
  // sequence stays 1..N; every mark's popup still carries its exact time.
  const minuteMarksJson = useMemo(() => {
    const fmt = (iso: string | null | undefined) =>
      iso
        ? new Date(iso).toLocaleTimeString(IST_LOCALE, {
            timeZone: IST, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
          })
        : '';
    const buckets = new Map<number, { lat: number; lng: number; t: string; ms: number }>();
    for (const p of selectedRecordedPath) {
      const ms = new Date(p.tracked_at_utc).getTime();
      const lat = Number(p.latitude);
      const lng = Number(p.longitude);
      if (!Number.isFinite(ms) || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      buckets.set(Math.floor(ms / 60_000), { lat, lng, t: fmt(p.tracked_at_utc), ms });
    }
    const bucketed = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, m]) => m);
    // A number should advance when the PERSON moves, not when the signal
    // wobbles. GPS on a stationary phone drifts a few metres each fix, and one
    // badge per minute turned somebody sitting at a desk into a 79-badge pile.
    // Consecutive minute-marks within jitter distance of the last KEPT badge
    // merge into it as a dwell — the badge remembers when they arrived (t) and
    // when they were last seen there (t2), so its popup reads "2:10 – 3:29 pm"
    // instead of pretending 79 separate visits.
    const JITTER_M = 40;
    type Mark = {
      lat: number; lng: number; t: string; t2?: string;
      ms: number; ms2: number; dwellMin: number;
    };
    let marks: Mark[] = [];
    for (const m of bucketed) {
      const prev = marks[marks.length - 1];
      if (prev && metresBetween(prev.lat, prev.lng, m.lat, m.lng) <= JITTER_M) {
        // Still there — extend the dwell rather than adding another badge.
        prev.t2 = m.t;
        prev.ms2 = m.ms;
        prev.dwellMin = Math.round((prev.ms2 - prev.ms) / 60_000);
      } else {
        marks.push({ ...m, ms2: m.ms, dwellMin: 0 });
      }
    }
    if (!marks.length && selectedHasCoords) {
      marks = [{ lat: Number(selectedLat), lng: Number(selectedLng), t: '', ms: 0, ms2: 0, dwellMin: 0 }];
    }
    const MAX_MARKS = 120;
    if (marks.length > MAX_MARKS) {
      const step = Math.ceil(marks.length / MAX_MARKS);
      const last = marks[marks.length - 1];
      marks = marks.filter((_, i) => i % step === 0);
      if (marks[marks.length - 1] !== last) marks.push(last);
    }
    return marks.length
      ? JSON.stringify(marks.map((m, i) => ({ ...m, n: i + 1 })))
      : null;
  }, [selectedRecordedPath, selectedHasCoords, selectedLat, selectedLng]);

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
    const dwellMin = STATIONARY_MIN;
    if (!routePointsJson && !minuteMarksJson) return null;
    return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>html,body,#map{margin:0;height:100%;width:100%}.leaflet-popup-content{font:13px system-ui;margin:8px 12px}</style></head>
<body><div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
var pts=${routePointsJson ?? '[]'};
var marks=${minuteMarksJson ?? '[]'};
var map=L.map('map',{zoomControl:true});
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(map);
// The line follows the jitter-filtered route so it hugs real streets…
var ll=pts.map(function(p){return [p.lat,p.lng];});
if(ll.length>1){
  L.polyline(ll,{color:'#ffffff',weight:9,opacity:0.95,lineJoin:'round',lineCap:'round'}).addTo(map);
  L.polyline(ll,{color:'#2563eb',weight:5,opacity:1,lineJoin:'round',lineCap:'round'}).addTo(map);
}
// …while the numbered marks are one per MINUTE: 1 is where the window starts,
// the highest number is where they are now. Click any number for its time.
function badge(n,bg){return L.divIcon({className:'',iconSize:[24,24],iconAnchor:[12,12],
  html:'<div style="width:24px;height:24px;border-radius:50%;background:'+bg+';color:#fff;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.45);font:700 11px system-ui;display:flex;align-items:center;justify-content:center">'+n+'</div>'});}
var group=[];
marks.forEach(function(m,i){
  // ORANGE = STOOD STILL. A stop of ${dwellMin} minutes or more in one place is the
  // thing an admin is scanning for, and it was drawn the same blue as a badge
  // somebody walked straight past. Orange wins over the blue middle badges but
  // never over Start and Latest, which answer a different question — where the
  // trail begins and where the person is NOW.
  var stationary = (m.dwellMin||0) >= ${dwellMin};
  var bg = i===0 ? '#16a34a'
         : (i===marks.length-1 ? '#dc2626'
         : (stationary ? '#f97316' : '#2563eb'));
  var when = m.t2 && m.t2!==m.t ? m.t+' – '+m.t2 : m.t;
  var label = (i===0?'Start':(i===marks.length-1?'Latest':'Stop'))+' #'+m.n+(when?'<br/>🕐 '+when:'')
    + (stationary ? '<br/><b style="color:#c2410c">Stayed here '+m.dwellMin+' min</b>' : '');
  // A ring around the stop, sized so it reads at a glance without hiding the
  // street underneath.
  if(stationary){
    L.circle([m.lat,m.lng],{radius:45,color:'#f97316',weight:2,opacity:0.9,
      fillColor:'#f97316',fillOpacity:0.18}).addTo(map).bindPopup(label);
  }
  group.push(L.marker([m.lat,m.lng],{icon:badge(m.n,bg),zIndexOffset:i===marks.length-1?1000:(stationary?800:i===0?900:0)})
    .addTo(map).bindPopup(label));
});
var bounds = ll.length>1 ? L.polyline(ll).getBounds() : null;
if(marks.length>1){var mb=L.latLngBounds(marks.map(function(m){return [m.lat,m.lng];}));bounds=bounds?bounds.extend(mb):mb;}
if(bounds && (ll.length>1||marks.length>1)){map.fitBounds(bounds,{padding:[35,35]});}
else if(marks.length===1){map.setView([marks[0].lat,marks[0].lng],17);}
else if(ll.length===1){map.setView(ll[0],17);}
</script></body></html>`;
  }, [routePointsJson, minuteMarksJson]);

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
          <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            Review day
            <input
              type="date"
              value={reviewDate}
              onChange={e => setReviewDate(e.target.value)}
              className="text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1"
            />
          </label>
          {reviewDate && (
            <button
              onClick={() => setReviewDate('')}
              className="text-xs rounded-md border border-slate-300 dark:border-slate-700 px-2 py-1 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              Back to live
            </button>
          )}
          <select
            value={liveRangePreset}
            onChange={e => setLiveRangePreset(e.target.value as LiveRangePreset)}
            disabled={!!reviewDate}
            className="text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1 disabled:opacity-40"
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
            {
              key: 'stationary',
              header: 'Movement',
              // Orange here for the same reason it is orange on the map: an
              // admin should not have to open each employee's trail to find
              // out who has not moved. The map shows WHERE the stop is; this
              // shows WHO is in one.
              render: r => {
                const row = r as LiveTrackingLiveRow;
                const mins = stationaryMinutes(row.recorded_path ?? row.path ?? []);
                if (!(row.recorded_path?.length || row.path?.length)) {
                  return <span className="text-xs text-slate-400">—</span>;
                }
                if (mins >= STATIONARY_MIN) {
                  return (
                    <span
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-orange-600 dark:text-orange-400"
                      title={`No movement beyond ${STATIONARY_JITTER_M} m for ${mins} minutes`}
                    >
                      <span className="inline-block h-2.5 w-2.5 rounded-full bg-orange-500" />
                      Same place {mins}m
                    </span>
                  );
                }
                return (
                  <span className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                    <span className="inline-block h-2.5 w-2.5 rounded-full bg-green-500" />
                    Moving
                  </span>
                );
              },
            },
            {
            key: 'last_ping_utc',
            header: 'Last Update',
            // Falls back to the newest FIX when there is no session: a phone
            // that stopped still has a last-seen moment, and rendering a dash
            // next to real coordinates read as a contradiction — it was the
            // first question asked about this screen.
            render: r => {
              const row = r as LiveTrackingLiveRow;
              return toIST(row.last_ping_utc ?? row.tracked_at_utc);
            },
          },
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
                Numbers mark each place they stopped or passed, in order — 1 (green) first, the highest (red) latest. Someone who stays put keeps ONE badge; its time shows how long they were there. Tap a number for times. The blue line is the path taken.
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

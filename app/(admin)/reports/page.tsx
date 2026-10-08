'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import Table from '@/components/ui/Table';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Modal from '@/components/ui/Modal';
import Badge from '@/components/ui/Badge';
import Pagination from '@/components/ui/Pagination';
import Spinner from '@/components/ui/Spinner';
import Card from '@/components/ui/Card';
import { formatDateOnly } from '@/lib/date';
import type { Employee, ApiResponse, AttendanceRecord } from '@/lib/types';
import EmployeeLedger from '@/components/hours/EmployeeLedger';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

/** One employee, one day — the day-wise report's row. */
interface DailyRow {
  employee_id: number;
  employee_name: string;
  emp_id: string;
  date: string;
  /** Mon, Tue, … */
  day: string;
  check_in_utc: string | null;
  check_out_utc: string | null;
  break_minutes: number | null;
  worked_minutes: number | null;
  /** What the roster asked for. Null when no shift is rostered, 0 when the day asked nothing. */
  required_minutes: number | null;
  credited_minutes: number;
  shortage_minutes: number;
  /** null when the day has no start time to be late against. */
  late_minutes: number | null;
  overtime_minutes: number;
  permission_minutes: number;
  leave_type: string | null;
  /** Includes 'weekly_off', which is not an attendance status. */
  day_status: string;
  work_update: string | null;
}

function toIST(d: string | null): string {
  if (!d) return '—';
  const parsed = new Date(d);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

interface SummaryRow {
  id: number;
  emp_id: string;
  name: string;
  total_days_present: number;
  total_days_late: number;
  total_days_absent: number;
  total_days_leave: number;
  total_minutes_worked: number;
  /** Approved permission minutes in the period */
  total_permission_minutes: number;
  /** Worked minutes topped up by permission, capped per day at the shift length */
  total_minutes_credited: number;
  /** Minutes worked beyond the rostered day */
  total_overtime_minutes?: number;
  /** On-site or off-site — whether this employee is fenced at all. */
  work_mode?: string;
  /** Days in the period on which they posted a work update. */
  daily_updates_count?: number;
  calendar_days?: number;
  company_holidays?: number;
  weekly_off_days?: number;
  late_minutes?: number;
  late_days?: number;
  attendance_percentage?: number | null;
  /**
   * This employee's rostered minutes per day (both shifts, if two). Null when
   * they have no schedule, and also when their shifts work different weekdays
   * — then there is no single per-day figure, only a weekday-by-weekday total.
   */
  required_minutes_per_day: number | null;
  /** Days this employee's shift works in the period */
  working_days: number;
  /** Counted weekday by weekday; null when they have no schedule */
  expected_minutes: number | null;
  days_with_hours: number;
  shift_count?: number;
  shift_names?: string[];
  /** Shifts whose clock windows clash — they cannot both be worked */
  overlapping_shifts?: string[] | null;
}

interface PeriodInfo {
  from_date: string;
  to_date: string;
  total_days: number;
  weekend_days: number;
  festive_holidays: number;
  total_working_days: number;
  total_leave_days: number;
}

interface PeriodTotals {
  employees: number;
  employees_with_shift: number;
  expected_minutes: number;
  minutes_worked: number;
  permission_minutes: number;
  minutes_credited: number;
}

interface LeaveRow {
  id: number;
  leave_date: string;
  leave_type: string;
  notes: string | null;
}

/** Which employee's absent / leave days the drill-down modal is showing. */
interface DrillDown {
  employeeId: number;
  employeeName: string;
  kind: 'absent' | 'leave';
}

function minutesToHours(m: number) {
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Weekday name for a YYYY-MM-DD date, so a listed day reads in context. */
function weekday(ymd: string) {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '';
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    weekday: 'long', timeZone: 'UTC',
  });
}

/**
 * Seeded from the URL so the links that used to point at the Working Hours
 * page still land somewhere useful. /hours?employee=10&month=2026-09 becomes
 * this page, that month, that person's detail already open — a redirect that
 * dropped the parameters would technically work and would still have lost the
 * reader their place.
 */
/** The columns that answer "how did everybody do over this period". */
const CORE_COLUMNS = new Set([
  'name',
  'working_days',
  'total_days_present',
  'total_days_absent',
  'total_days_late',
  'total_minutes_worked',
  'attendance_percentage',
]);

export default function ReportsPage() {
  return (
    <Suspense fallback={<Card><div className="flex justify-center py-10"><Spinner /></div></Card>}>
      <ReportsPageInner />
    </Suspense>
  );
}

function ReportsPageInner() {
  const searchParams = useSearchParams();
  const today = format(new Date(), 'yyyy-MM-dd');
  const firstOfMonth = format(new Date(new Date().getFullYear(), new Date().getMonth(), 1), 'yyyy-MM-dd');

  // A month in the link wins over today's dates: somebody arriving from a link
  // about September wants September, not the current month with a stale title.
  const linkedMonth = searchParams.get('month');
  const monthIsValid = Boolean(linkedMonth && /^\d{4}-\d{2}$/.test(linkedMonth));
  const monthStart = monthIsValid ? `${linkedMonth}-01` : null;
  const monthEnd = monthIsValid
    ? (() => {
        const [y, m] = linkedMonth!.split('-').map(Number);
        return format(new Date(y, m, 0), 'yyyy-MM-dd');
      })()
    : null;

  const [fromDate, setFromDate] = useState(searchParams.get('from_date') ?? monthStart ?? firstOfMonth);
  const [toDate, setToDate] = useState(searchParams.get('to_date') ?? monthEnd ?? today);

  /** The last 18 months, for the month jump. */
  const monthOptions = useMemo(() => {
    const out: Array<{ value: string; label: string }> = [];
    const now = new Date();
    for (let i = 0; i < 18; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      out.push({
        value: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
        label: d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      });
    }
    return out;
  }, []);

  /** Shows a month in the dropdown only when the range IS exactly that month. */
  const monthValue = useMemo(() => {
    if (!/^\d{4}-\d{2}-01$/.test(fromDate)) return '';
    const ym = fromDate.slice(0, 7);
    const [y, m] = ym.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return toDate === `${ym}-${String(last).padStart(2, '0')}` ? ym : '';
  }, [fromDate, toDate]);
  const [employeeId, setEmployeeId] = useState('');
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState<'csv' | 'pdf' | 'excel' | null>(null);
  const [drillDown, setDrillDown] = useState<DrillDown | null>(null);
  const [reportView, setReportView] = useState<'summary' | 'daily'>('summary');
  // Whose day-by-day detail is open. This is what replaced the separate
  // Working Hours page: the same question, answered without a second screen
  // carrying its own employee picker and its own date range to keep in step.
  // Seventeen columns is not a report, it is a spreadsheet nobody reads. Seven
  // answer the question this view exists for; the rest are the working behind
  // them and are one click away in the person's own detail, in the exports, and
  // behind this toggle. Nothing is removed, only folded away by default.
  const [showAllColumns, setShowAllColumns] = useState(false);

  const [openLedger, setOpenLedger] = useState<{ id: number; name: string } | null>(() => {
    const e = Number(searchParams.get('employee'));
    // The name fills in from the table once it loads; the id is what matters.
    return Number.isInteger(e) && e > 0 ? { id: e, name: 'this employee' } : null;
  });

  // DAY BY DAY, per employee. The summary answers "how was the month"; this
  // answers "what happened on the 14th", which is the question asked when a
  // figure in the summary looks wrong.
  const { data: dailyData, isLoading: dailyLoading } = useQuery({
    queryKey: ['reports', 'daily', { fromDate, toDate, employeeId }],
    queryFn: async () => {
      const params = new URLSearchParams({ from_date: fromDate, to_date: toDate });
      if (employeeId) params.set('employee_id', employeeId);
      const res = await fetch(`/api/reports/daily?${params}`);
      return res.json() as Promise<ApiResponse<{ rows: DailyRow[]; truncated: boolean }>>;
    },
    enabled: reportView === 'daily',
  });
  const dailyRows = dailyData?.data?.rows ?? [];

  const { data: empData } = useQuery({
    queryKey: ['employees', 'all'],
    queryFn: async () => {
      const res = await fetch('/api/employees?limit=200');
      return res.json() as Promise<ApiResponse<{ employees: Employee[] }>>;
    },
  });
  const employees = empData?.data?.employees ?? [];

  const { data, isLoading } = useQuery({
    queryKey: ['reports', 'summary', { fromDate, toDate, employeeId, page }],
    queryFn: async () => {
      const params = new URLSearchParams({ from_date: fromDate, to_date: toDate, page: String(page), limit: '25' });
      if (employeeId) params.set('employee_id', employeeId);
      const res = await fetch(`/api/reports/summary?${params}`);
      return res.json() as Promise<ApiResponse<{
        summary: SummaryRow[];
        pagination: { total: number; totalPages: number };
        period: PeriodInfo;
        totals: PeriodTotals;
      }>>;
    },
    enabled: !!(fromDate && toDate),
  });

  const summary = data?.data?.summary ?? [];
  const pagination = data?.data?.pagination;
  const period = data?.data?.period;
  const totals = data?.data?.totals;

  // Which days sit behind an Absent / Leave count. Fetched only when the admin
  // clicks a number, from the existing attendance and leaves endpoints.
  const { data: drillData, isLoading: drillLoading } = useQuery({
    queryKey: ['report-drilldown', drillDown, fromDate, toDate],
    enabled: !!drillDown,
    queryFn: async () => {
      const d = drillDown!;
      const range = `from_date=${fromDate}&to_date=${toDate}&employee_id=${d.employeeId}`;

      if (d.kind === 'absent') {
        const res = await fetch(`/api/attendance?${range}&status=absent&limit=100`);
        const json = await res.json() as ApiResponse<{
          records: AttendanceRecord[];
          pagination: { total: number };
        }>;
        return {
          // The endpoint caps a page at 100; report the real total so a longer
          // range doesn't silently show a truncated list as if it were complete.
          total: Number(json.data?.pagination?.total ?? 0),
          rows: (json.data?.records ?? []).map(r => ({
            date: String(r.work_date).slice(0, 10),
            label: 'Absent',
            note: r.notes ?? null,
          })),
        };
      }

      // Leave is either an admin-granted leave_record, or an attendance row
      // flipped to 'leave' — the report counts both, so list both.
      const [leaveRes, attRes] = await Promise.all([
        fetch(`/api/leaves?${range}&limit=100`),
        fetch(`/api/attendance?${range}&status=leave&limit=100`),
      ]);
      const leaveJson = await leaveRes.json() as ApiResponse<{
        leaves: LeaveRow[];
        pagination: { total: number };
      }>;
      const attJson = await attRes.json() as ApiResponse<{
        records: AttendanceRecord[];
        pagination: { total: number };
      }>;

      const byDate = new Map<string, { date: string; label: string; note: string | null }>();
      for (const l of leaveJson.data?.leaves ?? []) {
        if (l.leave_type === 'holiday') continue; // a holiday is not personal leave
        const date = String(l.leave_date).slice(0, 10);
        byDate.set(date, { date, label: l.leave_type, note: l.notes ?? null });
      }
      for (const r of attJson.data?.records ?? []) {
        const date = String(r.work_date).slice(0, 10);
        if (!byDate.has(date)) byDate.set(date, { date, label: 'leave', note: r.notes ?? null });
      }
      const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
      // Both sources are capped at 100; the two can overlap on a date, so the
      // true total is unknowable without paging — flag truncation only when a
      // source actually hit its cap.
      const hitCap =
        (leaveJson.data?.leaves?.length ?? 0) >= 100 || (attJson.data?.records?.length ?? 0) >= 100;
      return { total: hitCap ? Number(leaveJson.data?.pagination?.total ?? 0) + Number(attJson.data?.pagination?.total ?? 0) : rows.length, rows };
    },
  });

  const drillRows = drillData?.rows ?? [];
  const drillCount = drillData?.total ?? null;

  // 'excel' hits a different route and file extension than its own name — the
  // day-wise CSV/PDF exports and this summary-shaped Excel export are
  // deliberately separate endpoints (see summary-xlsx/route.ts), so the path
  // can't be built by just reusing `type` the way csv/pdf do.
  async function downloadFile(type: 'csv' | 'pdf' | 'excel') {
    setExporting(type);
    try {
      const params = new URLSearchParams({ from_date: fromDate, to_date: toDate });
      if (employeeId) params.set('employee_id', employeeId);
      const path = type === 'excel' ? '/api/reports/summary-xlsx' : `/api/reports/${type}`;
      const ext = type === 'excel' ? 'xlsx' : type;
      const res = await fetch(`${path}?${params}`);
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `attendance_${fromDate}_to_${toDate}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setExporting(null);
    }
  }


  // The period applies to BOTH views and to every export, so it gets a row of
  // its own above them. Mixed in with the view tabs and the export buttons it
  // read as one more option among nine, which is how somebody ends up
  // exporting a different period from the one on screen.
  const dayCount = Math.max(
    0,
    Math.round((Date.parse(toDate) - Date.parse(fromDate)) / 86_400_000) + 1,
  );
  const periodLabel = fromDate && toDate
    ? `${format(new Date(fromDate), "d MMM yyyy")} – ${format(new Date(toDate), "d MMM yyyy")}`
    : "";

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Reports &amp; Hours</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          What everybody worked over a period, and what any one person worked day by day.
          Pick the period once below &mdash; it drives both views and every export.
        </p>
      </div>

      {/* 1. WHEN ------------------------------------------------------- */}
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400" htmlFor="month-jump">
              Pick a month
            </label>
            <select
              id="month-jump"
              value={monthValue}
              onChange={e => {
                const v = e.target.value;
                if (!v) return;
                const [y, m] = v.split("-").map(Number);
                const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
                setFromDate(`${v}-01`);
                setToDate(`${v}-${String(last).padStart(2, "0")}`);
                setPage(1);
              }}
              className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            >
              <option value="">Custom dates…</option>
              {monthOptions.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>

          <span className="pb-2.5 text-xs text-slate-400">or</span>

          <Input label="From" type="date" value={fromDate}
            onChange={e => { setFromDate(e.target.value); setPage(1); }} className="w-36" />
          <Input label="To" type="date" value={toDate}
            onChange={e => { setToDate(e.target.value); setPage(1); }} className="w-36" />

          {/* Says back what was chosen. The two controls above can disagree
              with what somebody thinks they picked; this cannot. */}
          <div className="ml-auto pb-1 text-right">
            <p className="text-sm font-medium text-slate-800 dark:text-slate-200">{periodLabel}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {dayCount} day{dayCount === 1 ? "" : "s"}
            </p>
          </div>
        </div>
      </Card>

      {/* 2. WHAT TO SHOW, and what to take away ------------------------ */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
          {([["summary", "Everyone"], ["daily", "Day by day"]] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => { setReportView(k); setOpenLedger(null); }}
              className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
                reportView === k
                  ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100"
                  : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* One control, not a search box AND a dropdown for the same job.
            Native selects already jump as you type. */}
        <select
          value={employeeId}
          onChange={e => { setEmployeeId(e.target.value); setPage(1); }}
          className="h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          aria-label="Limit to one person"
        >
          <option value="">Everyone</option>
          {employees.map(e => (
            <option key={e.id} value={e.id}>{e.name} ({e.emp_id})</option>
          ))}
        </select>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-slate-400">Download</span>
          {reportView === "summary" && (
            <Button variant="secondary" loading={exporting === "excel"}
              onClick={() => downloadFile("excel")}>Excel</Button>
          )}
          <Button variant="secondary" loading={exporting === "csv"}
            onClick={() => downloadFile("csv")}>CSV</Button>
          <Button variant="secondary" loading={exporting === "pdf"}
            onClick={() => downloadFile("pdf")}>PDF</Button>
        </div>
      </div>
      {/* One person, day by day — the whole of what the Working Hours page used
          to be, opened from the row rather than on a screen of its own. It
          inherits the period above, so there is no second date picker that can
          disagree with the table it was opened from. */}
      {openLedger && (
        <div className="space-y-4">
          {/* Reads as "you are here", not as a notification. The way back is a
              button on the left where a back control is looked for, not a link
              buried at the end of a sentence. */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => setOpenLedger(null)}
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              <span aria-hidden="true">&larr;</span> Everyone
            </button>
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold text-slate-900 dark:text-white">
                {openLedger.name}
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Day by day, {periodLabel}
              </p>
            </div>
          </div>
          <EmployeeLedger
            employeeId={openLedger.id}
            params={`from_date=${fromDate}&to_date=${toDate}`}
          />
        </div>
      )}
      {!openLedger && reportView === 'daily' && (
        dailyLoading ? (
          <div className="flex justify-center py-12"><Spinner /></div>
        ) : (
          <>
            {dailyData?.data?.truncated && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Too many rows to show at once — narrow the dates or pick one employee.
              </p>
            )}
            <Table
              columns={[
                {
                  key: 'employee_name',
                  header: 'Employee',
                  render: r => (
                    <div>
                      <p className="font-medium text-slate-800 dark:text-slate-200">{(r as DailyRow).employee_name}</p>
                      <p className="text-xs text-slate-400">{(r as DailyRow).emp_id}</p>
                    </div>
                  ),
                },
                { key: 'date', header: 'Date', render: r => formatDateOnly((r as DailyRow).date) },
                {
                  key: 'day',
                  header: 'Day',
                  render: r => <span className="text-slate-500 dark:text-slate-400">{(r as DailyRow).day}</span>,
                },
                {
                  key: 'check_in_utc',
                  header: 'Check-in',
                  render: r => <span className="tabular-nums">{toIST((r as DailyRow).check_in_utc)}</span>,
                },
                {
                  key: 'check_out_utc',
                  header: 'Check-out',
                  render: r => <span className="tabular-nums">{toIST((r as DailyRow).check_out_utc)}</span>,
                },
                {
                  key: 'break_minutes',
                  header: 'Break',
                  render: r => {
                    const m = (r as DailyRow).break_minutes;
                    return m ? <span className="tabular-nums">{minutesToHours(m)}</span>
                      : <span className="text-slate-400">—</span>;
                  },
                },
                {
                  key: 'worked_minutes',
                  header: 'Total Hours',
                  render: r => {
                    const m = (r as DailyRow).worked_minutes;
                    return m == null ? <span className="text-slate-400">—</span>
                      : <span className="tabular-nums font-medium">{minutesToHours(m)}</span>;
                  },
                },
                {
                  key: 'required_minutes',
                  header: 'Required',
                  render: r => {
                    const m = (r as DailyRow).required_minutes;
                    // null and 0 differ: null is "no shift rostered", 0 is
                    // "this day asked for nothing" — a week off, holiday or leave.
                    if (m == null) return <span className="text-slate-400" title="No shift rostered">—</span>;
                    if (m === 0) return <span className="text-slate-400">—</span>;
                    return <span className="tabular-nums text-slate-500 dark:text-slate-400">{minutesToHours(m)}</span>;
                  },
                },
                {
                  key: 'shortage_minutes',
                  header: 'Short',
                  render: r => {
                    const m = (r as DailyRow).shortage_minutes;
                    return m > 0
                      ? <span className="tabular-nums font-semibold text-amber-700 dark:text-amber-400">{minutesToHours(m)}</span>
                      : <span className="text-slate-400">—</span>;
                  },
                },
                {
                  key: 'late_minutes',
                  header: 'Late',
                  render: r => {
                    const m = (r as DailyRow).late_minutes;
                    // null and 0 differ: null is "no start time to be late
                    // against", 0 is "they made it".
                    if (m == null) return <span className="text-slate-400">—</span>;
                    if (m === 0) return <span className="text-slate-400">On time</span>;
                    return <span className="tabular-nums text-amber-600 dark:text-amber-400">{minutesToHours(m)}</span>;
                  },
                },
                {
                  key: 'overtime_minutes',
                  header: 'Overtime',
                  render: r => {
                    const m = (r as DailyRow).overtime_minutes;
                    return m > 0
                      ? <span className="tabular-nums text-blue-600 dark:text-blue-400">+{minutesToHours(m)}</span>
                      : <span className="text-slate-400">—</span>;
                  },
                },
                {
                  key: 'permission_minutes',
                  header: 'Permission',
                  render: r => {
                    const m = (r as DailyRow).permission_minutes;
                    return m > 0
                      ? <span className="tabular-nums text-blue-600 dark:text-blue-400">{minutesToHours(m)}</span>
                      : <span className="text-slate-400">—</span>;
                  },
                },
                {
                  key: 'leave_type',
                  header: 'Leave',
                  render: r => {
                    const t = (r as DailyRow).leave_type;
                    return t ? <Badge variant={t === 'holiday' ? 'neutral' : 'info'}>{t}</Badge>
                      : <span className="text-slate-400">—</span>;
                  },
                },
                {
                  key: 'day_status',
                  header: 'Status',
                  render: r => {
                    const st = (r as DailyRow).day_status;
                    if (st === 'weekly_off') return <Badge variant="neutral">weekly off</Badge>;
                    const tone = st === 'present' ? 'success'
                      : st === 'late' || st === 'early_departure' ? 'warning'
                        : st === 'absent' ? 'danger' : 'info';
                    return <Badge variant={tone}>{st.replace('_', ' ')}</Badge>;
                  },
                },
                {
                  key: 'work_update',
                  header: 'Work Update',
                  render: r => {
                    const t = (r as DailyRow).work_update;
                    // What they said they did that day. It existed only on the
                    // Overview, for today, and fell out of view once the day
                    // turned over.
                    if (!t) return <span className="text-slate-400">—</span>;
                    return (
                      <span
                        className="text-xs text-slate-700 dark:text-slate-300 block max-w-xs truncate"
                        title={t}
                      >
                        {t}
                      </span>
                    );
                  },
                },
              ]}
              data={dailyRows as object[]}
              emptyMessage="No days in the selected period."
            />
          </>
        )
      )}

      {!openLedger && reportView === 'summary' && (isLoading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : (
        <>
          {/* Period breakdown — calendar days split into weekly-offs, holidays
              and actual working days, then the hours those working days imply. */}
          <Card>
            <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-3">
              Period — {period?.from_date} to {period?.to_date}
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
              {([
                ['Calendar Days', period?.total_days ?? 0, 'Every date in the selected range'],
                ['Holidays', period?.festive_holidays ?? 0, 'Company-wide festive holidays'],
                ['Weekly Offs', period?.weekend_days ?? 0, 'Sundays — Saturday is a working day'],
                ['Working Days', period?.total_working_days ?? 0, 'Calendar days minus weekly offs and holidays'],
                ['Leave Days', period?.total_leave_days ?? 0, 'Personal leave taken by the employees shown'],
              ] as const).map(([label, value, hint]) => (
                <div key={label} title={hint} className="flex items-center justify-between sm:block">
                  <p className="text-sm text-slate-600 dark:text-slate-300">{label}</p>
                  <p className="text-xl font-semibold text-slate-900 dark:text-slate-100">{value}</p>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-5 pt-5 border-t border-slate-200 dark:border-slate-700">
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-300">Expected Hours</p>
                <p className="text-xl font-semibold text-slate-900 dark:text-slate-100">
                  {minutesToHours(totals?.expected_minutes ?? 0)}
                </p>
                <p className="text-xs text-slate-400 mt-0.5">
                  {period?.total_working_days ?? 0} working days × each employee&apos;s own shift
                </p>
              </div>
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-300">Employees</p>
                <p className="text-xl font-semibold text-slate-900 dark:text-slate-100">
                  {totals?.employees_with_shift ?? 0}
                  <span className="text-xs font-normal text-slate-400"> / {totals?.employees ?? 0} with a shift</span>
                </p>
                {(totals?.employees ?? 0) > (totals?.employees_with_shift ?? 0) && (
                  <p className="mt-0.5 text-xs text-amber-600 dark:text-amber-400">
                    {(totals?.employees ?? 0) - (totals?.employees_with_shift ?? 0)} without a shift — no expected hours
                  </p>
                )}
              </div>
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-300">Total Hours Worked</p>
                <p className="text-xl font-semibold text-slate-900 dark:text-slate-100">
                  {minutesToHours(totals?.minutes_worked ?? 0)}
                </p>
                <p className="text-xs text-slate-400 mt-0.5">Actually clocked</p>
              </div>
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-300">Total Credited</p>
                <p className="text-xl font-semibold text-slate-900 dark:text-slate-100">
                  {minutesToHours(totals?.minutes_credited ?? 0)}
                </p>
                <p className="text-xs text-slate-400 mt-0.5">
                  incl. {minutesToHours(totals?.permission_minutes ?? 0)} permission
                </p>
              </div>
            </div>
          </Card>

          {/* Collapsed by default. It explains the one genuinely confusable
              pair in this report — Absent is unexplained, Leave is approved —
              but held open it was six definitions standing between the reader
              and the data they came for. */}
          <Card>
            <details className="group">
              <summary className="cursor-pointer list-none text-xs font-semibold uppercase tracking-wide text-slate-500 marker:content-[''] hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">
                <span className="inline-block transition-transform group-open:rotate-90">&rsaquo;</span>
                {" "}What these columns mean
              </summary>
              <div className="mt-3">
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 text-sm">
              {([
                ['Present', 'Clocked in on a working day and the day was completed.'],
                ['Late', 'Clocked in after the shift start plus its grace period. Still a present day — it is counted separately, not on top.'],
                ['Absent', 'A working day with no clock-in and no approved leave. Marked automatically by the nightly job — an unexplained missing day.'],
                ['Leave', 'A working day the employee was formally excused from: casual, sick or earned leave granted by an admin. Company-wide holidays are not counted here.'],
                ['Permission', 'Approved short time off inside a working day (e.g. 10:00–12:00). Tops the day’s hours back up to the shift length; it never adds hours beyond it.'],
                ['Credited Hours', 'Hours actually clocked, plus approved permission, capped per day at the shift length.'],
              ] as const).map(([term, meaning]) => (
                <div key={term}>
                  <dt className="font-medium text-slate-800 dark:text-slate-200">{term}</dt>
                  <dd className="text-slate-500 dark:text-slate-400 mt-0.5">{meaning}</dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-4">
              In short: <span className="font-medium">Absent</span> is an unexplained missing day;
              {' '}<span className="font-medium">Leave</span> is an approved one. Working days exclude
              weekly offs and company holidays, so neither is counted against those.
            </p>
              </div>
            </details>
          </Card>

          <div className="flex flex-wrap items-center justify-between gap-2 px-1">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Click anyone&rsquo;s name to see their days, hours and any shortfall for this period.
            </p>
            {/* Sits beside the table it changes, so somebody hunting for a
                column they remember finds the way to it rather than
                concluding it was taken away. */}
            <button
              onClick={() => setShowAllColumns(v => !v)}
              className="text-xs font-medium text-blue-600 underline decoration-dotted underline-offset-2 hover:decoration-solid dark:text-blue-400"
            >
              {showAllColumns
                ? "Show fewer columns"
                : "Show all columns (calendar breakdown, permission, overtime, expected)"}
            </button>
          </div>
          <Table
            columns={([
              {
                key: 'name',
                header: 'Employee',
                render: r => {
                  const row = r as SummaryRow;
                  return (
                    <button
                      onClick={() => setOpenLedger({ id: row.id, name: row.name })}
                      className="text-left"
                      title="Show this person day by day"
                    >
                      <p className="font-medium text-slate-800 underline decoration-dotted underline-offset-2 hover:decoration-solid dark:text-slate-200">
                        {row.name}
                      </p>
                      <p className="text-xs text-slate-400">{row.emp_id}</p>
                    </button>
                  );
                },
              },
              {
                key: 'work_mode',
                header: 'Work Status',
                render: r => {
                  const off = (r as SummaryRow).work_mode === 'off_site';
                  return (
                    <Badge variant={off ? 'warning' : 'info'}>
                      {off ? 'Off-site' : 'On-site'}
                    </Badge>
                  );
                },
              },
              {
                key: 'daily_updates_count',
                header: 'Work Updates',
                render: r => {
                  const n = (r as SummaryRow).daily_updates_count ?? 0;
                  // Days they wrote something, not the text: one row covers a
                  // whole period, so there is no single update to show. The
                  // text itself is on the CSV, day by day.
                  if (!n) return <span className="text-slate-400">—</span>;
                  return (
                    <span className="tabular-nums text-slate-700 dark:text-slate-300">
                      {n} {n === 1 ? 'day' : 'days'}
                    </span>
                  );
                },
              },
              {
                key: 'calendar_days',
                header: 'Calendar Days',
                render: r => (
                  <span className="tabular-nums text-slate-500 dark:text-slate-400">
                    {(r as SummaryRow).calendar_days ?? '—'}
                  </span>
                ),
              },
              {
                key: 'working_days',
                header: 'Working Days',
                render: r => (
                  <span className="tabular-nums">{(r as SummaryRow).working_days ?? '—'}</span>
                ),
              },
              {
                key: 'weekly_off_days',
                header: 'Weekly Offs',
                render: r => (
                  <span className="tabular-nums text-slate-500 dark:text-slate-400">
                    {(r as SummaryRow).weekly_off_days ?? '—'}
                  </span>
                ),
              },
              {
                key: 'company_holidays',
                header: 'Holidays',
                render: r => (
                  <span className="tabular-nums text-slate-500 dark:text-slate-400">
                    {(r as SummaryRow).company_holidays ?? '—'}
                  </span>
                ),
              },
              {
                key: 'total_days_present',
                header: 'Present',
                // A bare "24" means nothing without the days that were asked
                // for. 24 of 25 is good; 24 of 31 is not, and the number on
                // its own cannot tell them apart.
                render: r => {
                  const row = r as SummaryRow;
                  const wd = row.working_days ?? 0;
                  const pct = wd > 0 ? Math.round((row.total_days_present / wd) * 100) : null;
                  return (
                    <div>
                      <span className="font-semibold tabular-nums text-green-600 dark:text-green-400">
                        {row.total_days_present}
                      </span>
                      {wd > 0 && (
                        <span className="text-xs tabular-nums text-slate-400"> of {wd}</span>
                      )}
                      {pct !== null && (
                        <p className="text-xs tabular-nums text-slate-400">{pct}%</p>
                      )}
                    </div>
                  );
                },
              },
              {
                key: 'total_days_late',
                header: 'Late',
                render: r => {
                  const row = r as SummaryRow;
                  const mins = row.late_minutes ?? 0;
                  return (
                    <div>
                      <span className="font-semibold text-amber-600 dark:text-amber-400 tabular-nums">
                        {row.total_days_late}
                        {row.total_days_present > 0 && (
                          <span className="text-xs font-normal text-slate-400">
                            {' '}of {row.total_days_present} attended
                          </span>
                        )}
                      </span>
                      {mins > 0 && (
                        <p className="text-xs text-slate-400 tabular-nums">
                          {Math.floor(mins / 60)}h {mins % 60}m late
                        </p>
                      )}
                    </div>
                  );
                },
              },
              {
                key: 'total_days_absent',
                header: 'Absent',
                render: r => {
                  const row = r as SummaryRow;
                  const n = Number(row.total_days_absent);
                  if (!n) return <span className="text-slate-400">0</span>;
                  return (
                    <button
                      onClick={() => setDrillDown({ employeeId: row.id, employeeName: row.name, kind: 'absent' })}
                      className="font-semibold text-red-600 underline decoration-dotted underline-offset-2 hover:decoration-solid dark:text-red-400"
                      title="Show which days"
                    >
                      {n}
                      {row.working_days ? (
                        <span className="text-xs font-normal text-slate-400"> of {row.working_days}</span>
                      ) : null}
                    </button>
                  );
                },
              },
              {
                key: 'total_minutes_worked',
                header: 'Worked Hours',
                render: r => minutesToHours((r as SummaryRow).total_minutes_worked),
              },
              {
                key: 'total_permission_minutes',
                header: 'Permission',
                render: r => {
                  const m = (r as SummaryRow).total_permission_minutes ?? 0;
                  return m ? minutesToHours(m) : '—';
                },
              },
              {
                key: 'total_minutes_credited',
                header: 'Credited Hours',
                render: r => {
                  const row = r as SummaryRow;
                  return <p>{minutesToHours(row.total_minutes_credited ?? row.total_minutes_worked)}</p>;
                },
              },
              {
                key: 'total_overtime_minutes',
                header: 'Overtime',
                render: r => {
                  // Its own column now. Credited hours stop at the rostered
                  // day, so overtime is precisely what that cap hides — as a
                  // footnote under Credited Hours it could not be scanned down
                  // the page.
                  const ot = (r as SummaryRow).total_overtime_minutes ?? 0;
                  if (ot <= 0) return <span className="text-slate-400">—</span>;
                  return (
                    <span className="font-semibold tabular-nums text-blue-600 dark:text-blue-400">
                      +{minutesToHours(ot)}
                    </span>
                  );
                },
              },
              {
                key: 'expected_minutes',
                header: 'Expected',
                render: r => {
                  const row = r as SummaryRow;
                  const expected = row.expected_minutes;
                  // No schedule = no shift length to measure against. Showing a
                  // number here would be a guess, so say so instead.
                  if (expected == null) {
                    return <span className="text-slate-400" title="No shift assigned">No shift</span>;
                  }
                  const credited = row.total_minutes_credited ?? row.total_minutes_worked;
                  const diff = credited - expected;
                  const perDay = row.required_minutes_per_day;
                  return (
                    <div>
                      <p className="text-slate-700 dark:text-slate-300">{minutesToHours(expected)}</p>
                      <p className={`text-xs ${diff < 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>
                        {diff < 0 ? '−' : '+'}{minutesToHours(Math.abs(diff))}
                      </p>
                      {/* A roster whose shifts work different weekdays has no
                          single per-day figure — the total is counted weekday by
                          weekday, so say that rather than leaving a blank. */}
                      {perDay != null ? (
                        <p className="text-xs text-slate-400">
                          {row.working_days} days × {minutesToHours(perDay)}
                          {(row.shift_count ?? 0) > 1 && ` (${row.shift_count} shifts)`}
                        </p>
                      ) : (
                        <p className="text-xs text-slate-400"
                           title={row.shift_names?.join(' + ') ?? undefined}>
                          {row.working_days} days · varies by day
                        </p>
                      )}
                      {row.overlapping_shifts && (
                        <p className="text-xs text-amber-600 dark:text-amber-400">
                          Shifts overlap: {row.overlapping_shifts.join(' + ')}
                        </p>
                      )}
                    </div>
                  );
                },
              },
              {
                key: 'avg_hours',
                header: 'Avg / Day',
                render: r => {
                  const row = r as SummaryRow;
                  if (row.days_with_hours === 0) return '—';
                  const total = row.total_minutes_credited ?? row.total_minutes_worked;
                  return minutesToHours(Math.round(total / row.days_with_hours));
                },
              },
              {
                key: 'attendance_percentage',
                header: 'Attendance %',
                render: r => {
                  const pct = (r as SummaryRow).attendance_percentage;
                  // Null means nothing was expected of them — no roster. "0%"
                  // there would read as an accusation rather than a fact.
                  if (pct == null) {
                    return <span className="text-slate-400 text-xs" title="No shift assigned">—</span>;
                  }
                  const tone = pct >= 90 ? 'text-green-600 dark:text-green-400'
                    : pct >= 75 ? 'text-amber-600 dark:text-amber-400'
                      : 'text-red-600 dark:text-red-400';
                  return <span className={`font-semibold tabular-nums ${tone}`}>{pct}%</span>;
                },
              },
            ] as Array<{ key: string; header: string; render: (r: unknown) => React.ReactNode }>).filter(c => showAllColumns || CORE_COLUMNS.has(c.key))}
            data={summary as object[]}
            emptyMessage="No data for the selected period."
          />

          {pagination && pagination.totalPages > 1 && (
            <Pagination page={page} totalPages={pagination.totalPages} onPageChange={setPage} />
          )}
        </>
      ))}

      {/* Which days sit behind an Absent / Leave count */}
      <Modal
        open={!!drillDown}
        onClose={() => setDrillDown(null)}
        title={drillDown?.kind === 'absent' ? 'Absent Days' : 'Leave Days'}
      >
        {drillDown && (
          <div className="space-y-4">
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500 dark:bg-slate-700/50 dark:text-slate-400">
              <span className="font-medium text-slate-700 dark:text-slate-300">{drillDown.employeeName}</span>
              {' — '}{fromDate} to {toDate}
            </div>

            {drillLoading ? (
              <div className="flex justify-center py-6"><Spinner /></div>
            ) : drillRows.length === 0 ? (
              <p className="text-sm italic text-slate-400">No days found for this period.</p>
            ) : drillCount !== null && drillRows.length < drillCount ? (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-400">
                Showing the first {drillRows.length} of {drillCount} days — narrow the date range to see the rest.
              </p>
            ) : null}

            {drillRows.length > 0 && (
              <ul className="divide-y divide-slate-100 dark:divide-slate-700/50">
                {drillRows.map(d => (
                  <li key={d.date} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-sm font-medium tabular-nums text-slate-800 dark:text-slate-200">
                        {formatDateOnly(d.date)}
                        <span className="ml-2 font-normal text-slate-400">{weekday(d.date)}</span>
                      </p>
                      {d.note && (
                        <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">{d.note}</p>
                      )}
                    </div>
                    <Badge variant={drillDown.kind === 'absent' ? 'danger' : 'info'}>{d.label}</Badge>
                  </li>
                ))}
              </ul>
            )}

            <p className="text-xs text-slate-500 dark:text-slate-400">
              {drillDown.kind === 'absent'
                ? 'Working days with no clock-in and no approved leave, marked automatically the following night.'
                : 'Days formally excused by an admin. Company-wide holidays are not counted as personal leave.'}
            </p>

            <div className="flex justify-end pt-1">
              <Button type="button" variant="secondary" onClick={() => setDrillDown(null)}>Close</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

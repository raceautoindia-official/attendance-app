'use client';

import { useState } from 'react';
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

export default function ReportsPage() {
  const today = format(new Date(), 'yyyy-MM-dd');
  const firstOfMonth = format(new Date(new Date().getFullYear(), new Date().getMonth(), 1), 'yyyy-MM-dd');

  const [fromDate, setFromDate] = useState(firstOfMonth);
  const [toDate, setToDate] = useState(today);
  const [employeeId, setEmployeeId] = useState('');
  const [empSearch, setEmpSearch] = useState('');
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState<'csv' | 'pdf' | null>(null);
  const [drillDown, setDrillDown] = useState<DrillDown | null>(null);

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

  async function downloadFile(type: 'csv' | 'pdf') {
    setExporting(type);
    try {
      const params = new URLSearchParams({ from_date: fromDate, to_date: toDate });
      if (employeeId) params.set('employee_id', employeeId);
      const res = await fetch(`/api/reports/${type}?${params}`);
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `attendance_${fromDate}_to_${toDate}.${type}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setExporting(null);
    }
  }

  const filteredEmployees = employees.filter(e =>
    e.name.toLowerCase().includes(empSearch.toLowerCase()) || e.emp_id.includes(empSearch),
  );

  return (
    <div className="space-y-4">
      {/* Filters */}
      <Card>
        <div className="flex flex-wrap gap-4 items-end">
          <Input label="From" type="date" value={fromDate} onChange={e => { setFromDate(e.target.value); setPage(1); }} className="w-36" />
          <Input label="To" type="date" value={toDate} onChange={e => { setToDate(e.target.value); setPage(1); }} className="w-36" />

          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Employee (optional)</label>
            <div className="flex gap-2">
              <Input
                placeholder="Search…"
                value={empSearch}
                onChange={e => setEmpSearch(e.target.value)}
                className="w-40"
              />
              <select
                value={employeeId}
                onChange={e => { setEmployeeId(e.target.value); setPage(1); }}
                className="rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-48"
              >
                <option value="">All employees</option>
                {filteredEmployees.map(e => (
                  <option key={e.id} value={e.id}>{e.name} ({e.emp_id})</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex gap-2 sm:ml-auto">
            <Button
              variant="secondary"
              loading={exporting === 'csv'}
              onClick={() => downloadFile('csv')}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export CSV
            </Button>
            <Button
              variant="secondary"
              loading={exporting === 'pdf'}
              onClick={() => downloadFile('pdf')}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
              Export PDF
            </Button>
          </div>
        </div>
      </Card>

      {/* Summary table */}
      {isLoading ? (
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

          {/* What the status columns below actually mean. */}
          <Card>
            <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-3">
              How to read this report
            </h3>
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
          </Card>
          <Table
            columns={[
              {
                key: 'name',
                header: 'Employee',
                render: r => (
                  <div>
                    <p className="font-medium text-slate-800 dark:text-slate-200">{(r as SummaryRow).name}</p>
                    <p className="text-xs text-slate-400">{(r as SummaryRow).emp_id}</p>
                  </div>
                ),
              },
              {
                key: 'total_days_present',
                header: 'Present',
                render: r => (
                  <span className="font-semibold text-green-600 dark:text-green-400">
                    {(r as SummaryRow).total_days_present}
                  </span>
                ),
              },
              {
                key: 'total_days_late',
                header: 'Late',
                render: r => (
                  <span className="font-semibold text-amber-600 dark:text-amber-400">
                    {(r as SummaryRow).total_days_late}
                  </span>
                ),
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
                    </button>
                  );
                },
              },
              {
                key: 'total_days_leave',
                header: 'Leave',
                render: r => {
                  const row = r as SummaryRow;
                  const n = Number(row.total_days_leave);
                  if (!n) return <span className="text-slate-400">0</span>;
                  return (
                    <button
                      onClick={() => setDrillDown({ employeeId: row.id, employeeName: row.name, kind: 'leave' })}
                      className="font-semibold text-blue-600 underline decoration-dotted underline-offset-2 hover:decoration-solid dark:text-blue-400"
                      title="Show which days"
                    >
                      {n}
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
                  const ot = row.total_overtime_minutes ?? 0;
                  return (
                    <div>
                      <p>{minutesToHours(row.total_minutes_credited ?? row.total_minutes_worked)}</p>
                      {/* Credited hours stop at the rostered day, so extra time
                          worked is invisible there — show it in its own right. */}
                      {ot > 0 && (
                        <p className="text-xs text-blue-600 dark:text-blue-400">
                          +{minutesToHours(ot)} extra
                        </p>
                      )}
                    </div>
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
            ]}
            data={summary as object[]}
            emptyMessage="No data for the selected period."
          />

          {pagination && pagination.totalPages > 1 && (
            <Pagination page={page} totalPages={pagination.totalPages} onPageChange={setPage} />
          )}
        </>
      )}

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

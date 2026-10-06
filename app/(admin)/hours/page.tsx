'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Input from '@/components/ui/Input';
import Spinner from '@/components/ui/Spinner';
import type { ApiResponse, Employee } from '@/lib/types';

// ---------------------------------------------------------------------------
// Working Hours — one employee, one month, in plain English.
//
// The brief was that the existing reports show detail but not meaning: a reader
// could see 205h and 225h on the same screen and still have to work out that
// somebody was 20 hours short, and could not see WHICH days caused it.
//
// So this page leads with a sentence, not a table. The tables are still here,
// underneath, because somebody will need to check the arithmetic — but the
// first thing on the screen answers the question in words.
//
// It reads /api/reports/hours-ledger, which is the same engine the aggregate
// Reports page uses for its expected-hours figure. Nothing here recomputes
// anything; a second implementation is how two screens start disagreeing.
// ---------------------------------------------------------------------------

/** Minutes → "8h 30m". Defined locally rather than imported from lib/attendance
 *  so no server-side env-dependent constant is dragged into the client bundle —
 *  the same reason the Reports page defines its own time formatter. */
function hm(minutes: number | null | undefined): string {
  if (minutes == null) return '—';
  const sign = minutes < 0 ? '-' : '';
  const v = Math.abs(Math.round(minutes));
  const h = Math.floor(v / 60);
  const m = v % 60;
  if (h === 0) return `${sign}${m}m`;
  if (m === 0) return `${sign}${h}h`;
  return `${sign}${h}h ${m}m`;
}

function toIST(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
  });
}

function dayNum(date: string): string {
  return date.slice(8, 10);
}

interface LedgerDay {
  date: string;
  weekday: string;
  kind: 'working' | 'week_off' | 'holiday' | 'leave' | 'future';
  kind_label: string | null;
  status: string | null;
  clock_in_utc: string | null;
  clock_out_utc: string | null;
  sessions: number;
  required_minutes: number | null;
  worked_minutes: number | null;
  break_minutes: number | null;
  permission_minutes: number;
  credited_minutes: number;
  shortage_minutes: number;
  overtime_minutes: number;
  late_minutes: number | null;
  open: boolean;
  notes: string | null;
}

interface Ledger {
  employee: { id: number; emp_id: string; name: string; department: string | null; role: string; is_active: boolean };
  period: { from_date: string; to_date: string; label: string };
  policy: {
    unpaid_break_minutes: number | null;
    gross_minutes_per_day: number | null;
    net_minutes_per_day: number | null;
    shift_names: string[];
    mixed: boolean;
  };
  standing: 'counted' | 'dormant' | 'excluded';
  standing_reason: string | null;
  totals: {
    calendar_days: number; working_days: number; scheduled_working_days: number;
    future_days: number; week_off_days: number;
    holiday_days: number; leave_days: number;
    days_present: number; days_late: number; days_absent: number;
    days_worked: number; days_short: number;
    required_minutes: number; scheduled_minutes: number; worked_minutes: number; break_minutes: number;
    permission_minutes: number; credited_minutes: number;
    shortage_minutes: number; overtime_minutes: number; net_minutes: number; late_minutes: number;
    avg_worked_minutes_per_day: number | null;
    shortest_day: { date: string; minutes: number } | null;
    longest_day: { date: string; minutes: number } | null;
    has_open_days: boolean;
  };
  standard: { stated_minutes: number; roster_minutes: number; difference_minutes: number };
  days: LedgerDay[];
  warnings: string[];
}

/** The last 18 months, newest first — enough history without an endless list. */
function recentMonths(count = 18): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const value = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    out.push({
      value,
      label: d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    });
  }
  return out;
}

const KIND_BADGE: Record<LedgerDay['kind'], { variant: 'success' | 'warning' | 'danger' | 'info' | 'neutral'; label: string }> = {
  working: { variant: 'info', label: 'Working day' },
  week_off: { variant: 'neutral', label: 'Week off' },
  holiday: { variant: 'success', label: 'Holiday' },
  leave: { variant: 'warning', label: 'Leave' },
  future: { variant: 'neutral', label: 'Not yet' },
};

export default function HoursPage() {
  const months = useMemo(() => recentMonths(), []);
  const [mode, setMode] = useState<'month' | 'range'>('month');
  const [month, setMonth] = useState(months[0].value);
  const [fromDate, setFromDate] = useState(`${months[0].value}-01`);
  const [toDate, setToDate] = useState(`${months[0].value}-28`);
  const [employeeId, setEmployeeId] = useState<number | null>(null);

  const { data: employees } = useQuery({
    queryKey: ['employees', 'for-hours'],
    queryFn: async () => {
      const res = await fetch('/api/employees?limit=200');
      const json: ApiResponse<{ employees: Employee[] }> = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Could not load employees');
      return json.data?.employees ?? [];
    },
  });

  const params = mode === 'month'
    ? `month=${month}`
    : `from_date=${fromDate}&to_date=${toDate}`;

  const { data: ledger, isLoading, error } = useQuery({
    queryKey: ['hours-ledger', employeeId, params],
    enabled: employeeId != null,
    queryFn: async () => {
      const res = await fetch(`/api/reports/hours-ledger?employee_id=${employeeId}&${params}`);
      const json: ApiResponse<Ledger> = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Could not load the ledger');
      return json.data!;
    },
  });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Working Hours</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          What one person was required to work, what they actually worked, and
          exactly where any gap came from.
        </p>
      </div>

      {/* Controls */}
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">Employee</span>
            <select
              value={employeeId ?? ''}
              onChange={e => setEmployeeId(e.target.value ? Number(e.target.value) : null)}
              className="h-10 min-w-56 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            >
              <option value="">Choose someone…</option>
              {(employees ?? []).map(e => (
                <option key={e.id} value={e.id}>
                  {e.name} ({e.emp_id}){e.is_active ? '' : ' — inactive'}
                </option>
              ))}
            </select>
          </label>

          {/* Month dropdown is the new default. The range inputs are kept —
              they were the existing way of doing this and still work. */}
          <div className="flex items-end gap-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">Period</span>
              <div className="flex rounded-lg border border-slate-300 p-0.5 dark:border-slate-600">
                {(['month', 'range'] as const).map(m => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={`rounded-md px-2.5 py-1.5 text-xs font-medium capitalize transition-colors ${
                      mode === m
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700'
                    }`}
                  >
                    {m === 'month' ? 'By month' : 'Custom range'}
                  </button>
                ))}
              </div>
            </label>

            {mode === 'month' ? (
              <select
                value={month}
                onChange={e => setMonth(e.target.value)}
                className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
              >
                {months.map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            ) : (
              <>
                <Input label="From" type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="w-36" />
                <Input label="To" type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="w-36" />
              </>
            )}
          </div>
        </div>
      </Card>

      {employeeId == null && (
        <Card>
          <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
            Choose an employee to see their hours.
          </p>
        </Card>
      )}

      {isLoading && (
        <Card><div className="flex justify-center py-10"><Spinner /></div></Card>
      )}

      {error && (
        <Card>
          <p className="py-6 text-center text-sm text-red-600 dark:text-red-400">
            {(error as Error).message}
          </p>
        </Card>
      )}

      {ledger && !isLoading && <Statement ledger={ledger} />}
    </div>
  );
}

function Statement({ ledger }: { ledger: Ledger }) {
  const t = ledger.totals;
  // Two different, both-legitimate figures. `net` compares the month's totals,
  // which is what "compare them against 225 hours" means. `dailyShort` adds up
  // only the days that fell short, giving no credit for long days elsewhere.
  // They disagree whenever someone both misses a day and works extra on others,
  // so the page shows both rather than silently picking one.
  const net = t.net_minutes;
  const monthShort = net < 0 ? -net : 0;
  const monthAhead = net > 0 ? net : 0;
  const dailyShort = t.shortage_minutes;

  // The headline, in words. This is the whole point of the page: a reader who
  // does not want to do arithmetic should be able to stop reading here.
  const verdict = ledger.standing === 'excluded'
    ? `${ledger.employee.name} is not held to rostered hours for ${ledger.period.label}.`
    : ledger.standing === 'dormant'
      ? `${ledger.employee.name} did not clock in at all during ${ledger.period.label}.`
      : monthShort > 0
        ? `${ledger.employee.name} worked ${hm(t.credited_minutes)} of the ${hm(t.required_minutes)} required in ${ledger.period.label} — ${hm(monthShort)} short for the month.`
        : `${ledger.employee.name} worked ${hm(t.credited_minutes)} against the ${hm(t.required_minutes)} required in ${ledger.period.label}${monthAhead > 0 ? ` — ${hm(monthAhead)} ahead` : ''}.`;

  const pct = t.required_minutes > 0
    ? Math.min(100, Math.round((t.credited_minutes / t.required_minutes) * 100))
    : 0;

  return (
    <div className="space-y-5">
      {/* Verdict */}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-lg font-semibold leading-snug text-slate-900 dark:text-white">{verdict}</p>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {ledger.employee.emp_id}
              {ledger.employee.department ? ` · ${ledger.employee.department}` : ''}
              {ledger.policy.shift_names.length ? ` · ${ledger.policy.shift_names.join(' + ')}` : ' · no shift rostered'}
            </p>
          </div>
          {ledger.standing === 'counted' && (
            <Badge variant={monthShort > 0 ? (monthShort > 240 ? 'danger' : 'warning') : 'success'}>
              {monthShort > 0 ? `${hm(monthShort)} short` : monthAhead > 0 ? `${hm(monthAhead)} ahead` : 'On target'}
            </Badge>
          )}
          {ledger.standing !== 'counted' && (
            <Badge variant="neutral">{ledger.standing === 'dormant' ? 'No activity' : 'Not counted'}</Badge>
          )}
        </div>

        {ledger.standing_reason && (
          <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {ledger.standing_reason}
          </p>
        )}

        {t.required_minutes > 0 && (
          <div className="mt-4">
            <div className="mb-1 flex justify-between text-xs text-slate-500 dark:text-slate-400">
              <span>{hm(t.credited_minutes)} credited</span>
              <span>{hm(t.required_minutes)} required</span>
            </div>
            <div className="h-3 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
              <div
                className={`h-full rounded-full transition-all ${
                  monthShort > 0 ? 'bg-gradient-to-r from-amber-400 to-amber-500' : 'bg-gradient-to-r from-emerald-400 to-emerald-500'
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="mt-1 text-right text-xs font-medium tabular-nums text-slate-500 dark:text-slate-400">{pct}%</p>
          </div>
        )}
      </Card>

      {/* Warnings — things the reader must know before trusting the figures. */}
      {ledger.warnings.length > 0 && (
        <Card>
          <ul className="space-y-1.5">
            {ledger.warnings.map((w, i) => (
              <li key={i} className="flex gap-2 text-xs text-amber-700 dark:text-amber-400">
                <span aria-hidden>⚠</span>
                <span>{w}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* The four numbers that matter */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Figure
          label={t.future_days > 0 ? 'Required so far' : 'Required'}
          value={hm(t.required_minutes)}
          note={t.future_days > 0
            ? `${t.working_days} of ${t.scheduled_working_days} working days · full period ${hm(t.scheduled_minutes)}`
            : `${t.working_days} working days`}
        />
        <Figure label="Worked" value={hm(t.worked_minutes)} note={`over ${t.days_worked} days`} />
        <Figure
          label={monthShort > 0 ? 'Short for the month' : 'Ahead for the month'}
          value={hm(monthShort > 0 ? monthShort : monthAhead)}
          note="month total vs requirement"
          tone={monthShort > 0 ? 'bad' : 'good'}
        />
        <Figure
          label="Average day"
          value={hm(t.avg_worked_minutes_per_day)}
          note={t.longest_day ? `longest ${hm(t.longest_day.minutes)}` : '—'}
        />
      </div>

      {/* Where the requirement came from, and why it is not 30 × 9h */}
      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800 dark:text-slate-100">
          How {ledger.period.label} was made up
        </h2>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-3 lg:grid-cols-5">
          <Line label="Days in period" value={String(t.calendar_days)} />
          <Line
            label={t.future_days > 0 ? 'Working days so far' : 'Working days'}
            value={t.future_days > 0 ? `${t.working_days} of ${t.scheduled_working_days}` : String(t.working_days)}
          />
          <Line label="Week offs" value={String(t.week_off_days)} />
          <Line label="Holidays" value={String(t.holiday_days)} />
          <Line label="Leave taken" value={String(t.leave_days)} />
          <Line label="Present" value={String(t.days_present)} />
          <Line label="Late" value={`${t.days_late} (${hm(t.late_minutes)})`} />
          <Line label="Absent" value={String(t.days_absent)} />
          <Line label="Permission credited" value={hm(t.permission_minutes)} />
          <Line label="Break time" value={hm(t.break_minutes)} />
          <Line label="Unworked on short days" value={hm(dailyShort)} />
          <Line label="Overtime on long days" value={hm(t.overtime_minutes)} />
        </div>

        <div className="mt-4 space-y-1.5 border-t border-slate-200 pt-3 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300">
          <p>
            <strong className="font-semibold">The requirement:</strong>{' '}
            {ledger.policy.mixed
              ? 'this employee holds shifts with different working days, so there is no single hours-per-day figure.'
              : ledger.policy.gross_minutes_per_day == null
                ? 'no shift is rostered, so nothing is required.'
                : ledger.policy.unpaid_break_minutes
                  ? `${hm(ledger.policy.gross_minutes_per_day)} on the clock less ${hm(ledger.policy.unpaid_break_minutes)} unpaid break = ${hm(ledger.policy.net_minutes_per_day)} per working day, × ${t.scheduled_working_days} working days in the period.`
                  : `${hm(ledger.policy.net_minutes_per_day)} per working day × ${t.scheduled_working_days} working days in the period. No unpaid break is deducted.`}
          </p>
          <p>
            <strong className="font-semibold">Against the company standard:</strong>{' '}
            the roster asks {hm(ledger.standard.roster_minutes)} this period; the stated
            monthly standard is {hm(ledger.standard.stated_minutes)}.{' '}
            {ledger.standard.difference_minutes === 0
              ? 'They agree.'
              : `That is ${hm(Math.abs(ledger.standard.difference_minutes))} ${ledger.standard.difference_minutes > 0 ? 'more' : 'less'}, because this period has ${t.working_days} working days after holidays.`}
          </p>
          {dailyShort > 0 && monthShort === 0 && (
            <p>
              <strong className="font-semibold">Why both figures are shown:</strong>{' '}
              the month total is met, but {hm(dailyShort)} went unworked on{' '}
              {t.days_short} day{t.days_short === 1 ? '' : 's'} that asked for
              hours, made up by {hm(t.overtime_minutes)} of overtime on other
              days. Whether extra hours on one day settle a missed day is a
              policy question, so neither figure is hidden.
            </p>
          )}
          <p className="text-slate-500 dark:text-slate-400">
            Week offs, holidays and approved leave require nothing, so they can
            never create a shortage. Approved permission is credited up to the
            day&apos;s requirement.
          </p>
        </div>
      </Card>

      {/* Day by day */}
      <Card padding={false}>
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Day by day</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t.days_short > 0
              ? `${t.days_short} day${t.days_short === 1 ? '' : 's'} short, highlighted below`
              : 'no day fell short'}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60">
              <tr className="text-left text-slate-600 dark:text-slate-300">
                <th className="px-3 py-2 font-semibold">Date</th>
                <th className="px-3 py-2 font-semibold">Type</th>
                <th className="px-3 py-2 font-semibold">In</th>
                <th className="px-3 py-2 font-semibold">Out</th>
                <th className="px-3 py-2 text-right font-semibold">Required</th>
                <th className="px-3 py-2 text-right font-semibold">Worked</th>
                <th className="px-3 py-2 text-right font-semibold">Short</th>
                <th className="px-3 py-2 text-right font-semibold">Late</th>
                <th className="px-3 py-2 font-semibold">Note</th>
              </tr>
            </thead>
            <tbody>
              {ledger.days.map(d => {
                const isShort = d.shortage_minutes > 0;
                return (
                  <tr
                    key={d.date}
                    className={`border-t border-slate-100 dark:border-slate-700/60 ${
                      isShort
                        ? 'bg-amber-50/70 dark:bg-amber-950/20'
                        : d.kind !== 'working'
                          ? 'bg-slate-50/50 dark:bg-slate-800/30'
                          : ''
                    }`}
                  >
                    <td className="whitespace-nowrap px-3 py-1.5">
                      <span className="font-medium tabular-nums text-slate-800 dark:text-slate-100">{dayNum(d.date)}</span>
                      <span className="ml-1.5 text-slate-400">{d.weekday}</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5">
                      <Badge variant={KIND_BADGE[d.kind].variant}>
                        {d.kind_label ?? KIND_BADGE[d.kind].label}
                      </Badge>
                      {d.open && <span className="ml-1 text-amber-600 dark:text-amber-400">open</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 tabular-nums text-slate-600 dark:text-slate-300">{toIST(d.clock_in_utc)}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 tabular-nums text-slate-600 dark:text-slate-300">
                      {toIST(d.clock_out_utc)}
                      {d.sessions > 1 && (
                        // "x3" means nothing on its own. The title spells it out in
                        // full, and the dotted underline plus help cursor are what
                        // tell a reader there is something to hover in the first
                        // place. A legend under the table repeats it, because hover
                        // does not exist on a touch screen.
                        <span
                          className="ml-1 cursor-help text-slate-400 underline decoration-dotted underline-offset-2"
                          title={
                            `Clocked in and out ${d.sessions} times on this day, rather than once — `
                            + `for example going out for lunch and coming back. `
                            + `"In" is the first clock-in of the day and "Out" is the final clock-out, `
                            + `so the hours worked are the sessions added together, not the gap between these two times.`
                            + (d.break_minutes
                              ? ` ${hm(d.break_minutes)} passed between sessions and is not counted as worked time.`
                              : '')
                          }
                        >
                          ×{d.sessions}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-500 dark:text-slate-400">
                      {d.required_minutes == null ? '—' : d.required_minutes === 0 ? '—' : hm(d.required_minutes)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right font-medium tabular-nums text-slate-800 dark:text-slate-100">
                      {d.worked_minutes == null ? '—' : hm(d.worked_minutes)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">
                      {isShort
                        ? <span className="font-semibold text-amber-700 dark:text-amber-400">{hm(d.shortage_minutes)}</span>
                        : d.overtime_minutes > 0
                          ? <span className="text-blue-600 dark:text-blue-400">+{hm(d.overtime_minutes)}</span>
                          : <span className="text-slate-300 dark:text-slate-600">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-500 dark:text-slate-400">
                      {d.late_minutes ? hm(d.late_minutes) : '—'}
                    </td>
                    <td className="max-w-48 truncate px-3 py-1.5 text-slate-500 dark:text-slate-400" title={d.notes ?? ''}>
                      {d.permission_minutes > 0 ? `permission ${hm(d.permission_minutes)}` : ''}
                      {d.notes ? (d.permission_minutes > 0 ? ' · ' : '') + d.notes : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Legend. Only shown when the marker actually appears, and it repeats
            what the tooltip says because a touch screen has no hover. */}
        {ledger.days.some(d => d.sessions > 1) && (
          <div className="border-t border-slate-200 px-4 py-2.5 dark:border-slate-700">
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              <span className="mr-1 text-slate-400 underline decoration-dotted underline-offset-2">×2</span>
              means the person clocked in and out more than once that day — for
              example going out for lunch and back. <strong>In</strong> is their first
              clock-in and <strong>Out</strong> is their final clock-out, so
              <strong>Worked</strong> is the sessions added together, not the gap
              between those two times. Time between sessions is not counted as worked.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}

function Figure({
  label, value, note, tone,
}: { label: string; value: string; note?: string; tone?: 'good' | 'bad' }) {
  return (
    <Card>
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
      <p className={`mt-1 text-xl font-bold tabular-nums ${
        tone === 'bad' ? 'text-amber-600 dark:text-amber-400'
          : tone === 'good' ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-slate-900 dark:text-white'
      }`}>
        {value}
      </p>
      {note && <p className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">{note}</p>}
    </Card>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 border-b border-dashed border-slate-200 pb-1 dark:border-slate-700">
      <span className="text-slate-500 dark:text-slate-400">{label}</span>
      <span className="font-medium tabular-nums text-slate-800 dark:text-slate-100">{value}</span>
    </div>
  );
}

'use client';

/**
 * components/hours/EmployeeLedger.tsx — one person's hours, day by day.
 *
 * Lifted verbatim out of the Working Hours page when that page and Reports
 * were merged. Taken as it stood rather than rewritten: a merge that retypes
 * working code is a merge that quietly drops behaviour nobody remembers
 * writing a test for.
 *
 * It owns its own fetch, so a caller supplies a person and a period and gets
 * the whole statement — the sentence, the figures, the day table and the
 * warnings. That is what lets the merged page open somebody's detail inline
 * instead of sending the reader to a second screen with its own date picker.
 *
 * Reads /api/reports/hours-ledger, the same engine the aggregate table uses.
 * Nothing here recomputes anything; a second implementation is how two views
 * of the same month start disagreeing.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Spinner from '@/components/ui/Spinner';
import Chart from '@/components/charts/Chart';
import type { ApiResponse } from '@/lib/types';
import type { ChartSpec } from '@/lib/charts/types';
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

type Closure = NonNullable<Ledger['closure']>;

interface Trend {
  current: { label: string; worked_minutes: number; net_minutes: number };
  previous: { label: string; worked_minutes: number; net_minutes: number } | null;
  delta: { worked_minutes: number; net_minutes: number; avg_worked_minutes_per_day: number | null } | null;
  peers: {
    scope: 'department' | 'company'; label: string; count: number;
    median_net_minutes: number; median_avg_minutes: number | null; rank: number;
  } | null;
  notes: string[];
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
    days_present: number; days_late: number; late_measured_days: number; days_absent: number;
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
  closure: {
    period_month: string;
    closed_through: string;
    is_closed: boolean;
    closed_by_name: string | null;
    closed_at: string;
    notes: string | null;
  } | null;
  days: LedgerDay[];
  warnings: string[];
}

/** The last 18 months, newest first — enough history without an endless list. */

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
    days_present: number; days_late: number; late_measured_days: number; days_absent: number;
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
  closure: {
    period_month: string;
    closed_through: string;
    is_closed: boolean;
    closed_by_name: string | null;
    closed_at: string;
    notes: string | null;
  } | null;
  days: LedgerDay[];
  warnings: string[];
}

/** The last 18 months, newest first — enough history without an endless list. */


/**
 * Fetch and render one employee's ledger for a period.
 *
 * `params` is the query string the hours-ledger endpoint expects — either
 * `month=YYYY-MM` or `from_date=…&to_date=…` — so the caller's own period
 * controls drive this without a second picker to keep in step.
 */
const KIND_BADGE: Record<LedgerDay['kind'], { variant: 'success' | 'warning' | 'danger' | 'info' | 'neutral'; label: string }> = {
  working: { variant: 'info', label: 'Working day' },
  week_off: { variant: 'neutral', label: 'Week off' },
  holiday: { variant: 'success', label: 'Holiday' },
  leave: { variant: 'warning', label: 'Leave' },
  future: { variant: 'neutral', label: 'Not yet' },
};

function TrendCard({
  employeeId, period,
}: {
  employeeId: number;
  period: { from_date: string; to_date: string };
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['hours-trend', employeeId, period.from_date, period.to_date],
    queryFn: async () => {
      const res = await fetch(
        `/api/reports/hours-trend?employee_id=${employeeId}`
        + `&from_date=${period.from_date}&to_date=${period.to_date}`,
      );
      const json: ApiResponse<Trend> = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Could not load the comparison');
      return json.data!;
    },
  });

  if (isLoading) {
    return (
      <Card>
        <p className="py-3 text-center text-xs text-slate-400">Working out the comparison…</p>
      </Card>
    );
  }
  if (!data) return null;

  const { previous, delta, peers, notes } = data;
  // Signed, and explicitly: "+2h" and "-2h" mean opposite things and a bare
  // number beside a word like "change" gets misread.
  const signed = (m: number) => `${m > 0 ? '+' : m < 0 ? '−' : ''}${hm(Math.abs(m))}`;

  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-slate-800 dark:text-slate-100">
        How this compares
      </h2>

      {previous && delta ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Line label={`Worked vs ${previous.label}`} value={signed(delta.worked_minutes)} />
          <Line
            label="Average day"
            value={delta.avg_worked_minutes_per_day == null
              ? '—'
              : signed(delta.avg_worked_minutes_per_day)}
          />
          <Line label={`${previous.label} total`} value={hm(previous.worked_minutes)} />
        </div>
      ) : (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          No previous period to compare with.
        </p>
      )}

      {peers && (
        <div className="mt-3 grid gap-3 border-t border-slate-200 pt-3 dark:border-slate-700 sm:grid-cols-3">
          <Line
            label={`Median across ${peers.label}`}
            value={peers.median_avg_minutes == null ? '—' : `${hm(peers.median_avg_minutes)}/day`}
          />
          <Line label="People compared" value={String(peers.count)} />
          <Line
            label="Rank by hours worked"
            value={peers.rank > 0 ? `${peers.rank} of ${peers.count}` : '—'}
          />
        </div>
      )}

      {notes.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-slate-200 pt-2 dark:border-slate-700">
          {notes.map((n, i) => (
            <li key={i} className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">{n}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function EmployeeLedger({
  employeeId,
  params,
}: {
  employeeId: number;
  params: string;
}) {
  const { data: ledger, isLoading, error } = useQuery({
    queryKey: ['hours-ledger', employeeId, params],
    queryFn: async () => {
      const res = await fetch(`/api/reports/hours-ledger?employee_id=${employeeId}&${params}`);
      const json: ApiResponse<Ledger> = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Could not load the ledger');
      return json.data!;
    },
  });

  if (isLoading) {
    return <Card><div className="flex justify-center py-10"><Spinner /></div></Card>;
  }
  if (error) {
    return (
      <Card>
        <p className="text-sm text-red-600 dark:text-red-400">{(error as Error).message}</p>
      </Card>
    );
  }
  if (!ledger) return null;

  return <Statement ledger={ledger} />;
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

  // Only days that asked for hours or had some worked: a column of zero for
  // every Sunday is noise, and the month's shape is the point.
  const chart: ChartSpec | null = useMemo(() => {
    const days = ledger.days.filter(
      d => (d.required_minutes ?? 0) > 0 || (d.worked_minutes ?? 0) > 0,
    );
    if (days.length < 2) return null;
    return {
      type: 'column',
      title: 'Hours worked against hours required',
      subtitle: `Each working day in ${ledger.period.label}`,
      unit: 'minutes',
      series: [
        { label: 'Worked', points: days.map(d => ({ label: d.date.slice(8), value: d.worked_minutes ?? 0 })) },
        { label: 'Required', points: days.map(d => ({ label: d.date.slice(8), value: d.required_minutes ?? 0 })) },
      ],
      note: 'Week offs, holidays and leave are left out — they require nothing.',
    };
  }, [ledger]);

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

        {/* Whether these figures are final. A reader deciding pay needs to know
            the difference between "reviewed and signed off" and "still moving". */}
        <div className="mt-3">
          {ledger.closure?.is_closed ? (
            <p className="flex flex-wrap items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
              <span aria-hidden>🔒</span>
              <strong className="font-semibold">Closed.</strong>
              These figures are final — signed off
              {ledger.closure.closed_by_name ? ` by ${ledger.closure.closed_by_name}` : ''} on{' '}
              {new Date(ledger.closure.closed_at).toLocaleDateString('en-IN', {
                day: 'numeric', month: 'short', year: 'numeric',
              })}
              . Attendance for this period cannot be edited unless the month is reopened.
              {ledger.closure.notes ? ` ${ledger.closure.notes}` : ''}
            </p>
          ) : (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              <strong className="font-semibold">Open.</strong>{' '}
              This period has not been closed, so the figures can still change —
              a correction or a late clock-out will move them. Close the month
              once it has been reviewed to make it final.
            </p>
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
          {/* 0 of 0 measured days is 'nobody checked', not 'nobody was late'.
              On a flexible shift lateness is never measured, so printing 0
              here reads as a clean record for the whole period. */}
          <Line
            label="Late"
            value={t.late_measured_days === 0
              ? 'not measured'
              : `${t.days_late} (${hm(t.late_minutes)})`}
          />
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

      <TrendCard employeeId={ledger.employee.id} period={ledger.period} />

      {/* Where the gap came from. A column per working day with what was asked
          beside what was done says in one glance what thirty table rows say
          slowly — and the days that caused the shortage are the short columns. */}
      {chart && (
        <Card>
          <Chart spec={chart} />
        </Card>
      )}

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


/**
 * Close or reopen a month.
 *
 * Warnings from the server are shown but do not block: the app does not know
 * the whole story — an open session may be a night shift mid-run, a zero-hour
 * employee may be a known leaver — so it reports what it noticed and leaves the
 * decision with the person signing the month off.
 */

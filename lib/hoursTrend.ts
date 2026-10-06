import { query } from '@/lib/db';
import { buildHoursLedger } from '@/lib/hoursLedger';

/**
 * lib/hoursTrend.ts — this period against the last one, and against everybody else.
 *
 * A single month's figure answers "how did they do". It does not answer "is
 * that normal for them" or "is that normal here", and those are usually the
 * questions somebody actually has. Twenty hours short is alarming on its own
 * and unremarkable if the whole site is twenty hours short because of a
 * shutdown week.
 *
 * It runs the full ledger for every peer rather than a faster aggregate.
 * lib/reportSummary.ts computes expected hours over the WHOLE period, which is
 * right for a finished month and overstates a month still running — it has no
 * notion of a day that has not happened yet. Comparing a part-month figure from
 * one engine against peers from another would produce a difference that is an
 * artefact of which code ran, and nobody would be able to tell. Slower and
 * consistent beats faster and subtly wrong.
 *
 * It lives behind its own endpoint for that reason: the statement renders
 * immediately, and this arrives when it arrives.
 */

export interface PeriodTotals {
  label: string;
  from_date: string;
  to_date: string;
  required_minutes: number;
  worked_minutes: number;
  credited_minutes: number;
  net_minutes: number;
  avg_worked_minutes_per_day: number | null;
  days_worked: number;
}

export interface TrendComparison {
  current: PeriodTotals;
  /** The equally-long period immediately before. Null when there is no data. */
  previous: PeriodTotals | null;
  delta: {
    worked_minutes: number;
    net_minutes: number;
    avg_worked_minutes_per_day: number | null;
  } | null;
  peers: {
    scope: 'department' | 'company';
    label: string;
    /** How many people the median is over, the subject included. */
    count: number;
    median_net_minutes: number;
    median_avg_minutes: number | null;
    /** 1 = the most hours worked of the group. */
    rank: number;
  } | null;
  notes: string[];
}

/** Middle value; the mean of the middle two when the count is even. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const dayCount = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/** True when the range is exactly one calendar month, first day to last. */
function isWholeMonth(from: string, to: string): boolean {
  if (from.slice(0, 7) !== to.slice(0, 7)) return false;
  if (!from.endsWith('-01')) return false;
  const [y, m] = from.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Number(to.slice(8)) === last;
}

export async function buildComparison(
  employeeId: number,
  fromDate: string,
  toDate: string,
): Promise<TrendComparison | null> {
  const current = await buildHoursLedger({ employeeId, fromDate, toDate });
  if (!current) return null;

  const notes: string[] = [];

  const asTotals = (l: NonNullable<Awaited<ReturnType<typeof buildHoursLedger>>>): PeriodTotals => ({
    label: l.period.label,
    from_date: l.period.from_date,
    to_date: l.period.to_date,
    required_minutes: l.totals.required_minutes,
    worked_minutes: l.totals.worked_minutes,
    credited_minutes: l.totals.credited_minutes,
    net_minutes: l.totals.net_minutes,
    avg_worked_minutes_per_day: l.totals.avg_worked_minutes_per_day,
    days_worked: l.totals.days_worked,
  });

  // A whole calendar month compares against the previous CALENDAR month, not
  // against the same number of days before it. Those are not the same thing and
  // the difference is silently wrong: November is 30 days, so counting back 30
  // from the 1st starts on 2 October and quietly drops a working day from the
  // comparison. For an arbitrary range, an equally-long window is the honest
  // choice, because there is no calendar unit to align to.
  const prevTo = addDays(fromDate, -1);
  const prevFrom = isWholeMonth(fromDate, toDate)
    ? `${prevTo.slice(0, 7)}-01`
    : addDays(prevTo, -(dayCount(fromDate, toDate) - 1));
  const previousLedger = await buildHoursLedger({ employeeId, fromDate: prevFrom, toDate: prevTo });
  const previous = previousLedger && previousLedger.totals.days_worked > 0
    ? asTotals(previousLedger)
    : null;

  if (!previous) {
    notes.push('There is nothing recorded in the period before this one, so there is no trend to show.');
  }

  // A month still running compared against a finished one is not a comparison,
  // so say so rather than quietly presenting a shortfall that is just time.
  if (current.totals.future_days > 0 && previous) {
    notes.push(
      `This period is only ${current.totals.working_days} of `
      + `${current.totals.scheduled_working_days} working days in, so the totals below are `
      + 'smaller than the previous period for that reason alone. The average per day is the '
      + 'figure to compare.',
    );
  }

  const delta = previous
    ? {
        worked_minutes: current.totals.worked_minutes - previous.worked_minutes,
        net_minutes: current.totals.net_minutes - previous.net_minutes,
        avg_worked_minutes_per_day:
          current.totals.avg_worked_minutes_per_day == null || previous.avg_worked_minutes_per_day == null
            ? null
            : current.totals.avg_worked_minutes_per_day - previous.avg_worked_minutes_per_day,
      }
    : null;

  // Peers: the same department when there is one, otherwise everybody counted.
  const department = current.employee.department;
  const peerRows = await query<{ id: number }>(
    department
      ? `SELECT id FROM employees WHERE is_active = TRUE AND role = 'employee' AND department = ?`
      : `SELECT id FROM employees WHERE is_active = TRUE AND role = 'employee'`,
    department ? [department] : [],
  );

  const peerTotals: Array<{ id: number; net: number; avg: number | null; worked: number }> = [];
  for (const p of peerRows) {
    const l = await buildHoursLedger({ employeeId: p.id, fromDate, toDate });
    // Only people actually held to hours: including the dormant would drag the
    // median down and make everybody else look good by comparison.
    if (!l || l.standing !== 'counted') continue;
    peerTotals.push({
      id: p.id,
      net: l.totals.net_minutes,
      avg: l.totals.avg_worked_minutes_per_day,
      worked: l.totals.worked_minutes,
    });
  }

  let peers: TrendComparison['peers'] = null;
  if (peerTotals.length >= 3) {
    const ranked = [...peerTotals].sort((a, b) => b.worked - a.worked);
    peers = {
      scope: department ? 'department' : 'company',
      label: department ?? 'everyone',
      count: peerTotals.length,
      median_net_minutes: median(peerTotals.map(p => p.net)),
      median_avg_minutes: peerTotals.some(p => p.avg != null)
        ? median(peerTotals.filter(p => p.avg != null).map(p => p.avg as number))
        : null,
      rank: ranked.findIndex(p => p.id === employeeId) + 1,
    };
    if (peers.rank === 0) {
      // The subject is not counted themselves — dormant, excluded, or no
      // roster. A rank among people they are not being compared with would be
      // a fiction.
      peers = { ...peers, rank: 0 };
      notes.push('This employee is not included in the comparison group, so they have no rank.');
    }
  } else {
    notes.push(
      `There are too few comparable people${department ? ` in ${department}` : ''} to publish a median.`,
    );
  }

  return { current: asTotals(current), previous, delta, peers, notes };
}

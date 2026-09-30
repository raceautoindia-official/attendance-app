/**
 * lib/chat/dates.ts — date-range resolution and IST formatting for the chat
 * data layer.
 *
 * WHY THIS EXISTS: the model must never do date arithmetic or timezone
 * conversion. It picks a preset (or supplies explicit YYYY-MM-DD bounds) and
 * this module resolves it deterministically against "today" in IST. The
 * resolved `label` is echoed in every answer so a wrong period is visible
 * rather than silent.
 */

import { TIMEZONE } from '@/lib/constants';
import type { DateRange } from './types';

export const DATE_PRESETS = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'last_7_days',
  'last_30_days',
  'this_year',
  'custom',
] as const;

export type DatePreset = (typeof DATE_PRESETS)[number];

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Today's calendar date in IST, as YYYY-MM-DD. */
export function istToday(): string {
  // en-CA renders as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * Parse YYYY-MM-DD into a UTC-midnight Date. Calendar arithmetic below happens
 * in UTC so it can never be shifted by the host machine's local timezone.
 */
function parseYmd(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toYmd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(ymd: string, days: number): string {
  const d = parseYmd(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return toYmd(d);
}

/** Monday of the week containing `ymd`. */
function startOfWeek(ymd: string): string {
  const d = parseYmd(ymd);
  // getUTCDay(): 0=Sun..6=Sat. Shift so Monday is the first day.
  const offset = (d.getUTCDay() + 6) % 7;
  return addDays(ymd, -offset);
}

function startOfMonth(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

/** "17 September 2026" */
function longDate(ymd: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(parseYmd(ymd));
}

/**
 * Build the human label: a single day, a span inside one month, or a full span.
 * Keeping this deterministic means the answer's stated period always matches
 * the rows that were actually queried.
 */
function rangeLabel(from: string, to: string): string {
  if (from === to) return longDate(from);
  if (from.slice(0, 7) === to.slice(0, 7)) {
    const day = (s: string) => String(Number(s.slice(8, 10)));
    const monthYear = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'UTC',
      month: 'long',
      year: 'numeric',
    }).format(parseYmd(from));
    return `${day(from)}-${day(to)} ${monthYear}`;
  }
  return `${longDate(from)} to ${longDate(to)}`;
}

export interface RangeInput {
  preset?: DatePreset;
  from_date?: string;
  to_date?: string;
}

/**
 * Resolve a preset or explicit bounds into an inclusive range.
 *
 * Defaults to `this_month` when nothing is supplied — an explicit, stated
 * default is safer than guessing at the model's intent, and the label makes it
 * visible in the answer.
 */
export function resolveRange(input: RangeInput = {}): DateRange {
  const today = istToday();
  const { preset, from_date, to_date } = input;

  // Explicit bounds win whenever both are supplied and well-formed.
  if (from_date && to_date) {
    if (!YMD.test(from_date) || !YMD.test(to_date)) {
      throw new Error('Dates must be in YYYY-MM-DD format.');
    }
    const [from, to] =
      from_date <= to_date ? [from_date, to_date] : [to_date, from_date];
    return { from, to, label: rangeLabel(from, to) };
  }

  let from: string;
  let to: string;

  switch (preset ?? 'this_month') {
    case 'today':
      from = to = today;
      break;
    case 'yesterday':
      from = to = addDays(today, -1);
      break;
    case 'this_week':
      from = startOfWeek(today);
      to = today;
      break;
    case 'last_week': {
      const thisMonday = startOfWeek(today);
      from = addDays(thisMonday, -7);
      to = addDays(thisMonday, -1);
      break;
    }
    case 'this_month':
      from = startOfMonth(today);
      to = today;
      break;
    case 'last_month': {
      const firstOfThis = startOfMonth(today);
      to = addDays(firstOfThis, -1);
      from = startOfMonth(to);
      break;
    }
    case 'last_7_days':
      from = addDays(today, -6);
      to = today;
      break;
    case 'last_30_days':
      from = addDays(today, -29);
      to = today;
      break;
    case 'this_year':
      from = `${today.slice(0, 4)}-01-01`;
      to = today;
      break;
    case 'custom':
      throw new Error(
        'preset "custom" requires both from_date and to_date (YYYY-MM-DD).',
      );
    default:
      from = startOfMonth(today);
      to = today;
  }

  return { from, to, label: rangeLabel(from, to) };
}

/** A stored UTC DATETIME rendered as IST clock time, e.g. "09:14 am". */
export function toIstTime(value: Date | string | null): string {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-IN', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

/** A stored UTC DATETIME rendered as IST date + time. */
export function toIstDateTime(value: Date | string | null): string {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return `${new Intl.DateTimeFormat('en-IN', {
    timeZone: TIMEZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(d)} ${toIstTime(d)}`;
}

/** A DATE column value rendered as YYYY-MM-DD without timezone drift. */
export function toYmdString(value: Date | string | null): string {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

/** 512 -> "8h 32m". Formatted here so the model never does the division. */
export function minutesToHours(minutes: number | null | undefined): string {
  if (minutes == null) return '—';
  const m = Math.max(0, Math.round(minutes));
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

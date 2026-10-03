import { formatInTimeZone } from 'date-fns-tz';

export function formatDateOnly(value: string | Date | null | undefined): string {
  if (!value) return '-';

  if (typeof value === 'string') {
    const ymd = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (ymd) return `${ymd[3]}-${ymd[2]}-${ymd[1]}`;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';

  return `${String(date.getUTCDate()).padStart(2, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${date.getUTCFullYear()}`;
}

/**
 * A DATE column rendered as YYYY-MM-DD.
 *
 * `lib/db.ts` sets `dateStrings: false`, so mysql2 returns a DATE column as a JS
 * Date at midnight UTC — not a string. `String(value).slice(0, 10)` therefore
 * yields "Sat May 23": no year, no month number, unsortable and ambiguous across
 * years. Both report exports did exactly that, which made the Date column of
 * every CSV and PDF unusable for payroll.
 *
 * Formatted in UTC because a DATE has no time or zone of its own; shifting it to
 * IST would be a second bug waiting to happen.
 */
export function toYmd(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return formatInTimeZone(value, 'UTC', 'yyyy-MM-dd');
  }
  return String(value).slice(0, 10);
}

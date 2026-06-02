import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { TIMEZONE } from './constants';

/**
 * Returns today's calendar date in the app timezone (IST by default) as a
 * YYYY-MM-DD string. Used as the `work_date` value for attendance records.
 */
export function getWorkDateIST(): string {
  return formatInTimeZone(new Date(), TIMEZONE, 'yyyy-MM-dd');
}

/**
 * Convert a duration in minutes to a human-readable string.
 * Examples:  90 → "1h 30m"  |  60 → "1h"  |  45 → "45m"
 */
export function minutesToHoursDisplay(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * Returns true when `clockInUtc` falls after the shift start time
 * (expressed in the app timezone) plus the grace period.
 *
 * @param clockInUtc   - The UTC clock-in timestamp
 * @param shiftStart   - Shift start time as "HH:MM" or "HH:MM:SS"
 * @param graceMinutes - Grace period in minutes (from the shifts table)
 */
export function isLate(
  clockInUtc: Date,
  shiftStart: string,
  graceMinutes: number,
): boolean {
  // Determine the IST calendar date on which the employee clocked in
  const workDate = formatInTimeZone(clockInUtc, TIMEZONE, 'yyyy-MM-dd');

  // Build the shift-start instant in IST ("2024-01-15T09:00:00")
  const [h, m] = shiftStart.split(':').map(Number);
  const hPadded = String(h).padStart(2, '0');
  const mPadded = String(m).padStart(2, '0');
  const shiftStartLocal = `${workDate}T${hPadded}:${mPadded}:00`;

  // Convert the IST local string to a UTC Date for arithmetic
  const shiftStartUtc = fromZonedTime(shiftStartLocal, TIMEZONE);

  // Deadline = shift start + grace period
  const deadline = new Date(shiftStartUtc.getTime() + graceMinutes * 60_000);

  return clockInUtc > deadline;
}

/**
 * Returns true when `clockOutUtc` is before the shift end time in IST,
 * indicating the employee left early.
 *
 * @param clockOutUtc - The UTC clock-out timestamp
 * @param shiftEnd    - Shift end time as "HH:MM" or "HH:MM:SS"
 * @param workDate    - The IST calendar date "YYYY-MM-DD" (avoids re-computing)
 */
export function isEarlyDeparture(
  clockOutUtc: Date,
  shiftEnd: string,
  workDate: string,
): boolean {
  const [h, m] = shiftEnd.split(':').map(Number);
  const hPadded = String(h).padStart(2, '0');
  const mPadded = String(m).padStart(2, '0');
  const shiftEndLocal = `${workDate}T${hPadded}:${mPadded}:00`;
  const shiftEndUtc = fromZonedTime(shiftEndLocal, TIMEZONE);
  return clockOutUtc < shiftEndUtc;
}

/** Extract the client IP from incoming request headers. */
export function getClientIp(req: Request): string {
  const fwd = (req.headers as Headers).get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return (req.headers as Headers).get('x-real-ip') ?? '127.0.0.1';
}

/** Format a UTC Date as a MySQL DATETIME string "YYYY-MM-DD HH:MM:SS". */
export function toMySQLDatetime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

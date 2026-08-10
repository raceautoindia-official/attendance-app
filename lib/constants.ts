export const TIMEZONE = process.env.APP_TIMEZONE ?? 'Asia/Kolkata';

export const LOGIN_MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS) || 5;

export const LOGIN_LOCKOUT_MINUTES =
  Number(process.env.LOGIN_LOCKOUT_MINUTES) || 15;

/**
 * The hour (IST) at which one work day ends and the next begins.
 *
 * Not midnight: a shift that runs through the night would otherwise be split
 * across two dates, and someone who clocked in at 22:00 would have their hours
 * cut in half at 00:00. With a 07:00 boundary the whole night belongs to the
 * day it started on, and the day is settled each morning at the hours actually
 * worked — so overtime shows up as more hours, not as a second day.
 */
export const WORK_DAY_START_HOUR =
  Number(process.env.WORK_DAY_START_HOUR) >= 0 && Number(process.env.WORK_DAY_START_HOUR) <= 23
    ? Number(process.env.WORK_DAY_START_HOUR)
    : 7;

/**
 * Optional ceiling on what an AUTO-closed session may be credited, in hours.
 *
 * A day is settled at the hours actually worked, which is right for someone who
 * genuinely stayed late — but an employee who simply forgets to clock out is
 * credited everything up to the 07:00 boundary, which can be twenty hours or
 * more. That is time elapsed, not time worked.
 *
 * Unset (the default) means no ceiling: the figure is always the real elapsed
 * time, and an over-long day is left visible for an admin to correct. Set
 * AUTO_CLOSE_MAX_HOURS (e.g. 14) to have the system cap it instead; the cap is
 * recorded on the audit entry either way. It never affects a real clock-out.
 */
export const AUTO_CLOSE_MAX_MINUTES: number | null =
  Number(process.env.AUTO_CLOSE_MAX_HOURS) > 0
    ? Math.round(Number(process.env.AUTO_CLOSE_MAX_HOURS) * 60)
    : null;

export const ACCESS_TOKEN_EXPIRY =
  (process.env.JWT_ACCESS_EXPIRY as string) || '15m';

export const REFRESH_TOKEN_EXPIRY =
  (process.env.JWT_REFRESH_EXPIRY as string) || '7d';

export const BCRYPT_ROUNDS = 12;

export const MAX_DEVICES_PER_EMPLOYEE = 3;

// Cookie names
export const ACCESS_TOKEN_COOKIE = 'access_token';
export const REFRESH_TOKEN_COOKIE = 'refresh_token';

// ---------------------------------------------------------------------------
// Weekly off days. Saturday is a WORKING day here — only Sunday is off, which
// matches the shipped shifts (Mon–Sat) and the Sunday-holiday job. Reports and
// the absent job both read this, so they can never disagree about a day.
// Override with WEEKLY_OFF_DAYS="Sat,Sun" for a five-day week.
// ---------------------------------------------------------------------------
const WEEKDAY_NUMBERS: Record<string, number> = {
  Sun: 1, Mon: 2, Tue: 3, Wed: 4, Thu: 5, Fri: 6, Sat: 7,
};

export const WEEKLY_OFF_DAYS: string[] = (process.env.WEEKLY_OFF_DAYS ?? 'Sun')
  .split(',')
  .map(d => d.trim())
  .filter(d => d in WEEKDAY_NUMBERS);

/** MySQL DAYOFWEEK() numbers for the weekly off days (Sun=1 … Sat=7). */
export const WEEKLY_OFF_DAYOFWEEK: number[] = WEEKLY_OFF_DAYS.map(d => WEEKDAY_NUMBERS[d]);

// Attendance helpers
export const MINUTES_IN_DAY = 1440;
export const LATE_THRESHOLD_MINUTES = 10; // matches default grace_minutes

// Standard required working hours per shift. Used as the credited duration
// when a session is auto-closed because the employee forgot to clock out.
export const REQUIRED_SHIFT_HOURS = 9;
export const REQUIRED_SHIFT_MINUTES = REQUIRED_SHIFT_HOURS * 60;

// ---------------------------------------------------------------------------
// Permission hours — a short paid absence inside a working day (e.g. 10:00 to
// 12:00) that the employee applies for and an admin approves. Approved minutes
// top the day's worked hours back up to the required shift length; they never
// push a day above what the shift requires.
// ---------------------------------------------------------------------------

/** Shortest slice an employee may request. */
export const PERMISSION_MIN_MINUTES =
  Number(process.env.PERMISSION_MIN_MINUTES) || 15;

/** Longest single permission. */
export const PERMISSION_MAX_MINUTES_PER_REQUEST =
  Number(process.env.PERMISSION_MAX_MINUTES_PER_REQUEST) || 120;

/** Monthly entitlement. Pending + approved requests both consume it. */
export const PERMISSION_MAX_MINUTES_PER_MONTH =
  Number(process.env.PERMISSION_MAX_MINUTES_PER_MONTH) || 120;

/** How far back / forward a permission may be dated. */
/**
 * How far back a permission may be dated.
 *
 * Kept short on purpose. Genuine corrections are filed within a day or two;
 * a month-long window let a short day be papered over well after the fact,
 * which is only as strong as the approver's memory of that date. Raise
 * PERMISSION_MAX_PAST_DAYS if the business needs a longer window — anything
 * backdated is flagged to the approver either way.
 */
export const PERMISSION_MAX_PAST_DAYS =
  Number(process.env.PERMISSION_MAX_PAST_DAYS) || 3;
export const PERMISSION_MAX_FUTURE_DAYS =
  Number(process.env.PERMISSION_MAX_FUTURE_DAYS) || 90;

// Pagination
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

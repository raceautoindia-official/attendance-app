export const TIMEZONE = process.env.APP_TIMEZONE ?? 'Asia/Kolkata';

export const LOGIN_MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS) || 5;

export const LOGIN_LOCKOUT_MINUTES =
  Number(process.env.LOGIN_LOCKOUT_MINUTES) || 15;

export const ACCESS_TOKEN_EXPIRY =
  (process.env.JWT_ACCESS_EXPIRY as string) || '15m';

export const REFRESH_TOKEN_EXPIRY =
  (process.env.JWT_REFRESH_EXPIRY as string) || '7d';

export const BCRYPT_ROUNDS = 12;

export const MAX_DEVICES_PER_EMPLOYEE = 3;

// Cookie names
export const ACCESS_TOKEN_COOKIE = 'access_token';
export const REFRESH_TOKEN_COOKIE = 'refresh_token';

// Attendance helpers
export const MINUTES_IN_DAY = 1440;
export const LATE_THRESHOLD_MINUTES = 10; // matches default grace_minutes

// Pagination
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

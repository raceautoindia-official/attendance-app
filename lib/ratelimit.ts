/**
 * lib/ratelimit.ts — In-memory rate limiter for login attempts
 *
 * Keyed by emp_id. Tracks attempt count and first-attempt timestamp.
 * Auto-resets after LOGIN_LOCKOUT_MINUTES.
 *
 * ⚠️  PRODUCTION NOTE: This implementation uses a Node.js Map which is
 * per-process. In a multi-instance deployment (PM2 cluster mode, multiple
 * servers) each process has its own counter and rate limiting is NOT
 * coordinated across instances.
 *
 * Replace with Redis for production multi-instance deployments:
 *   - Use ioredis with a sliding-window counter
 *   - Key: `ratelimit:login:<emp_id>`
 *   - INCR + EXPIRE or ZADD + ZREMRANGEBYSCORE pattern
 *   - This gives you atomic, cluster-safe counting
 *
 * Example Redis sliding-window pseudo-code:
 *   const count = await redis.incr(`ratelimit:login:${empId}`);
 *   if (count === 1) await redis.expire(`ratelimit:login:${empId}`, LOCKOUT_SECONDS);
 *   if (count > MAX_ATTEMPTS) return { allowed: false, ... };
 */

import { LOGIN_MAX_ATTEMPTS, LOGIN_LOCKOUT_MINUTES } from './constants';

interface Entry {
  count: number;
  firstAttemptAt: number; // Unix ms
}

// Module-level store — survives across requests within a single process
const store = new Map<string, Entry>();

export interface RateLimitResult {
  /** Whether the request should be allowed through */
  allowed: boolean;
  /** How many more attempts remain before lockout */
  remainingAttempts: number;
  /** When the lockout expires (only present when locked out) */
  lockedUntil?: Date;
}

const LOCKOUT_MS = LOGIN_LOCKOUT_MINUTES * 60 * 1000;

/**
 * Check whether `empId` is allowed to attempt a login.
 * Call this BEFORE verifying credentials. If allowed, call `recordAttempt`
 * after a failed attempt. Call `resetAttempts` on success.
 */
export function checkRateLimit(empId: string): RateLimitResult {
  const now = Date.now();
  const entry = store.get(empId);

  if (!entry) {
    return { allowed: true, remainingAttempts: LOGIN_MAX_ATTEMPTS };
  }

  const elapsed = now - entry.firstAttemptAt;

  // Lockout window expired — clean up and allow
  if (elapsed >= LOCKOUT_MS) {
    store.delete(empId);
    return { allowed: true, remainingAttempts: LOGIN_MAX_ATTEMPTS };
  }

  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    const lockedUntil = new Date(entry.firstAttemptAt + LOCKOUT_MS);
    return { allowed: false, remainingAttempts: 0, lockedUntil };
  }

  return {
    allowed: true,
    remainingAttempts: LOGIN_MAX_ATTEMPTS - entry.count,
  };
}

/**
 * Record a failed login attempt for `empId`.
 * Returns the updated rate-limit state.
 */
export function recordFailedAttempt(empId: string): RateLimitResult {
  const now = Date.now();
  const entry = store.get(empId);

  if (!entry || now - entry.firstAttemptAt >= LOCKOUT_MS) {
    store.set(empId, { count: 1, firstAttemptAt: now });
    return { allowed: true, remainingAttempts: LOGIN_MAX_ATTEMPTS - 1 };
  }

  entry.count += 1;

  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    const lockedUntil = new Date(entry.firstAttemptAt + LOCKOUT_MS);
    return { allowed: false, remainingAttempts: 0, lockedUntil };
  }

  return {
    allowed: true,
    remainingAttempts: LOGIN_MAX_ATTEMPTS - entry.count,
  };
}

/**
 * Clear the failed-attempt counter for `empId` after a successful login.
 */
export function resetAttempts(empId: string): void {
  store.delete(empId);
}

// Periodically sweep expired entries to prevent unbounded memory growth.
// Runs every 15 minutes; clears entries whose lockout window has passed.
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store.entries()) {
      if (now - entry.firstAttemptAt >= LOCKOUT_MS) {
        store.delete(key);
      }
    }
  }, 15 * 60 * 1000).unref?.();
}

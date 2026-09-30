/**
 * lib/chat/ratelimit.ts — rate limiting for the chat endpoint.
 *
 * WHY NOT lib/ratelimit.ts: that module is login-specific (keyed by emp_id,
 * with lockout semantics) and is an in-process Map, so under PM2 cluster mode
 * each worker keeps its own counter. Since every chat request is already written
 * to `audit_log` for provenance, we count those rows instead — which is
 * coordinated across all workers for free, needs no new table and no Redis.
 *
 * The window comparison uses NOW() rather than UTC_TIMESTAMP() deliberately:
 * `audit_log.created_at` is written by `DEFAULT CURRENT_TIMESTAMP`, so
 * comparing against NOW() keeps both sides on the same server clock whatever
 * the server's time_zone is set to.
 *
 * Fails OPEN: if the count query errors, the request is allowed. For an
 * internal super-admin-only tool, a rate limiter that blocks work when the DB
 * hiccups is worse than one that occasionally lets a burst through.
 */

import { queryOne } from '@/lib/db';

/** audit_log.action for a chat question. Also the rate-limit counter key. */
export const CHAT_AUDIT_ACTION = 'chat_query';
/** audit_log.entity for chat rows. */
export const CHAT_AUDIT_ENTITY = 'chat';

export const CHAT_WINDOW_MINUTES = Number(process.env.CHAT_RATE_WINDOW_MINUTES) || 10;
export const CHAT_MAX_PER_WINDOW = Number(process.env.CHAT_RATE_MAX) || 30;

export interface ChatRateLimitResult {
  allowed: boolean;
  used: number;
  limit: number;
  windowMinutes: number;
}

/**
 * How many questions this user has asked in the current window, and whether
 * they may ask another.
 */
export async function checkChatRateLimit(
  employeeId: number,
): Promise<ChatRateLimitResult> {
  try {
    const row = await queryOne<{ used: number }>(
      `SELECT COUNT(*) AS used
         FROM audit_log
        WHERE performed_by = ?
          AND action = ?
          AND created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
      [employeeId, CHAT_AUDIT_ACTION, CHAT_WINDOW_MINUTES],
    );

    const used = Number(row?.used ?? 0);
    return {
      allowed: used < CHAT_MAX_PER_WINDOW,
      used,
      limit: CHAT_MAX_PER_WINDOW,
      windowMinutes: CHAT_WINDOW_MINUTES,
    };
  } catch (err) {
    console.error('[chat] rate limit check failed, allowing request:', err);
    return {
      allowed: true,
      used: 0,
      limit: CHAT_MAX_PER_WINDOW,
      windowMinutes: CHAT_WINDOW_MINUTES,
    };
  }
}

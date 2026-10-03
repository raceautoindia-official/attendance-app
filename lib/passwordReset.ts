import crypto from 'crypto';
import { query, queryOne } from '@/lib/db';
import { usingSesApi } from '@/lib/mailer';

// ---------------------------------------------------------------------------
// Emailed PIN resets.
//
// The rules this file exists to hold in one place:
//
//   • the raw token lives only in the email — the database keeps its SHA-256,
//     so a dump cannot be replayed into working reset links;
//   • a link is single-use and short-lived;
//   • requesting a reset never reveals whether an account exists (the caller
//     answers identically either way), so this is not an employee-ID oracle;
//   • a successful reset revokes every existing session, because "I forgot my
//     PIN" and "someone else knows my PIN" look identical from here.
// ---------------------------------------------------------------------------

/** How long a link works. Long enough to walk to a computer, short enough that
 *  a forwarded email is not a standing key. */
export const RESET_TTL_MINUTES = Number(process.env.PASSWORD_RESET_TTL_MIN) || 30;

/** Requests allowed per employee per hour — stops a mailbox being flooded by
 *  someone else typing a colleague's employee ID repeatedly. */
export const RESET_MAX_PER_HOUR = 5;

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** True once the 2026-08-12 password-reset migration has run. */
export async function hasPasswordResetTable(): Promise<boolean> {
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'password_resets'`,
  );
  return Number(row?.n ?? 0) > 0;
}

/**
 * Is outgoing email actually configured?
 *
 * This deployment shipped with SMTP_HOST left at the placeholder for weeks, and
 * every alert silently vanished. A password reset that silently vanishes is
 * worse than a button that is honest about being unavailable: the employee
 * waits for mail that will never arrive, and nobody learns why. So the reset
 * endpoint refuses up front — a fact about the SERVER, which leaks nothing
 * about any account.
 */
export function mailIsConfigured(): boolean {
  // The SES API path needs no SMTP host at all — region plus IAM keys is the
  // whole configuration, and it is the preferred route because it speaks
  // HTTPS rather than a mail port a host may block.
  if (usingSesApi()) return true;
  const host = process.env.SMTP_HOST?.trim();
  if (!host) return false;
  return !/yourprovider|example\.|changeme/i.test(host);
}

/** Create a reset token for an employee. Returns the RAW token (email it). */
export async function createResetToken(
  employeeId: number,
  ip: string | null,
): Promise<string> {
  const raw = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO password_resets (employee_id, token_hash, expires_at, requested_ip)
     VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), ?)`,
    [employeeId, hashToken(raw), RESET_TTL_MINUTES, ip],
  );
  return raw;
}

/** Too many requests for this employee in the last hour? */
export async function resetRateExceeded(employeeId: number): Promise<boolean> {
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM password_resets
     WHERE employee_id = ? AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR)`,
    [employeeId],
  );
  return Number(row?.n ?? 0) >= RESET_MAX_PER_HOUR;
}

export interface ValidReset {
  id: number;
  employee_id: number;
  name: string;
  emp_id: string;
}

/** The employee this token belongs to, or null when it is unknown, expired,
 *  already used, or the account is no longer active. */
export async function resolveResetToken(raw: string): Promise<ValidReset | null> {
  if (!raw) return null;
  return queryOne<ValidReset>(
    `SELECT pr.id, pr.employee_id, e.name, e.emp_id
     FROM password_resets pr
     JOIN employees e ON e.id = pr.employee_id AND e.is_active = TRUE
     WHERE pr.token_hash = ?
       AND pr.used_at IS NULL
       AND pr.expires_at > UTC_TIMESTAMP()
     LIMIT 1`,
    [hashToken(raw)],
  );
}

/**
 * Burn a token. Guarded on used_at so two simultaneous submissions cannot both
 * succeed — the loser is told the link is spent, which is true by then.
 */
export async function consumeResetToken(id: number): Promise<boolean> {
  const res = await query(
    'UPDATE password_resets SET used_at = UTC_TIMESTAMP() WHERE id = ? AND used_at IS NULL',
    [id],
  );
  return (res as unknown as { affectedRows: number }).affectedRows > 0;
}

/** Any other outstanding links for this employee die with the used one —
 *  otherwise an older email in the inbox stays a working key. */
export async function invalidateOtherResets(employeeId: number, keepId: number): Promise<void> {
  await query(
    `UPDATE password_resets SET used_at = UTC_TIMESTAMP()
     WHERE employee_id = ? AND id <> ? AND used_at IS NULL`,
    [employeeId, keepId],
  );
}

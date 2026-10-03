import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from './db';
import type { ApiResponse, JWTPayload, Role } from './types';
import {
  ACCESS_TOKEN_COOKIE,
  ACCESS_TOKEN_EXPIRY,
  BCRYPT_ROUNDS,
  REFRESH_TOKEN_COOKIE,
  REFRESH_TOKEN_EXPIRY,
} from './constants';

// ---------------------------------------------------------------------------
// Secrets — must be present in production
// ---------------------------------------------------------------------------

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

const accessSecret = () => requireEnv('JWT_ACCESS_SECRET');
const refreshSecret = () => requireEnv('JWT_REFRESH_SECRET');

// ---------------------------------------------------------------------------
// Token signing
// ---------------------------------------------------------------------------

export function signAccessToken(payload: JWTPayload & { tv?: number }): string {
  const claims: Pick<JWTPayload, 'id' | 'emp_id' | 'role'> & { tv: number } = {
    id: payload.id,
    emp_id: payload.emp_id,
    role: payload.role,
    // Token version — see requireAuth(). Lets logout revoke tokens that would
    // otherwise stay valid until they expired.
    tv: payload.tv ?? 0,
  };
  return jwt.sign(claims, accessSecret(), {
    expiresIn: ACCESS_TOKEN_EXPIRY as jwt.SignOptions['expiresIn'],
  });
}

export function signRefreshToken(payload: Pick<JWTPayload, 'id'>): string {
  return jwt.sign(
    {
      id: payload.id,
      // A random id per token. Without it the payload is just {id, iat, exp},
      // so two sign-ins in the same SECOND produce byte-identical tokens — and
      // therefore identical stored hashes. A token revoked by signing out would
      // then be indistinguishable from the fresh one issued moments later, and
      // rotation could hand back the value it was supposed to replace.
      jti: crypto.randomBytes(16).toString('hex'),
    },
    refreshSecret(),
    { expiresIn: REFRESH_TOKEN_EXPIRY as jwt.SignOptions['expiresIn'] },
  );
}

// ---------------------------------------------------------------------------
// Token verification
// ---------------------------------------------------------------------------

export function verifyAccessToken(token: string): JWTPayload | null {
  try {
    return jwt.verify(token, accessSecret()) as JWTPayload;
  } catch {
    return null;
  }
}

export function verifyRefreshToken(token: string): { id: number } | null {
  try {
    return jwt.verify(token, refreshSecret()) as { id: number };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// PIN hashing
// ---------------------------------------------------------------------------

export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, BCRYPT_ROUNDS);
}

export async function comparePin(
  pin: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(pin, hash);
}

// ---------------------------------------------------------------------------
// Refresh-token storage hash
// We never store the raw refresh token — only its SHA-256 digest.
// ---------------------------------------------------------------------------

export function generateRefreshTokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/** Cookie lifetimes driven by env vars — same source of truth as the JWT expiry. */
const ACCESS_MAX_AGE = parseExpiryToSeconds(process.env.JWT_ACCESS_EXPIRY ?? '8h');
const REFRESH_MAX_AGE = parseExpiryToSeconds(process.env.JWT_REFRESH_EXPIRY ?? '7d');

function parseExpiryToSeconds(expiry: string): number {
  const match = expiry.match(/^(\d+)([smhd])$/);
  if (!match) return 15 * 60;
  const n = parseInt(match[1], 10);
  switch (match[2]) {
    case 's': return n;
    case 'm': return n * 60;
    case 'h': return n * 60 * 60;
    case 'd': return n * 24 * 60 * 60;
    default:  return 15 * 60;
  }
}

export function getExpirySecondsFromEnv(expiry: string, fallbackSeconds = 15 * 60): number {
  const match = expiry.match(/^(\d+)([smhd])$/);
  if (!match) return fallbackSeconds;
  const n = parseInt(match[1], 10);
  switch (match[2]) {
    case 's': return n;
    case 'm': return n * 60;
    case 'h': return n * 60 * 60;
    case 'd': return n * 24 * 60 * 60;
    default:  return fallbackSeconds;
  }
}

export function setAuthCookies(
  response: NextResponse,
  accessToken: string,
  refreshToken: string,
): void {
  response.cookies.set(ACCESS_TOKEN_COOKIE, accessToken, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    path: '/',
    maxAge: ACCESS_MAX_AGE,
  });

  response.cookies.set(REFRESH_TOKEN_COOKIE, refreshToken, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    path: '/',
    maxAge: REFRESH_MAX_AGE,
  });
}

export function clearAuthCookies(response: NextResponse): void {
  response.cookies.set(ACCESS_TOKEN_COOKIE, '', {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });

  response.cookies.set(REFRESH_TOKEN_COOKIE, '', {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

/**
 * Read the access token from the request.
 * Checks the cookie first, then falls back to the Authorization header so
 * that the API remains usable by non-browser clients.
 */
export function getTokenFromRequest(request: NextRequest): string | null {
  const cookie = request.cookies.get(ACCESS_TOKEN_COOKIE)?.value;
  if (cookie) return cookie;

  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  return null;
}

// ---------------------------------------------------------------------------
// requireAuth — use at the top of every protected route handler
// ---------------------------------------------------------------------------

/**
 * Verify the access token on an incoming request.
 *
 * Returns the decoded `JWTPayload` on success, or a ready-to-return
 * `NextResponse` (401 / 403) on failure so callers can do:
 *
 *   const auth = await requireAuth(request, ['manager', 'super_admin']);
 *   if (auth instanceof NextResponse) return auth;
 *   // auth is JWTPayload here
 */
export async function requireAuth(
  request: NextRequest,
  allowedRoles?: Role[],
): Promise<JWTPayload | NextResponse> {
  const token = getTokenFromRequest(request);
  if (!token) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Authentication required' },
      { status: 401 },
    );
  }

  const payload = verifyAccessToken(token);
  if (!payload) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Invalid or expired token' },
      { status: 401 },
    );
  }

  if (allowedRoles && !allowedRoles.includes(payload.role)) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Insufficient permissions' },
      { status: 403 },
    );
  }

  // A token issued before the employee's last logout (or deactivation) is dead,
  // even though its signature and expiry still check out. Without this, logging
  // out only removed the refresh token and the access token kept working.
  if (!(await tokenVersionCurrent(payload))) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Session ended — please sign in again' },
      { status: 401 },
    );
  }

  return payload;
}

/**
 * Whether the token's version still matches the employee's — and whether they
 * are still active at all.
 *
 * Read from the database on every request, deliberately. An in-process cache
 * was tried and is wrong here: route handlers do not reliably share module
 * state, so a copy of the cache in one route kept honouring a token that
 * logout had already revoked through another. A revocation that takes effect
 * "in a few seconds, usually" is not a revocation. This is one lookup on a
 * primary key, alongside the queries the routes make anyway.
 */
async function tokenVersionCurrent(payload: JWTPayload & { tv?: number }): Promise<boolean> {
  if (!(await hasTokenVersionColumn())) return true;   // migration not applied yet

  const row = await queryOne<{ token_version: number; is_active: number }>(
    'SELECT token_version, is_active FROM employees WHERE id = ?',
    [payload.id],
  );
  if (!row || !row.is_active) return false;
  return Number(payload.tv ?? 0) === Number(row.token_version ?? 0);
}

/**
 * The column arrives with a migration, so tolerate its absence.
 *
 * Only a POSITIVE result is memoised. Caching "missing" for the life of the
 * process would mean applying the migration quietly did nothing until someone
 * restarted the server — and the thing it silently disables is token
 * revocation. A miss is re-checked, at most once every RECHECK_MS.
 */
const SCHEMA_RECHECK_MS = 30_000;
let tokenVersionColumn = false;
let tokenVersionCheckedAt = 0;
async function hasTokenVersionColumn(): Promise<boolean> {
  if (tokenVersionColumn) return true;
  if (Date.now() - tokenVersionCheckedAt < SCHEMA_RECHECK_MS) return false;
  tokenVersionCheckedAt = Date.now();
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees'
       AND COLUMN_NAME = 'token_version'`,
  );
  tokenVersionColumn = Number(row?.n ?? 0) > 0;
  return tokenVersionColumn;
}

/** Current token version for an employee, for signing a fresh token. */
export async function currentTokenVersion(employeeId: number): Promise<number> {
  if (!(await hasTokenVersionColumn())) return 0;
  const row = await queryOne<{ token_version: number }>(
    'SELECT token_version FROM employees WHERE id = ?',
    [employeeId],
  );
  return Number(row?.token_version ?? 0);
}

/**
 * Authorise a passkey ENROLMENT request.
 *
 * Normally this needs a full access token, like everything else. It ALSO
 * accepts the pending-auth cookie — proof that the PIN was verified moments
 * ago — but only for an employee who has no passkey yet.
 *
 * Without that exception the first passkey can never be obtained: enrolling
 * requires a token, and getting a token requires either a passkey or an
 * exemption. An account with neither is simply bricked, and if it is the only
 * administrator nobody can grant the exemption either.
 *
 * The "no passkey yet" restriction is what keeps this safe. Once an employee
 * HAS a passkey it is a genuine second factor, and somebody holding only the
 * PIN must not be able to add another one alongside it.
 */
export async function requireEnrolmentAuth(
  request: NextRequest,
): Promise<{ id: number; emp_id: string; role: Role } | NextResponse> {
  const full = await requireAuth(request);
  if (!(full instanceof NextResponse)) return full;

  const pendingEmpId = getPendingAuthFromRequest(request);
  if (pendingEmpId) {
    const row = await queryOne<{ id: number; emp_id: string; role: Role; passkeys: number }>(
      `SELECT e.id, e.emp_id, e.role,
              (SELECT COUNT(*) FROM passkeys p WHERE p.employee_id = e.id) AS passkeys
       FROM employees e
       WHERE e.emp_id = ? AND e.is_active = TRUE`,
      [pendingEmpId],
    );
    if (row && Number(row.passkeys) === 0) {
      return { id: row.id, emp_id: row.emp_id, role: row.role };
    }
  }

  return full;   // the 401/403 requireAuth already built
}

/** Invalidate every access token already issued to this employee. */
export async function revokeTokens(employeeId: number): Promise<void> {
  if (!(await hasTokenVersionColumn())) return;
  await queryOne('UPDATE employees SET token_version = token_version + 1 WHERE id = ?', [employeeId]);
}

// ---------------------------------------------------------------------------
// Pending-auth cookie
// Issued after PIN verification when the employee has passkeys; consumed by
// the WebAuthn authenticate-verify route to confirm PIN was checked first.
// ---------------------------------------------------------------------------

const PENDING_AUTH_COOKIE = 'pending_auth';
const PENDING_AUTH_PURPOSE = 'webauthn_pending';
const PENDING_AUTH_MAX_AGE = 5 * 60; // 5 minutes

function signPendingAuthToken(emp_id: string): string {
  // No JWT `exp` on purpose — lifetime is bounded by the cookie's maxAge
  // (browser clock). A server-clock-based exp breaks the login ceremony when
  // the server time is skewed. The signature still prevents tampering.
  return jwt.sign(
    { emp_id, purpose: PENDING_AUTH_PURPOSE },
    accessSecret(),
  );
}

function verifyPendingAuthToken(token: string): string | null {
  try {
    const payload = jwt.verify(token, accessSecret()) as {
      emp_id: string;
      purpose: string;
    };
    if (payload.purpose !== PENDING_AUTH_PURPOSE) return null;
    return payload.emp_id;
  } catch {
    return null;
  }
}

/** Set a short-lived HttpOnly cookie that encodes the PIN-verified emp_id. */
export function setPendingAuthCookie(
  response: NextResponse,
  emp_id: string,
): void {
  response.cookies.set(PENDING_AUTH_COOKIE, signPendingAuthToken(emp_id), {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    path: '/',
    maxAge: PENDING_AUTH_MAX_AGE,
  });
}

/** Clear the pending-auth cookie (call after successful WebAuthn verification). */
export function clearPendingAuthCookie(response: NextResponse): void {
  response.cookies.set(PENDING_AUTH_COOKIE, '', {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

/**
 * Extract and verify the pending-auth cookie from an incoming request.
 * Returns the emp_id if the cookie is present and valid, otherwise null.
 */
export function getPendingAuthFromRequest(request: NextRequest): string | null {
  const cookie = request.cookies.get(PENDING_AUTH_COOKIE)?.value;
  if (!cookie) return null;
  return verifyPendingAuthToken(cookie);
}

// ---------------------------------------------------------------------------
// WebAuthn challenge cookie (stateless — cluster-safe)
//
// The WebAuthn challenge is generated in the "get options" request and verified
// in a later "verify" request. Storing it server-side (in memory or even DB)
// is fragile under PM2 cluster mode where the two requests can hit different
// processes. Instead we round-trip it through a short-lived signed HttpOnly
// cookie, exactly like the pending-auth cookie above.
// ---------------------------------------------------------------------------

const WEBAUTHN_CHALLENGE_COOKIE = 'webauthn_challenge';
const WEBAUTHN_CHALLENGE_MAX_AGE = 5 * 60; // 5 minutes

type WebAuthnChallengePurpose = 'register' | 'authenticate';

/** Persist a WebAuthn challenge in a signed, short-lived HttpOnly cookie. */
export function setWebAuthnChallengeCookie(
  response: NextResponse,
  challenge: string,
  purpose: WebAuthnChallengePurpose,
): void {
  // No JWT `exp`: validity is bounded by the cookie's maxAge below, which uses
  // the browser's clock. Tying it to the server clock (via expiresIn) makes the
  // ceremony fail whenever the server time is skewed. The challenge is random,
  // single-use and cleared after verify, so a signature (integrity) is enough.
  const token = jwt.sign(
    { challenge, purpose, kind: 'webauthn_challenge' },
    accessSecret(),
  );
  response.cookies.set(WEBAUTHN_CHALLENGE_COOKIE, token, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    path: '/',
    maxAge: WEBAUTHN_CHALLENGE_MAX_AGE,
  });
}

/**
 * Read and verify the WebAuthn challenge cookie. Returns the challenge string
 * if present, unexpired, and matching the expected purpose; otherwise null.
 */
export function getWebAuthnChallengeFromRequest(
  request: NextRequest,
  purpose: WebAuthnChallengePurpose,
): string | null {
  const cookie = request.cookies.get(WEBAUTHN_CHALLENGE_COOKIE)?.value;
  if (!cookie) return null;
  try {
    const payload = jwt.verify(cookie, accessSecret()) as {
      challenge: string;
      purpose: string;
      kind: string;
    };
    if (payload.kind !== 'webauthn_challenge' || payload.purpose !== purpose) {
      return null;
    }
    return payload.challenge;
  } catch {
    return null;
  }
}

/** Clear the WebAuthn challenge cookie (call after a verify attempt). */
export function clearWebAuthnChallengeCookie(response: NextResponse): void {
  response.cookies.set(WEBAUTHN_CHALLENGE_COOKIE, '', {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { NextRequest, NextResponse } from 'next/server';
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

export function signAccessToken(payload: JWTPayload): string {
  const { iat: _iat, exp: _exp, ...claims } = payload;
  return jwt.sign(claims, accessSecret(), {
    expiresIn: ACCESS_TOKEN_EXPIRY as jwt.SignOptions['expiresIn'],
  });
}

export function signRefreshToken(payload: Pick<JWTPayload, 'id'>): string {
  return jwt.sign({ id: payload.id }, refreshSecret(), {
    expiresIn: REFRESH_TOKEN_EXPIRY as jwt.SignOptions['expiresIn'],
  });
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

  return payload;
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
  return jwt.sign(
    { emp_id, purpose: PENDING_AUTH_PURPOSE },
    accessSecret(),
    { expiresIn: '5m' },
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

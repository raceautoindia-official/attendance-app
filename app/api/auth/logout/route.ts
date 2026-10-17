import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { deviceIdFrom } from '@/lib/deviceBinding';
import { forgetPushTokens } from '@/lib/push';
import {
  getTokenFromRequest,
  verifyAccessToken,
  generateRefreshTokenHash,
  clearAuthCookies,
  expireAccessTokens,
} from '@/lib/auth';
import { REFRESH_TOKEN_COOKIE } from '@/lib/constants';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// POST /api/auth/logout — ends THIS session.
//
// It used to end every session the employee had. Signing out of the web portal
// therefore signed their phone out too, mid-shift: its next location upload
// was refused, its refresh token had been deleted, and tracking uploaded
// nothing until they noticed and signed in again. "Sign out everywhere" is
// what a PIN reset does (revokeTokens); signing out of one browser or one
// phone is about that one.
//
// The session is named by its refresh token: the web sends it as a cookie, the
// phone in the body (it has no cookies). Every access token is still expired
// on the spot, so the signed-out one dies immediately; other devices simply
// renew with their own refresh token on their next request.
//
// A client that names no session — an older phone build sends only its access
// token — still gets the old behaviour, all sessions ended, because there is
// no way to tell which one is its own.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const res = NextResponse.json<ApiResponse>(
    { success: true, message: 'Logged out' },
  );

  const body = await request.json().catch(() => null) as { refreshToken?: unknown } | null;
  const presented = typeof body?.refreshToken === 'string' && body.refreshToken
    ? body.refreshToken
    : request.cookies.get(REFRESH_TOKEN_COOKIE)?.value ?? null;

  let sessionOwner: number | null = null;
  if (presented) {
    const hash = generateRefreshTokenHash(presented);
    const row = await queryOne<{ employee_id: number }>(
      'SELECT employee_id FROM refresh_tokens WHERE token_hash = ?', [hash]);
    sessionOwner = row?.employee_id ?? null;
    await query('DELETE FROM refresh_tokens WHERE token_hash = ?', [hash]);
  }

  const accessToken = getTokenFromRequest(request);
  const payload = accessToken ? verifyAccessToken(accessToken) : null;
  if (payload) {
    if (!presented) {
      await query('DELETE FROM refresh_tokens WHERE employee_id = ?', [payload.id]);
    }
    await expireAccessTokens(payload.id);
  }

  // A signed-out phone stops receiving this person's pushes. Named by the
  // install id the phone sends, and only for the employee this session
  // belonged to (from the access token, or — once that has expired — the
  // refresh token just presented).
  const owner = payload?.id ?? sessionOwner;
  const deviceId = deviceIdFrom(request);
  if (owner && deviceId) await forgetPushTokens(owner, deviceId).catch(() => {});

  clearAuthCookies(res);
  return res;
}

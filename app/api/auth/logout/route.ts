import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import {
  getTokenFromRequest,
  verifyAccessToken,
  generateRefreshTokenHash,
  clearAuthCookies,
  revokeTokens,
} from '@/lib/auth';
import { REFRESH_TOKEN_COOKIE } from '@/lib/constants';
import type { ApiResponse } from '@/lib/types';

// POST /api/auth/logout
export async function POST(request: NextRequest) {
  const res = NextResponse.json<ApiResponse>(
    { success: true, message: 'Logged out' },
  );

  // Identify the employee from the access token (if still valid)
  const accessToken = getTokenFromRequest(request);
  const payload = accessToken ? verifyAccessToken(accessToken) : null;

  if (payload) {
    // Delete all refresh tokens for this employee (full logout from all devices)
    await query(
      'DELETE FROM refresh_tokens WHERE employee_id = ?',
      [payload.id],
    );
    // ...and invalidate the access tokens already handed out. Deleting the
    // refresh token alone left the access token working until it expired, so a
    // token lifted from a device outlived the logout that was meant to stop it.
    await revokeTokens(payload.id);
  } else {
    // Access token gone / expired — try to revoke just the specific refresh token
    const refreshToken = request.cookies.get(REFRESH_TOKEN_COOKIE)?.value;
    if (refreshToken) {
      const tokenHash = generateRefreshTokenHash(refreshToken);
      await query(
        'DELETE FROM refresh_tokens WHERE token_hash = ?',
        [tokenHash],
      );
    }
  }

  clearAuthCookies(res);
  return res;
}

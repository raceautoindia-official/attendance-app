import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import {
  verifyRefreshToken,
  signAccessToken,
  signRefreshToken,
  generateRefreshTokenHash,
  setAuthCookies,
  clearAuthCookies,
} from '@/lib/auth';
import { REFRESH_TOKEN_COOKIE } from '@/lib/constants';
import type { ApiResponse, Employee } from '@/lib/types';

// ---------------------------------------------------------------------------
// POST /api/auth/refresh
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const rawToken = request.cookies.get(REFRESH_TOKEN_COOKIE)?.value;

  if (!rawToken) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'No refresh token' },
      { status: 401 },
    );
  }

  // 1. Verify JWT signature + expiry first (cheap check before hitting DB)
  const jwtPayload = verifyRefreshToken(rawToken);
  if (!jwtPayload) {
    const res = NextResponse.json<ApiResponse>(
      { success: false, error: 'Invalid or expired refresh token' },
      { status: 401 },
    );
    clearAuthCookies(res);
    return res;
  }

  // 2. Look up the hashed token in the DB (joins employee for fresh role/status)
  const tokenHash = generateRefreshTokenHash(rawToken);

  const row = await queryOne<
    Employee & { token_id: number; expires_at: Date }
  >(
    `SELECT e.id, e.emp_id, e.name, e.email, e.phone, e.role,
            e.is_active, e.manager_id, e.created_at, e.updated_at,
            rt.id AS token_id, rt.expires_at
     FROM refresh_tokens rt
     JOIN employees e ON rt.employee_id = e.id
     WHERE rt.token_hash = ?
       AND e.is_active = TRUE
       AND rt.expires_at > UTC_TIMESTAMP()`,
    [tokenHash],
  );

  if (!row) {
    const res = NextResponse.json<ApiResponse>(
      { success: false, error: 'Refresh token not found or expired' },
      { status: 401 },
    );
    clearAuthCookies(res);
    return res;
  }

  // 3. Rotate: delete the old token and issue a fresh pair
  await query('DELETE FROM refresh_tokens WHERE id = ?', [row.token_id]);

  const newAccessToken = signAccessToken({
    id: row.id,
    emp_id: row.emp_id,
    role: row.role,
  });
  const newRefreshToken = signRefreshToken({ id: row.id });
  const newHash = generateRefreshTokenHash(newRefreshToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

  await query(
    `INSERT INTO refresh_tokens (employee_id, token_hash, expires_at) VALUES (?, ?, ?)`,
    [row.id, newHash, expiresAt],
  );

  const res = NextResponse.json<ApiResponse<{ emp_id: string; role: string }>>(
    { success: true, data: { emp_id: row.emp_id, role: row.role } },
  );
  setAuthCookies(res, newAccessToken, newRefreshToken);
  return res;
}

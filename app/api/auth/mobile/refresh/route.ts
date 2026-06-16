import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne } from '@/lib/db';
import {
  verifyRefreshToken,
  signAccessToken,
  signRefreshToken,
  generateRefreshTokenHash,
  getExpirySecondsFromEnv,
} from '@/lib/auth';
import type { ApiResponse, Employee } from '@/lib/types';

// ---------------------------------------------------------------------------
// POST /api/auth/mobile/refresh
//
// Mobile counterpart to /api/auth/refresh. Reads the refresh token from the
// JSON body (not a cookie) and returns a freshly rotated access + refresh token
// pair in the body. The app calls this when an API request returns 401.
// ---------------------------------------------------------------------------

const RefreshSchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken is required'),
});

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const parsed = RefreshSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'No refresh token' },
      { status: 401 },
    );
  }

  const rawToken = parsed.data.refreshToken;

  // 1. Verify JWT signature + expiry (cheap, before DB)
  const jwtPayload = verifyRefreshToken(rawToken);
  if (!jwtPayload) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Invalid or expired refresh token' },
      { status: 401 },
    );
  }

  // 2. Look up the hashed token, joining the employee for fresh role/status
  const tokenHash = generateRefreshTokenHash(rawToken);
  const row = await queryOne<Employee & { token_id: number; expires_at: Date }>(
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
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Refresh token not found or expired' },
      { status: 401 },
    );
  }

  // 3. Rotate: delete the old token, issue a fresh pair
  await query('DELETE FROM refresh_tokens WHERE id = ?', [row.token_id]);

  const newAccessToken = signAccessToken({ id: row.id, emp_id: row.emp_id, role: row.role });
  const newRefreshToken = signRefreshToken({ id: row.id });
  const newHash = generateRefreshTokenHash(newRefreshToken);
  const refreshTtlSeconds = getExpirySecondsFromEnv(
    process.env.JWT_REFRESH_EXPIRY ?? '7d',
    7 * 24 * 60 * 60,
  );
  const expiresAt = new Date(Date.now() + refreshTtlSeconds * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  await query(
    `INSERT INTO refresh_tokens (employee_id, token_hash, expires_at) VALUES (?, ?, ?)`,
    [row.id, newHash, expiresAt],
  );

  return NextResponse.json<ApiResponse<{
    accessToken: string;
    refreshToken: string;
    employee: { id: number; emp_id: string; role: string };
  }>>({
    success: true,
    data: {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      employee: { id: row.id, emp_id: row.emp_id, role: row.role },
    },
  });
}

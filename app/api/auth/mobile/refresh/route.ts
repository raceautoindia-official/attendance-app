import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne } from '@/lib/db';
import {
  verifyRefreshToken,
  signAccessToken,
  currentTokenVersion,
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

/** How long a refresh token keeps working after it has been rotated. */
const REFRESH_ROTATION_GRACE_SECONDS = 60 * 60;

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

  // 3. Rotate: retire the old token, issue a fresh pair.
  //
  // RETIRED, NOT DELETED ON THE SPOT. It used to be deleted here, and on a
  // phone that is the wrong order of events to bet on: the rotation is
  // committed the moment this line runs, but the reply carrying the new pair
  // still has to make it back over mobile data. When it did not — a dropped
  // signal, a 20-second timeout in a lift — the phone was left holding the
  // only token it had, which no longer existed. Its next refresh was refused,
  // the app treated that as a logout and wiped the session, and the background
  // tracking went on collecting fixes it could no longer upload. That is the
  // "live tracking sometimes works, sometimes not", and the unexplained trips
  // back to the login screen.
  //
  // So the old token stays good for a grace period from its first use, long
  // enough to outlast a patch of bad signal; a repeat inside it simply gets
  // another fresh pair. Logging out and an admin's revoke still delete every
  // token the employee holds, grace or not.
  await query(
    `UPDATE refresh_tokens
        SET expires_at = LEAST(expires_at, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND))
      WHERE id = ?`,
    [REFRESH_ROTATION_GRACE_SECONDS, row.token_id],
  );
  // Retired tokens are no longer deleted on use, so sweep this employee's
  // expired ones here instead — the table stays as small as it was.
  await query(
    'DELETE FROM refresh_tokens WHERE employee_id = ? AND expires_at < UTC_TIMESTAMP()',
    [row.id],
  );

  const newAccessToken = signAccessToken({ id: row.id, emp_id: row.emp_id, role: row.role, tv: await currentTokenVersion(row.id) });
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

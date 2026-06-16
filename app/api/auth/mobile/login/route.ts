import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import {
  comparePin,
  signAccessToken,
  signRefreshToken,
  generateRefreshTokenHash,
  getExpirySecondsFromEnv,
} from '@/lib/auth';
import { LOGIN_MAX_ATTEMPTS, LOGIN_LOCKOUT_MINUTES } from '@/lib/constants';
import { getClientIp } from '@/lib/attendance';
import type { ApiResponse, EmployeeWithHash } from '@/lib/types';

// ---------------------------------------------------------------------------
// POST /api/auth/mobile/login
//
// PIN-based login for the React Native app. Unlike the web /api/auth/login
// (which requires WebAuthn/passkeys for most users), this returns the access +
// refresh tokens directly in the JSON body so the app can store them in secure
// storage and send `Authorization: Bearer <accessToken>` on every request.
//
// SECURITY NOTE: the mobile flow is PIN-only (no passkey second factor). It is
// intended for field employees using the dedicated app. Rate limiting still
// applies (shared with the web login via the audit_log).
// ---------------------------------------------------------------------------

const MobileLoginSchema = z.object({
  emp_id: z.string().min(1, 'emp_id is required'),
  pin: z.string().regex(/^\d{4,6}$/, 'PIN must be 4-6 digits'),
});

async function countRecentFailures(emp_id: string): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM audit_log
     WHERE action = 'login_failed'
       AND details->>'$.emp_id' = ?
       AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE)`,
    [emp_id, LOGIN_LOCKOUT_MINUTES],
  );
  return Number(row?.count ?? 0);
}

async function storeRefreshToken(employeeId: number, refreshToken: string): Promise<void> {
  const tokenHash = generateRefreshTokenHash(refreshToken);
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
    [employeeId, tokenHash, expiresAt],
  );
}

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const parsed = MobileLoginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Validation error' },
      { status: 400 },
    );
  }

  const { emp_id, pin } = parsed.data;

  // Rate limit
  const failures = await countRecentFailures(emp_id);
  if (failures >= LOGIN_MAX_ATTEMPTS) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: `Too many failed attempts. Try again in ${LOGIN_LOCKOUT_MINUTES} minutes.` },
      { status: 429 },
    );
  }

  const employee = await queryOne<EmployeeWithHash>(
    `SELECT id, emp_id, name, email, phone, role, is_active, manager_id,
            pin_hash, created_at, updated_at
     FROM employees
     WHERE emp_id = ? AND is_active = TRUE`,
    [emp_id],
  );

  // Always run bcrypt to avoid timing-based user enumeration
  const DUMMY_HASH = '$2b$12$GqF5VqQ1QGR0P5j0m1uNxuBBsMPJVQBQD4mV7fJLgTB8rXY3fXy8O';
  const pinValid = await comparePin(pin, employee?.pin_hash ?? DUMMY_HASH);

  if (!employee || !pinValid) {
    await insertAuditLog({
      action: 'login_failed',
      entity: 'auth',
      details: { emp_id, source: 'mobile' },
      ip_address: ip,
    });
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Invalid credentials' },
      { status: 401 },
    );
  }

  const accessToken = signAccessToken({
    id: employee.id,
    emp_id: employee.emp_id,
    role: employee.role,
  });
  const refreshToken = signRefreshToken({ id: employee.id });
  await storeRefreshToken(employee.id, refreshToken);

  await insertAuditLog({
    action: 'login_success',
    entity: 'auth',
    entity_id: employee.id,
    performed_by: employee.id,
    details: { method: 'mobile_pin' },
    ip_address: ip,
  });

  return NextResponse.json<ApiResponse<{
    accessToken: string;
    refreshToken: string;
    employee: { id: number; emp_id: string; name: string; role: string; email: string | null };
  }>>({
    success: true,
    data: {
      accessToken,
      refreshToken,
      employee: {
        id: employee.id,
        emp_id: employee.emp_id,
        name: employee.name,
        role: employee.role,
        email: employee.email,
      },
    },
  });
}

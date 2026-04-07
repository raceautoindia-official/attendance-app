import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import {
  comparePin,
  signAccessToken,
  signRefreshToken,
  generateRefreshTokenHash,
  setAuthCookies,
  setPendingAuthCookie,
} from '@/lib/auth';
import { LOGIN_MAX_ATTEMPTS, LOGIN_LOCKOUT_MINUTES } from '@/lib/constants';
import type { ApiResponse, EmployeeWithHash, PasskeyExemption } from '@/lib/types';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const LoginSchema = z.object({
  emp_id: z.string().min(1, 'emp_id is required'),
  pin: z.string().regex(/^\d{4,6}$/, 'PIN must be 4–6 digits'),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    req.headers.get('x-real-ip') ??
    '127.0.0.1'
  );
}

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

async function storeRefreshToken(
  employeeId: number,
  refreshToken: string,
): Promise<void> {
  const tokenHash = generateRefreshTokenHash(refreshToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  await query(
    `INSERT INTO refresh_tokens (employee_id, token_hash, expires_at) VALUES (?, ?, ?)`,
    [employeeId, tokenHash, expiresAt],
  );
}

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);

  // 1. Parse + validate
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Validation error' },
      { status: 400 },
    );
  }

  const { emp_id, pin } = parsed.data;

  // 2. Rate limit check
  const failures = await countRecentFailures(emp_id);
  if (failures >= LOGIN_MAX_ATTEMPTS) {
    return NextResponse.json<ApiResponse>(
      {
        success: false,
        error: `Too many failed attempts. Try again in ${LOGIN_LOCKOUT_MINUTES} minutes.`,
      },
      { status: 429 },
    );
  }

  // 3. Fetch employee with hash
  const employee = await queryOne<EmployeeWithHash>(
    `SELECT id, emp_id, name, email, phone, role, is_active, manager_id,
            pin_hash, created_at, updated_at
     FROM employees
     WHERE emp_id = ? AND is_active = TRUE`,
    [emp_id],
  );

  // 4. Verify PIN — always run bcrypt to avoid timing-based user enumeration
  const DUMMY_HASH =
    '$2b$12$GqF5VqQ1QGR0P5j0m1uNxuBBsMPJVQBQD4mV7fJLgTB8rXY3fXy8O';
  const pinValid = await comparePin(pin, employee?.pin_hash ?? DUMMY_HASH);

  if (!employee || !pinValid) {
    await insertAuditLog({
      action: 'login_failed',
      entity: 'auth',
      details: { emp_id },
      ip_address: ip,
    });
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Invalid credentials' },
      { status: 401 },
    );
  }

  // 5. Route based on passkeys / exemption
  const [passkeyRows, exemptionRow] = await Promise.all([
    query<{ id: number }>(
      'SELECT id FROM passkeys WHERE employee_id = ? LIMIT 1',
      [employee.id],
    ),
    queryOne<PasskeyExemption>(
      `SELECT id FROM passkey_exemptions
       WHERE employee_id = ? AND is_active = TRUE LIMIT 1`,
      [employee.id],
    ),
  ]);

  const hasPasskeys = passkeyRows.length > 0;
  const hasExemption = exemptionRow !== null;

  // Case A — has passkeys: return a pending-auth cookie, require WebAuthn
  if (hasPasskeys) {
    const res = NextResponse.json<ApiResponse<{ requiresWebAuthn: true; emp_id: string }>>(
      { success: true, data: { requiresWebAuthn: true, emp_id: employee.emp_id } },
    );
    setPendingAuthCookie(res, employee.emp_id);

    await insertAuditLog({
      action: 'login_pin_ok_awaiting_webauthn',
      entity: 'auth',
      entity_id: employee.id,
      performed_by: employee.id,
      ip_address: ip,
    });

    return res;
  }

  // Case B — exemption, no passkeys: issue tokens
  if (hasExemption) {
    const accessToken = signAccessToken({
      id: employee.id,
      emp_id: employee.emp_id,
      role: employee.role,
    });
    const refreshToken = signRefreshToken({ id: employee.id });
    await storeRefreshToken(employee.id, refreshToken);

    const res = NextResponse.json<ApiResponse<{
      employee: { id: number; emp_id: string; name: string; role: string; email: string | null };
    }>>({
      success: true,
      data: {
        employee: {
          id: employee.id,
          emp_id: employee.emp_id,
          name: employee.name,
          role: employee.role,
          email: employee.email,
        },
      },
    });
    setAuthCookies(res, accessToken, refreshToken);

    await insertAuditLog({
      action: 'login_success',
      entity: 'auth',
      entity_id: employee.id,
      performed_by: employee.id,
      details: { method: 'pin_exemption' },
      ip_address: ip,
    });

    return res;
  }

  // Case C — no passkeys, no exemption: must enroll first
  return NextResponse.json<ApiResponse<{ requiresPasskeySetup: true }>>(
    { success: true, data: { requiresPasskeySetup: true } },
  );
}

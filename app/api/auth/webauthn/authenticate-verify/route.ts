import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import {
  signAccessToken,
  signRefreshToken,
  generateRefreshTokenHash,
  setAuthCookies,
  getPendingAuthFromRequest,
  clearPendingAuthCookie,
} from '@/lib/auth';
import { verifyAuthenticationResponse } from '@/lib/webauthn';
import type { ApiResponse, Employee } from '@/lib/types';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VerifySchema = z.object({
  emp_id: z.string().min(1, 'emp_id is required'),
  assertionResponse: z.object({
    id: z.string().min(1),
    rawId: z.string().min(1),
    response: z.object({
      clientDataJSON: z.string(),
      authenticatorData: z.string(),
      signature: z.string(),
      userHandle: z.string().optional(),
    }),
    type: z.literal('public-key'),
    clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
  }),
});

// ---------------------------------------------------------------------------
// POST /api/auth/webauthn/authenticate-verify
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? '127.0.0.1';

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const parsed = VerifySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Validation error' },
      { status: 400 },
    );
  }

  const { emp_id, assertionResponse } = parsed.data;

  // 1. Verify the pending-auth cookie — confirms PIN was checked in this session
  const pendingEmpId = getPendingAuthFromRequest(request);
  if (!pendingEmpId || pendingEmpId !== emp_id) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'PIN verification required before WebAuthn' },
      { status: 401 },
    );
  }

  // 2. Load employee
  const employee = await queryOne<Employee>(
    `SELECT id, emp_id, name, email, phone, role, is_active, manager_id,
            created_at, updated_at
     FROM employees
     WHERE emp_id = ? AND is_active = TRUE`,
    [emp_id],
  );

  if (!employee) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Employee not found' },
      { status: 404 },
    );
  }

  // 3. Verify WebAuthn assertion
  const result = await verifyAuthenticationResponse(
    { id: employee.id, emp_id: employee.emp_id },
    assertionResponse as AuthenticationResponseJSON,
  );

  if (!result.verified || !result.credentialId) {
    await insertAuditLog({
      action: 'login_failed',
      entity: 'auth',
      entity_id: employee.id,
      performed_by: employee.id,
      details: { method: 'webauthn', emp_id },
      ip_address: ip,
    });
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'WebAuthn verification failed' },
      { status: 401 },
    );
  }

  // 4. Persist updated counter and last_used_at
  await query(
    `UPDATE passkeys
     SET counter = ?, last_used_at = UTC_TIMESTAMP()
     WHERE employee_id = ? AND credential_id = ?`,
    [result.newCounter ?? 0, employee.id, result.credentialId],
  );

  // 5. Issue access + refresh tokens
  const accessToken = signAccessToken({
    id: employee.id,
    emp_id: employee.emp_id,
    role: employee.role,
  });
  const refreshToken = signRefreshToken({ id: employee.id });
  const tokenHash = generateRefreshTokenHash(refreshToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

  await query(
    `INSERT INTO refresh_tokens (employee_id, token_hash, expires_at) VALUES (?, ?, ?)`,
    [employee.id, tokenHash, expiresAt],
  );

  await insertAuditLog({
    action: 'login_success',
    entity: 'auth',
    entity_id: employee.id,
    performed_by: employee.id,
    details: { method: 'webauthn' },
    ip_address: ip,
  });

  const res = NextResponse.json<ApiResponse<{
    id: number; emp_id: string; name: string; role: string; email: string | null;
  }>>({
    success: true,
    data: {
      id: employee.id,
      emp_id: employee.emp_id,
      name: employee.name,
      role: employee.role,
      email: employee.email,
    },
  });

  setAuthCookies(res, accessToken, refreshToken);
  clearPendingAuthCookie(res);
  return res;
}

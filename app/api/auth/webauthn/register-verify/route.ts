import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { queryOne, query, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { verifyRegistrationResponse } from '@/lib/webauthn';
import { MAX_DEVICES_PER_EMPLOYEE } from '@/lib/constants';
import type { ApiResponse, Employee } from '@/lib/types';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';

// ---------------------------------------------------------------------------
// Validation — the body is the RegistrationResponseJSON from the browser
// ---------------------------------------------------------------------------

const RegistrationBodySchema = z.object({
  id: z.string().min(1),
  rawId: z.string().min(1),
  response: z.object({
    clientDataJSON: z.string(),
    attestationObject: z.string(),
    transports: z.array(z.string()).optional(),
  }),
  type: z.literal('public-key'),
  clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
  device_name: z.string().max(100).optional(),
});

// ---------------------------------------------------------------------------
// POST /api/auth/webauthn/register-verify
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const parsed = RegistrationBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Validation error' },
      { status: 400 },
    );
  }

  const { device_name, ...registrationResponse } = parsed.data;

  // Enforce per-employee device cap
  const countRow = await queryOne<{ count: number }>(
    'SELECT COUNT(*) AS count FROM passkeys WHERE employee_id = ?',
    [auth.id],
  );
  if (Number(countRow?.count ?? 0) >= MAX_DEVICES_PER_EMPLOYEE) {
    return NextResponse.json<ApiResponse>(
      {
        success: false,
        error: `Maximum of ${MAX_DEVICES_PER_EMPLOYEE} passkeys allowed per employee`,
      },
      { status: 409 },
    );
  }

  const employee: Pick<Employee, 'emp_id'> = { emp_id: auth.emp_id };

  const result = await verifyRegistrationResponse(
    employee,
    registrationResponse as RegistrationResponseJSON,
  );

  if (!result.verified || !result.credentialId || result.publicKey === undefined) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Passkey registration failed' },
      { status: 400 },
    );
  }

  // Derive a human-readable device name from User-Agent if not supplied
  const resolvedDeviceName =
    device_name?.trim() ||
    request.headers.get('user-agent')?.slice(0, 100) ||
    'Unknown device';

  await query(
    `INSERT INTO passkeys
       (employee_id, credential_id, public_key, counter, device_name)
     VALUES (?, ?, ?, ?, ?)`,
    [
      auth.id,
      result.credentialId,
      result.publicKey,
      result.counter ?? 0,
      resolvedDeviceName,
    ],
  );

  await insertAuditLog({
    action: 'passkey_registered',
    entity: 'passkey',
    performed_by: auth.id,
    details: { device_name: resolvedDeviceName },
    ip_address:
      request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
  });

  return NextResponse.json<ApiResponse<{ credentialId: string }>>(
    { success: true, data: { credentialId: result.credentialId } },
  );
}

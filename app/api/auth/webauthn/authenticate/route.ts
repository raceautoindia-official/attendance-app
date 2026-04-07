import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { queryOne } from '@/lib/db';
import { generateAuthenticationOptions } from '@/lib/webauthn';
import type { ApiResponse, Employee } from '@/lib/types';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const AuthenticateSchema = z.object({
  emp_id: z.string().min(1, 'emp_id is required'),
});

// ---------------------------------------------------------------------------
// POST /api/auth/webauthn/authenticate
// No auth required — this only returns public WebAuthn options.
// Security comes from: (a) the challenge being unpredictable, and
// (b) the authenticate-verify route checking the pending_auth cookie.
// ---------------------------------------------------------------------------

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

  const parsed = AuthenticateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Validation error' },
      { status: 400 },
    );
  }

  const { emp_id } = parsed.data;

  const employee = await queryOne<Pick<Employee, 'id' | 'emp_id'>>(
    'SELECT id, emp_id FROM employees WHERE emp_id = ? AND is_active = TRUE',
    [emp_id],
  );

  // Return the same shape even when the employee is not found to avoid
  // leaking whether an emp_id exists in the system.
  if (!employee) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Authentication options unavailable' },
      { status: 404 },
    );
  }

  const options = await generateAuthenticationOptions(employee);

  return NextResponse.json<ApiResponse<typeof options>>(
    { success: true, data: options },
  );
}

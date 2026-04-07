import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { getPendingAuthFromRequest } from '@/lib/auth';
import { generateAuthenticationOptions } from '@/lib/webauthn';
import type { ApiResponse, Employee } from '@/lib/types';

// ---------------------------------------------------------------------------
// GET /api/auth/webauthn/authenticate
// Reads emp_id from the pending_auth cookie (set after PIN verification).
// No auth required — security comes from the unpredictable challenge and the
// pending_auth cookie being verified in authenticate-verify.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const emp_id = getPendingAuthFromRequest(request);
  if (!emp_id) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'No pending authentication session. Please sign in with your PIN first.' },
      { status: 401 },
    );
  }

  const employee = await queryOne<Pick<Employee, 'id' | 'emp_id'>>(
    'SELECT id, emp_id FROM employees WHERE emp_id = ? AND is_active = TRUE',
    [emp_id],
  );

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

import { NextRequest, NextResponse } from 'next/server';
import { requireEnrolmentAuth } from '@/lib/auth';
import { generateRegistrationOptions, getWebAuthnConfigFromRequest } from '@/lib/webauthn';
import type { ApiResponse, Employee } from '@/lib/types';

// GET /api/auth/webauthn/register
// Requires a valid access token — employee must have completed PIN login first.
export async function GET(request: NextRequest) {
  const auth = await requireEnrolmentAuth(request);
  if (auth instanceof NextResponse) return auth;

  // Fetch just the fields generateRegistrationOptions needs
  const employee: Pick<Employee, 'id' | 'emp_id' | 'name'> = {
    id: auth.id,
    emp_id: auth.emp_id,
    name: auth.emp_id, // name not in JWT; use emp_id as fallback display name
  };

  const options = await generateRegistrationOptions(employee, getWebAuthnConfigFromRequest(request));

  // Never cache: each call must hit the server to store a fresh challenge.
  return NextResponse.json<ApiResponse<typeof options>>(
    { success: true, data: options },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { generateRegistrationOptions } from '@/lib/webauthn';
import type { ApiResponse, Employee } from '@/lib/types';

// POST /api/auth/webauthn/register
// Requires a valid access token — employee must have completed PIN login first.
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  // Fetch just the fields generateRegistrationOptions needs
  const employee: Pick<Employee, 'id' | 'emp_id' | 'name'> = {
    id: auth.id,
    emp_id: auth.emp_id,
    name: auth.emp_id, // name not in JWT; use emp_id as fallback display name
  };

  const options = await generateRegistrationOptions(employee);

  return NextResponse.json<ApiResponse<typeof options>>(
    { success: true, data: options },
  );
}

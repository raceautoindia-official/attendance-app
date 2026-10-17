import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth';
import { deviceIdFrom } from '@/lib/deviceBinding';
import { isPushToken, registerPushToken } from '@/lib/push';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// POST /api/push/register — this phone's push address, for the signed-in user.
//
// Called by the app on every open (it skips the call while the address is
// unchanged and recently sent). See lib/push.ts for why pushes exist at all.
// ---------------------------------------------------------------------------

const RegisterSchema = z.object({
  token: z.string().refine(isPushToken, 'Not a push token'),
  platform: z.string().max(16).optional(),
});

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['employee', 'manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = RegisterSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Validation error' },
      { status: 400 },
    );
  }

  const stored = await registerPushToken(
    auth.id,
    parsed.data.token,
    deviceIdFrom(request),
    parsed.data.platform ?? request.headers.get('x-device-platform')?.slice(0, 16) ?? null,
  );

  // Not stored = the push_tokens migration has not been run. Said plainly, as
  // success:true — the phone carries on announcing for itself either way, and
  // retrying would change nothing until the table exists.
  return NextResponse.json<ApiResponse<{ stored: boolean }>>({ success: true, data: { stored } });
}

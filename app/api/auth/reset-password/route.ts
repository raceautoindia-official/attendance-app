import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, insertAuditLog } from '@/lib/db';
import { hashPin, revokeTokens } from '@/lib/auth';
import { getClientIp } from '@/lib/attendance';
import {
  consumeResetToken,
  hasPasswordResetTable,
  invalidateOtherResets,
  resolveResetToken,
} from '@/lib/passwordReset';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// GET  /api/auth/reset-password?token=…   — is this link still good?
// POST /api/auth/reset-password { token, pin } — set the new PIN.
//
// The GET exists so the page can say "this link has expired" BEFORE the
// employee types a new PIN twice, rather than after.
// ---------------------------------------------------------------------------

const EXPIRED = 'This reset link has expired or has already been used. Please request a new one.';

export async function GET(request: NextRequest) {
  if (!(await hasPasswordResetTable())) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Password reset is not set up on this server yet.' },
      { status: 503 },
    );
  }
  const token = request.nextUrl.searchParams.get('token') ?? '';
  const reset = await resolveResetToken(token);
  if (!reset) {
    return NextResponse.json<ApiResponse>({ success: false, error: EXPIRED }, { status: 400 });
  }
  // The name is shown so the employee can tell they are resetting the right
  // account. Nothing else about the record is exposed.
  return NextResponse.json<ApiResponse<{ name: string; emp_id: string }>>({
    success: true,
    data: { name: reset.name, emp_id: reset.emp_id },
  });
}

const PostSchema = z.object({
  token: z.string().min(1),
  // Same rule the login route enforces — a reset must not be able to set a PIN
  // that then cannot be used to log in.
  pin: z.string().regex(/^\d{4,6}$/, 'PIN must be 4-6 digits'),
});

export async function POST(request: NextRequest) {
  if (!(await hasPasswordResetTable())) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Password reset is not set up on this server yet.' },
      { status: 503 },
    );
  }

  const parsed = PostSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' },
      { status: 400 },
    );
  }

  const reset = await resolveResetToken(parsed.data.token);
  if (!reset) {
    return NextResponse.json<ApiResponse>({ success: false, error: EXPIRED }, { status: 400 });
  }

  // Burn the token BEFORE changing anything: if two submissions race, only the
  // one that wins this compare-and-set proceeds, so a link can never be spent
  // twice.
  if (!(await consumeResetToken(reset.id))) {
    return NextResponse.json<ApiResponse>({ success: false, error: EXPIRED }, { status: 400 });
  }

  await query('UPDATE employees SET pin_hash = ? WHERE id = ?', [
    await hashPin(parsed.data.pin),
    reset.employee_id,
  ]);

  // Older links in the inbox stop working, and every existing session ends.
  // "I forgot my PIN" and "somebody else knows my PIN" are indistinguishable
  // from here, so the safe reading is assumed: whoever was logged in must log
  // in again with the new PIN.
  await invalidateOtherResets(reset.employee_id, reset.id);
  await revokeTokens(reset.employee_id).catch(() => {});

  await insertAuditLog({
    action: 'password_reset_completed',
    entity: 'employee',
    entity_id: reset.employee_id,
    performed_by: null,
    details: { employee_id: reset.employee_id, emp_id: reset.emp_id, sessions_revoked: true },
    ip_address: getClientIp(request),
  });

  return NextResponse.json<ApiResponse>({
    success: true,
    message: 'Your PIN has been changed. Sign in on the app with your new PIN.',
  });
}

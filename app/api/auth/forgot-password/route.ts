import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { queryOne, insertAuditLog } from '@/lib/db';
import { getClientIp } from '@/lib/attendance';
import { sendPasswordResetEmail } from '@/lib/mailer';
import {
  createResetToken,
  hasPasswordResetTable,
  mailIsConfigured,
  resetRateExceeded,
  RESET_TTL_MINUTES,
} from '@/lib/passwordReset';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// POST /api/auth/forgot-password  { emp_id }
//
// Emails a single-use link to the address on the employee's record.
//
// The answer is deliberately IDENTICAL whether or not the employee ID exists,
// whether or not they have an email on file, and whether or not they have
// asked five times already. Anything else turns this endpoint into a way to
// discover valid employee IDs — and every employee ID here is a short,
// guessable string like RACE013.
//
// The ONE thing it does report honestly is the server being unable to send
// mail at all. That is a fact about this deployment, not about any account, and
// hiding it means an employee waits forever for a message nobody could have
// sent — which is precisely what happened to every alert this system emitted
// while SMTP sat at its placeholder.
// ---------------------------------------------------------------------------

const Schema = z.object({
  emp_id: z.string().trim().min(1, 'Employee ID is required').max(50),
});

const SAME_ANSWER = 'If that employee ID exists and has an email on file, a reset link is on its way.';

export async function POST(request: NextRequest) {
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Employee ID is required' },
      { status: 400 },
    );
  }

  if (!(await hasPasswordResetTable())) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Password reset is not set up on this server yet.' },
      { status: 503 },
    );
  }
  if (!mailIsConfigured()) {
    return NextResponse.json<ApiResponse>(
      {
        success: false,
        error: 'Email is not configured on this server, so a reset link cannot be sent. Please ask your admin to reset your PIN.',
      },
      { status: 503 },
    );
  }

  const ip = getClientIp(request);
  const employee = await queryOne<{ id: number; name: string; email: string | null }>(
    'SELECT id, name, email FROM employees WHERE emp_id = ? AND is_active = TRUE',
    [parsed.data.emp_id],
  );

  // Everything below is best-effort and silent: the response never changes.
  if (employee?.email && !(await resetRateExceeded(employee.id))) {
    try {
      const token = await createResetToken(employee.id, ip);
      const base = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '');
      await sendPasswordResetEmail(employee.email, {
        employeeName: employee.name,
        link: `${base}/reset-password?token=${encodeURIComponent(token)}`,
        expiresMinutes: RESET_TTL_MINUTES,
      });
      await insertAuditLog({
        action: 'password_reset_requested',
        entity: 'employee',
        entity_id: employee.id,
        performed_by: null,
        details: { employee_id: employee.id, emp_id: parsed.data.emp_id },
        ip_address: ip,
      });
    } catch (err) {
      // A mail failure must not become an account oracle, so the employee
      // still gets the same sentence — but an admin can find this in the log.
      console.error('[forgot-password] could not send reset email', err);
    }
  }

  return NextResponse.json<ApiResponse>({ success: true, message: SAME_ANSWER });
}

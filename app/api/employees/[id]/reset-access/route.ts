import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// POST /api/employees/[id]/reset-access   (super_admin only)
//
// One-click rescue for an employee stuck on "Passkey setup required" (or who
// lost their passkey device). In a single transaction it:
//   1. Removes ALL registered passkeys for the employee.
//   2. Deactivates any existing active PIN exemption and grants a fresh one.
//
// The employee can then sign in with their PIN (Case B of the login flow) and
// re-enrol a passkey at /register-passkey.
// ---------------------------------------------------------------------------

const ResetSchema = z.object({
  reason: z.string().min(1).max(1000).optional(),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  const { id } = await context.params;
  const employeeId = parseInt(id, 10);
  if (isNaN(employeeId)) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid ID' }, { status: 400 });
  }

  const emp = await queryOne<{ id: number; emp_id: string }>(
    'SELECT id, emp_id FROM employees WHERE id = ? AND is_active = TRUE',
    [employeeId],
  );
  if (!emp) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Employee not found' }, { status: 404 });
  }

  // Optional reason from body (non-fatal if body is absent)
  let reason: string | undefined;
  try {
    const raw = await request.json();
    const parsed = ResetSchema.safeParse(raw);
    if (parsed.success) reason = parsed.data.reason;
  } catch { /* body is optional */ }

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null;

  // Run both changes atomically so we never leave the account half-reset.
  const conn = await pool.getConnection();
  let deletedPasskeys = 0;
  let exemptionId = 0;
  try {
    await conn.beginTransaction();

    const [countRows] = await conn.query(
      'SELECT COUNT(*) AS count FROM passkeys WHERE employee_id = ?',
      [employeeId],
    );
    deletedPasskeys = Number((countRows as unknown as Array<{ count: number }>)[0]?.count ?? 0);

    await conn.query('DELETE FROM passkeys WHERE employee_id = ?', [employeeId]);

    await conn.query(
      'UPDATE passkey_exemptions SET is_active = FALSE WHERE employee_id = ? AND is_active = TRUE',
      [employeeId],
    );

    const [insertResult] = await conn.query(
      `INSERT INTO passkey_exemptions (employee_id, granted_by, reason)
       VALUES (?, ?, ?)`,
      [employeeId, auth.id, reason ?? 'Login reset — pending passkey re-enrolment'],
    );
    exemptionId = (insertResult as unknown as { insertId: number }).insertId;

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    console.error('[reset-access] failed:', err);
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Failed to reset login access' },
      { status: 500 },
    );
  } finally {
    conn.release();
  }

  await insertAuditLog({
    action: 'login_access_reset',
    entity: 'employee',
    entity_id: employeeId,
    performed_by: auth.id,
    details: {
      emp_id: emp.emp_id,
      deleted_passkeys: deletedPasskeys,
      exemption_id: exemptionId,
      reason: reason ?? null,
    },
    ip_address: ip,
  });

  return NextResponse.json<ApiResponse<{ deleted_passkeys: number; exemption_id: number }>>({
    success: true,
    data: { deleted_passkeys: deletedPasskeys, exemption_id: exemptionId },
    message: 'Login access reset — employee can now sign in with their PIN and re-enrol a passkey',
  });
}

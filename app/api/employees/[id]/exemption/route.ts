import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import type { ApiResponse, PasskeyExemption } from '@/lib/types';

// ---------------------------------------------------------------------------
// Helper: manager scope check
// ---------------------------------------------------------------------------

async function assertTeamScope(
  auth: { id: number; role: string },
  employeeId: number,
): Promise<NextResponse | null> {
  if (auth.role === 'super_admin') return null;
  const emp = await queryOne<{ manager_id: number | null }>(
    'SELECT manager_id FROM employees WHERE id = ?',
    [employeeId],
  );
  if (!emp || emp.manager_id !== auth.id) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Access denied: not in your team' },
      { status: 403 },
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// POST /api/employees/[id]/exemption
// Grant a passkey exemption — employee can clock in with PIN only.
// ---------------------------------------------------------------------------

const GrantSchema = z.object({
  reason: z.string().min(1).max(1000).optional(),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const { id } = await context.params;
  const employeeId = parseInt(id, 10);
  if (isNaN(employeeId)) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid ID' }, { status: 400 });
  }

  const scopeError = await assertTeamScope(auth, employeeId);
  if (scopeError) return scopeError;

  const emp = await queryOne<{ id: number; emp_id: string }>(
    'SELECT id, emp_id FROM employees WHERE id = ? AND is_active = TRUE',
    [employeeId],
  );
  if (!emp) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Employee not found' }, { status: 404 });
  }

  let reason: string | undefined;
  try {
    const raw = await request.json();
    const parsed = GrantSchema.safeParse(raw);
    if (parsed.success) reason = parsed.data.reason;
  } catch { /* reason is optional */ }

  // Deactivate any currently active exemptions before inserting the new one
  await query(
    'UPDATE passkey_exemptions SET is_active = FALSE WHERE employee_id = ? AND is_active = TRUE',
    [employeeId],
  );

  const result = await query(
    `INSERT INTO passkey_exemptions (employee_id, granted_by, reason)
     VALUES (?, ?, ?)`,
    [employeeId, auth.id, reason ?? null],
  );
  const insertId = (result as unknown as { insertId: number }).insertId;

  await insertAuditLog({
    action: 'passkey_exemption_granted',
    entity: 'passkey_exemption',
    entity_id: insertId,
    performed_by: auth.id,
    details: { emp_id: emp.emp_id, reason: reason ?? null },
    ip_address: request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
  });

  const exemption = await queryOne<PasskeyExemption>(
    'SELECT * FROM passkey_exemptions WHERE id = ?',
    [insertId],
  );

  return NextResponse.json<ApiResponse<PasskeyExemption>>(
    { success: true, data: exemption! },
    { status: 201 },
  );
}

// ---------------------------------------------------------------------------
// DELETE /api/employees/[id]/exemption
// Revoke the employee's active passkey exemption.
// ---------------------------------------------------------------------------

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const { id } = await context.params;
  const employeeId = parseInt(id, 10);
  if (isNaN(employeeId)) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid ID' }, { status: 400 });
  }

  const scopeError = await assertTeamScope(auth, employeeId);
  if (scopeError) return scopeError;

  const exemption = await queryOne<PasskeyExemption>(
    'SELECT * FROM passkey_exemptions WHERE employee_id = ? AND is_active = TRUE LIMIT 1',
    [employeeId],
  );
  if (!exemption) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'No active exemption found for this employee' },
      { status: 404 },
    );
  }

  await query(
    'UPDATE passkey_exemptions SET is_active = FALSE WHERE id = ?',
    [exemption.id],
  );

  await insertAuditLog({
    action: 'passkey_exemption_revoked',
    entity: 'passkey_exemption',
    entity_id: exemption.id,
    performed_by: auth.id,
    details: { employee_id: employeeId },
    ip_address: request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
  });

  return NextResponse.json<ApiResponse>(
    { success: true, message: 'Passkey exemption revoked' },
  );
}

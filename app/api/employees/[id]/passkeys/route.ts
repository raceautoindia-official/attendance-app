import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import type { ApiResponse } from '@/lib/types';

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

const DeletePasskeysSchema = z.object({
  reason: z.string().min(1).max(500).optional(),
});

// ---------------------------------------------------------------------------
// DELETE /api/employees/[id]/passkeys
// Removes all registered passkeys for the employee. On next login the
// employee will be asked to re-enroll or fall back to a PIN exemption.
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
    const parsed = DeletePasskeysSchema.safeParse(raw);
    if (parsed.success) reason = parsed.data.reason;
  } catch { /* body is optional */ }

  const countRow = await queryOne<{ count: number }>(
    'SELECT COUNT(*) AS count FROM passkeys WHERE employee_id = ?',
    [employeeId],
  );
  const deletedCount = Number(countRow?.count ?? 0);

  await query('DELETE FROM passkeys WHERE employee_id = ?', [employeeId]);

  await insertAuditLog({
    action: 'passkeys_revoked',
    entity: 'passkey',
    entity_id: employeeId,
    performed_by: auth.id,
    details: { emp_id: emp.emp_id, deleted_count: deletedCount, reason: reason ?? null },
    ip_address: request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
  });

  return NextResponse.json<ApiResponse<{ deleted_count: number }>>(
    { success: true, data: { deleted_count: deletedCount }, message: 'Passkeys revoked — employee must re-enroll' },
  );
}

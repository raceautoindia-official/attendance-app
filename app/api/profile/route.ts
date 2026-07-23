import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import {
  hasBankColumns,
  bankSelect,
  BankDetailsSchema,
  normalizeBankDetails,
} from '@/lib/employeeDetails';
import type { ApiResponse, Employee } from '@/lib/types';

// ---------------------------------------------------------------------------
// GET /api/profile — the logged-in employee's own details (incl. bank/identity)
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['employee', 'manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const bankColsExist = await hasBankColumns();
  const employee = await queryOne<Employee>(
    `SELECT e.id, e.emp_id, e.name, e.email, e.phone, e.department,
            ${bankSelect(bankColsExist)},
            e.role, e.is_active, e.manager_id, e.created_at, e.updated_at
     FROM employees e WHERE e.id = ?`,
    [auth.id],
  );
  if (!employee) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Employee not found' }, { status: 404 });
  }
  return NextResponse.json<ApiResponse<{ employee: Employee }>>({
    success: true,
    data: { employee },
  });
}

// ---------------------------------------------------------------------------
// PUT /api/profile — employee updates their own bank & identity details
// ---------------------------------------------------------------------------

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request, ['employee', 'manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 }); }

  const parsed = BankDetailsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Validation error' },
      { status: 400 },
    );
  }

  const fields = normalizeBankDetails(parsed.data);
  if (Object.keys(fields).length === 0) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'No fields to update' }, { status: 400 });
  }

  if (!(await hasBankColumns())) {
    return NextResponse.json<ApiResponse>(
      {
        success: false,
        error: 'Employee detail columns are missing. Run migration: database/migrations/2026-07-23_add_employee_details_documents_leave_quotas.sql',
      },
      { status: 503 },
    );
  }

  const setClauses = Object.keys(fields).map(col => `${col} = ?`);
  await query(
    `UPDATE employees SET ${setClauses.join(', ')} WHERE id = ?`,
    [...Object.values(fields), auth.id],
  );

  // Log which fields changed, never their values (PAN/Aadhaar/account numbers).
  await insertAuditLog({
    action: 'employee_profile_updated',
    entity: 'employee',
    entity_id: auth.id,
    performed_by: auth.id,
    details: { changed_fields: Object.keys(fields) },
    ip_address: request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
  });

  const employee = await queryOne<Employee>(
    `SELECT e.id, e.emp_id, e.name, e.email, e.phone, e.department,
            ${bankSelect(true)},
            e.role, e.is_active, e.manager_id, e.created_at, e.updated_at
     FROM employees e WHERE e.id = ?`,
    [auth.id],
  );
  return NextResponse.json<ApiResponse<{ employee: Employee }>>({
    success: true,
    data: { employee: employee! },
  });
}

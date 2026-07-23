import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import {
  DOCUMENT_TYPES,
  DOCUMENT_MIME_TYPES,
  MAX_DOCUMENT_BYTES,
  canAccessEmployee,
} from '@/lib/employeeDetails';
import type { ApiResponse, EmployeeDocument } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

async function resolveId(context: Params): Promise<number | null> {
  const { id } = await context.params;
  const n = parseInt(id, 10);
  return isNaN(n) ? null : n;
}

function missingTableResponse() {
  return NextResponse.json<ApiResponse>(
    {
      success: false,
      error: 'Documents table is missing. Run migration: database/migrations/2026-07-23_add_employee_details_documents_leave_quotas.sql',
    },
    { status: 503 },
  );
}

// ---------------------------------------------------------------------------
// GET /api/employees/[id]/documents — list (metadata only, never file_data)
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest, context: Params) {
  const auth = await requireAuth(request, ['employee', 'manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const employeeId = await resolveId(context);
  if (!employeeId) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid ID' }, { status: 400 });
  }
  if (!(await canAccessEmployee(auth, employeeId))) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Access denied' }, { status: 403 });
  }

  try {
    const documents = await query<EmployeeDocument>(
      `SELECT d.id, d.employee_id, d.doc_type, d.title, d.file_name, d.mime_type,
              d.size_bytes, d.uploaded_by, d.created_at,
              u.name AS uploaded_by_name
       FROM employee_documents d
       LEFT JOIN employees u ON u.id = d.uploaded_by
       WHERE d.employee_id = ?
       ORDER BY d.created_at DESC, d.id DESC`,
      [employeeId],
    );
    return NextResponse.json<ApiResponse<{ documents: EmployeeDocument[] }>>({
      success: true,
      data: { documents },
    });
  } catch (error) {
    if ((error as { code?: string })?.code === 'ER_NO_SUCH_TABLE') return missingTableResponse();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// POST /api/employees/[id]/documents — upload (JSON body with base64 data)
// ---------------------------------------------------------------------------

const UploadSchema = z.object({
  doc_type: z.enum(DOCUMENT_TYPES),
  title: z.string().trim().min(1, 'Title is required').max(150),
  file_name: z.string().trim().min(1).max(255),
  mime_type: z.enum(DOCUMENT_MIME_TYPES as [string, ...string[]], {
    error: 'Only PDF, JPG, PNG or WebP files are allowed',
  }),
  // Raw base64 (no data: prefix). ~4/3 of the file size.
  data_base64: z.string().min(1, 'File data is required'),
});

export async function POST(request: NextRequest, context: Params) {
  const auth = await requireAuth(request, ['employee', 'manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const employeeId = await resolveId(context);
  if (!employeeId) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid ID' }, { status: 400 });
  }
  if (!(await canAccessEmployee(auth, employeeId))) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Access denied' }, { status: 403 });
  }

  const target = await queryOne<{ id: number }>(
    'SELECT id FROM employees WHERE id = ? AND is_active = TRUE',
    [employeeId],
  );
  if (!target) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Employee not found' }, { status: 404 });
  }

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 }); }

  const parsed = UploadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Validation error' },
      { status: 400 },
    );
  }

  const { doc_type, title, file_name, mime_type } = parsed.data;
  // Strip an accidental data-URL prefix, then verify it decodes as base64.
  const base64 = parsed.data.data_base64.replace(/^data:[^;]+;base64,/, '');
  let sizeBytes: number;
  try {
    const buf = Buffer.from(base64, 'base64');
    sizeBytes = buf.length;
    if (sizeBytes === 0) throw new Error('empty');
  } catch {
    return NextResponse.json<ApiResponse>({ success: false, error: 'File data is not valid base64' }, { status: 400 });
  }
  if (sizeBytes > MAX_DOCUMENT_BYTES) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: `File is too large (max ${Math.floor(MAX_DOCUMENT_BYTES / (1024 * 1024))} MB)` },
      { status: 413 },
    );
  }

  try {
    const result = await query(
      `INSERT INTO employee_documents (employee_id, doc_type, title, file_name, mime_type, size_bytes, file_data, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [employeeId, doc_type, title, file_name, mime_type, sizeBytes, base64, auth.id],
    );
    const insertId = (result as unknown as { insertId: number }).insertId;

    await insertAuditLog({
      action: 'employee_document_uploaded',
      entity: 'employee',
      entity_id: employeeId,
      performed_by: auth.id,
      details: { document_id: insertId, doc_type, title, file_name, size_bytes: sizeBytes },
      ip_address: request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
    });

    const document = await queryOne<EmployeeDocument>(
      `SELECT id, employee_id, doc_type, title, file_name, mime_type, size_bytes, uploaded_by, created_at
       FROM employee_documents WHERE id = ?`,
      [insertId],
    );
    return NextResponse.json<ApiResponse<{ document: EmployeeDocument }>>(
      { success: true, data: { document: document! } },
      { status: 201 },
    );
  } catch (error) {
    if ((error as { code?: string })?.code === 'ER_NO_SUCH_TABLE') return missingTableResponse();
    throw error;
  }
}

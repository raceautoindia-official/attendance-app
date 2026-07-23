import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { canAccessEmployee } from '@/lib/employeeDetails';
import type { ApiResponse } from '@/lib/types';

type Params = { params: Promise<{ id: string; docId: string }> };

async function resolveIds(context: Params): Promise<{ employeeId: number; docId: number } | null> {
  const { id, docId } = await context.params;
  const employeeId = parseInt(id, 10);
  const documentId = parseInt(docId, 10);
  if (isNaN(employeeId) || isNaN(documentId)) return null;
  return { employeeId, docId: documentId };
}

// ---------------------------------------------------------------------------
// GET /api/employees/[id]/documents/[docId] — stream the file itself
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest, context: Params) {
  const auth = await requireAuth(request, ['employee', 'manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const ids = await resolveIds(context);
  if (!ids) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid ID' }, { status: 400 });
  }
  if (!(await canAccessEmployee(auth, ids.employeeId))) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Access denied' }, { status: 403 });
  }

  const doc = await queryOne<{ file_name: string; mime_type: string; file_data: string }>(
    `SELECT file_name, mime_type, file_data
     FROM employee_documents
     WHERE id = ? AND employee_id = ?`,
    [ids.docId, ids.employeeId],
  );
  if (!doc) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Document not found' }, { status: 404 });
  }

  const bytes = new Uint8Array(Buffer.from(doc.file_data, 'base64'));
  // "inline" lets the browser preview PDFs/images in a tab; the filename is
  // still used when the user chooses to save. Quotes stripped to keep the
  // header well-formed.
  const safeName = doc.file_name.replace(/["\\\r\n]/g, '_');
  return new NextResponse(bytes, {
    headers: {
      'Content-Type': doc.mime_type,
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': `inline; filename="${safeName}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}

// ---------------------------------------------------------------------------
// DELETE /api/employees/[id]/documents/[docId] — super admin only
// ---------------------------------------------------------------------------

export async function DELETE(request: NextRequest, context: Params) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  const ids = await resolveIds(context);
  if (!ids) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid ID' }, { status: 400 });
  }

  const doc = await queryOne<{ id: number; doc_type: string; title: string; file_name: string }>(
    'SELECT id, doc_type, title, file_name FROM employee_documents WHERE id = ? AND employee_id = ?',
    [ids.docId, ids.employeeId],
  );
  if (!doc) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Document not found' }, { status: 404 });
  }

  await query('DELETE FROM employee_documents WHERE id = ?', [ids.docId]);

  await insertAuditLog({
    action: 'employee_document_deleted',
    entity: 'employee',
    entity_id: ids.employeeId,
    performed_by: auth.id,
    details: { document_id: ids.docId, doc_type: doc.doc_type, title: doc.title, file_name: doc.file_name },
    ip_address: request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
  });

  return NextResponse.json<ApiResponse>({ success: true, message: 'Document deleted' });
}

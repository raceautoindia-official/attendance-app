import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { canAccessEmployee } from '@/lib/employeeDetails';
import { deleteObject, isS3Configured, presignDownload } from '@/lib/documentStorage';
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

  const doc = await queryOne<{
    file_name: string; mime_type: string; file_data: string | null;
    storage: 'db' | 's3' | null; s3_key: string | null;
  }>(
    `SELECT file_name, mime_type, file_data, storage, s3_key
     FROM employee_documents
     WHERE id = ? AND employee_id = ?`,
    [ids.docId, ids.employeeId],
  );
  if (!doc) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Document not found' }, { status: 404 });
  }

  // S3-stored: hand back a short-lived signed link rather than streaming the
  // bytes through this server. The bucket is private and no durable object URL
  // is ever disclosed — these are identity documents, and a link that works
  // forever is a leak with a delay on it.
  if (doc.storage === 's3' && doc.s3_key) {
    if (!isS3Configured()) {
      return NextResponse.json<ApiResponse>(
        {
          success: false,
          error: 'This document is stored in S3, but no bucket is configured on this server.',
        },
        { status: 503 },
      );
    }
    const url = await presignDownload(doc.s3_key, doc.file_name);
    // 302 so an <a href> or window.open works unchanged, exactly as it did when
    // this route returned the bytes directly.
    return NextResponse.redirect(url, {
      status: 302,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }

  if (!doc.file_data) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'This document has no stored content.' }, { status: 404 },
    );
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

  const doc = await queryOne<{
    id: number; doc_type: string; title: string; file_name: string;
    storage: 'db' | 's3' | null; s3_key: string | null;
  }>(
    'SELECT id, doc_type, title, file_name, storage, s3_key FROM employee_documents WHERE id = ? AND employee_id = ?',
    [ids.docId, ids.employeeId],
  );
  if (!doc) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Document not found' }, { status: 404 });
  }

  // Remove the row first, then the object.
  //
  // This order is deliberate. If the row goes and the object delete fails, the
  // result is an orphaned object in the bucket — invisible, cheap, and sweepable.
  // The other order risks deleting the file while the row survives, leaving a
  // document that is listed, looks filed, and cannot be opened. An orphan costs
  // storage; a dangling row costs someone their proof of identity.
  await query('DELETE FROM employee_documents WHERE id = ?', [ids.docId]);

  let objectRemoved: boolean | null = null;
  if (doc.storage === 's3' && doc.s3_key && isS3Configured()) {
    try {
      await deleteObject(doc.s3_key);
      objectRemoved = true;
    } catch (err) {
      // Never fail the request for this: the document IS deleted as far as the
      // app is concerned. Log it so the orphan can be swept up.
      objectRemoved = false;
      console.error('[documents] row deleted but S3 object remains:', doc.s3_key, err);
    }
  }

  await insertAuditLog({
    action: 'employee_document_deleted',
    entity: 'employee',
    entity_id: ids.employeeId,
    performed_by: auth.id,
    details: {
      document_id: ids.docId, doc_type: doc.doc_type, title: doc.title,
      file_name: doc.file_name, storage: doc.storage ?? 'db',
      s3_object_removed: objectRemoved,
    },
    ip_address: request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
  });

  return NextResponse.json<ApiResponse>({ success: true, message: 'Document deleted' });
}

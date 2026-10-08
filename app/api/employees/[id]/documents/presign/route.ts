import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth';
import { canAccessEmployee, DOCUMENT_TYPES, DOCUMENT_MIME_TYPES } from '@/lib/employeeDetails';
import {
  buildKey, isS3Configured, presignUpload, storageStatus,
  MAX_S3_BYTES, UPLOAD_URL_TTL_SECONDS,
} from '@/lib/documentStorage';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// POST /api/employees/[id]/documents/presign
//
// Step one of a direct-to-S3 upload: the browser asks for somewhere to put the
// file, PUTs it there, then calls POST /documents with the returned key to file
// it. The bytes never pass through this server, so nginx's 5 MB body limit —
// the reason the old cap was 3 MB — stops applying.
//
// GET returns the current storage setup, so the UI can tell the user which
// path is in force and what the real size limit is rather than guessing.
// ---------------------------------------------------------------------------

type Params = { params: Promise<{ id: string }> };

const PresignSchema = z.object({
  doc_type: z.enum(DOCUMENT_TYPES),
  file_name: z.string().min(1).max(255),
  mime_type: z.string().refine(m => DOCUMENT_MIME_TYPES.includes(m), 'Unsupported file type'),
  size_bytes: z.number().int().positive().max(MAX_S3_BYTES),
});

async function resolveId(context: Params): Promise<number | null> {
  const id = parseInt((await context.params).id, 10);
  return Number.isNaN(id) ? null : id;
}

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

  return NextResponse.json<ApiResponse<ReturnType<typeof storageStatus>>>({
    success: true,
    data: storageStatus(),
  });
}

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

  if (!isS3Configured()) {
    // Not an error: the caller should fall back to the database upload, which
    // still works. Saying so plainly beats a 500 that looks like a fault.
    return NextResponse.json<ApiResponse>(
      {
        success: false,
        error: 'No S3 bucket is configured, so uploads go to the database instead. '
          + 'Set S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY to enable direct upload.',
      },
      { status: 503 },
    );
  }

  let body: unknown;
  try { body = await request.json(); }
  catch {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = PresignSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' },
      { status: 400 },
    );
  }

  const { doc_type, file_name, mime_type, size_bytes } = parsed.data;
  const key = buildKey(employeeId, doc_type, file_name);
  const upload_url = await presignUpload({ key, contentType: mime_type, contentLength: size_bytes });

  return NextResponse.json<ApiResponse<{
    upload_url: string; key: string; expires_in: number; max_bytes: number;
  }>>({
    success: true,
    data: { upload_url, key, expires_in: UPLOAD_URL_TTL_SECONDS, max_bytes: MAX_S3_BYTES },
  });
}

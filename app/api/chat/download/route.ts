import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { insertAuditLog } from '@/lib/db';
import { buildReportFile, verifyDownloadToken } from '@/lib/chat/export';
import { ChatForbiddenError, type ChatContext } from '@/lib/chat/types';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// GET /api/chat/download?t=<token> — super_admin only
//
// Serves a report file the assistant offered. Three independent checks must all
// pass: a valid session, the super_admin role, and a signed token whose subject
// matches the signed-in user. A leaked link is therefore useless to anyone else
// — it still requires their own authenticated session, and the subject check
// stops one admin replaying another's link.
//
// The file is generated on demand from the same tool functions the chat used,
// so it cannot drift from what the assistant reported.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  const token = request.nextUrl.searchParams.get('t');
  if (!token) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Missing download token' },
      { status: 400 },
    );
  }

  const claims = verifyDownloadToken(token);
  if (!claims) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'This download link is invalid or has expired. Ask for the report again.' },
      { status: 400 },
    );
  }

  // The link belongs to one person. Another admin cannot replay it.
  if (claims.sub !== auth.id) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'This download link was not issued to you.' },
      { status: 403 },
    );
  }

  const ctx: ChatContext = { employeeId: auth.id, role: auth.role };

  try {
    const file = await buildReportFile(ctx, claims);

    await insertAuditLog({
      action: 'chat_report_download',
      entity: 'chat',
      performed_by: auth.id,
      ip_address:
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        request.headers.get('x-real-ip') ??
        null,
      details: {
        report: claims.report,
        format: claims.format,
        params: claims.params,
        rows: file.rows,
      },
    });

    return new NextResponse(new Uint8Array(file.body), {
      status: 200,
      headers: {
        'Content-Type': file.contentType,
        'Content-Disposition': `attachment; filename="${file.filename}"`,
        'Content-Length': String(file.body.length),
        // Report data must never sit in a shared cache.
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    if (err instanceof ChatForbiddenError) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: err.message },
        { status: 403 },
      );
    }
    console.error('[chat] report download failed:', err);
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Could not build that report.' },
      { status: 500 },
    );
  }
}

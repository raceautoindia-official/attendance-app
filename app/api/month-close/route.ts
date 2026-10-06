import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth';
import {
  closeMonth, getClosure, listClosures, reopenMonth,
  type CloseResult, type MonthClosure,
} from '@/lib/monthClose';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// /api/month-close — closing a month, and lifting it again.
//
//   GET                      every closure on record
//   GET ?month=2026-09       one month's state
//   POST   { month, … }      close it
//   DELETE { month, reason } reopen it
//
// super_admin only. Closing decides whether a month's figures can still change,
// which is a different kind of authority from editing one row, and a manager
// who can edit their own team's attendance should not be able to freeze
// everybody's.
// ---------------------------------------------------------------------------

const CloseSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, 'month must be YYYY-MM'),
  closed_through: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

const ReopenSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, 'month must be YYYY-MM'),
  reason: z.string().min(5, 'Give a reason for reopening — it goes on the record.').max(500),
});

function ipOf(request: NextRequest): string | null {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? request.headers.get('x-real-ip')
    ?? null;
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const month = new URL(request.url).searchParams.get('month');
  if (month) {
    const closure = await getClosure(month);
    return NextResponse.json<ApiResponse<{ closure: MonthClosure | null }>>({ success: true, data: { closure } });
  }
  return NextResponse.json<ApiResponse<{ closures: MonthClosure[] }>>({
    success: true,
    data: { closures: await listClosures() },
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await request.json(); }
  catch {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = CloseSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' },
      { status: 400 },
    );
  }

  try {
    const result = await closeMonth({
      month: parsed.data.month,
      closedBy: auth.id,
      closedThrough: parsed.data.closed_through ?? undefined,
      notes: parsed.data.notes ?? null,
      ip: ipOf(request),
    });
    return NextResponse.json<ApiResponse<CloseResult>>({ success: true, data: result });
  } catch (err) {
    // These are all "you asked for something that does not make sense yet"
    // rather than failures — a 400 with the reason is more use than a 500.
    return NextResponse.json<ApiResponse>(
      { success: false, error: (err as Error).message },
      { status: 400 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await request.json(); }
  catch {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = ReopenSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' },
      { status: 400 },
    );
  }

  try {
    const closure = await reopenMonth({
      month: parsed.data.month,
      reopenedBy: auth.id,
      reason: parsed.data.reason,
      ip: ipOf(request),
    });
    return NextResponse.json<ApiResponse<{ closure: MonthClosure }>>({ success: true, data: { closure } });
  } catch (err) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: (err as Error).message },
      { status: 400 },
    );
  }
}

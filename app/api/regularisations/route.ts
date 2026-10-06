import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth';
import { createRequest, listRequests, type RegStatus } from '@/lib/regularisation';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// /api/regularisations
//
//   GET  ?status=pending            the queue
//   POST { work_date, reason, … }   raise one
//
// Any signed-in employee may raise a request about THEIR OWN day. Only a
// manager or administrator may raise one for somebody else, or see anybody
// else's — a request is a statement about a person's attendance, and the rest
// of the app does not let one employee read another's.
// ---------------------------------------------------------------------------

const CreateSchema = z.object({
  employee_id: z.number().int().positive().optional(),
  work_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'work_date must be YYYY-MM-DD'),
  requested_clock_in: z.string().datetime({ offset: true }).nullable().optional(),
  requested_clock_out: z.string().datetime({ offset: true }).nullable().optional(),
  reason: z.string().min(5, 'Say what happened.').max(500),
});

const STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'all'] as const;

function ipOf(request: NextRequest): string | null {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? request.headers.get('x-real-ip') ?? null;
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const sp = new URL(request.url).searchParams;
  const statusParam = sp.get('status') ?? 'pending';
  if (!STATUSES.includes(statusParam as (typeof STATUSES)[number])) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: `status must be one of: ${STATUSES.join(', ')}` },
      { status: 400 },
    );
  }
  const status = statusParam as RegStatus | 'all';

  // An employee sees only their own, whatever they ask for.
  const isReviewer = auth.role === 'manager' || auth.role === 'super_admin';
  const requested = Number(sp.get('employee_id'));
  const employeeId = isReviewer
    ? (Number.isInteger(requested) && requested > 0 ? requested : undefined)
    : auth.id;

  const requests = await listRequests({
    status,
    employeeId,
    managerId: auth.role === 'manager' ? auth.id : null,
  });

  return NextResponse.json<ApiResponse<{ requests: typeof requests }>>({
    success: true,
    data: { requests },
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await request.json(); }
  catch {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' },
      { status: 400 },
    );
  }

  const isReviewer = auth.role === 'manager' || auth.role === 'super_admin';
  const target = parsed.data.employee_id ?? auth.id;
  if (target !== auth.id && !isReviewer) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'You can only raise a request about your own attendance.' },
      { status: 403 },
    );
  }

  try {
    const created = await createRequest({
      employeeId: target,
      workDate: parsed.data.work_date,
      requestedClockIn: parsed.data.requested_clock_in ?? null,
      requestedClockOut: parsed.data.requested_clock_out ?? null,
      reason: parsed.data.reason,
      requestedBy: auth.id,
      ip: ipOf(request),
    });
    return NextResponse.json<ApiResponse<{ request: typeof created }>>(
      { success: true, data: { request: created } },
      { status: 201 },
    );
  } catch (err) {
    // A closed month is a conflict with the state of the world, not a bad
    // request — the caller did nothing wrong and may retry after a reopen.
    const message = (err as Error).message;
    const status = /closed on/i.test(message) ? 409 : 400;
    return NextResponse.json<ApiResponse>({ success: false, error: message }, { status });
  }
}

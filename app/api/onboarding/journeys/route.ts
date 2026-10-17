import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { zBool } from '@/lib/zodFields';
import { requireAuth } from '@/lib/auth';
import {
  listJourneys, startJourney, completeJourney, cancelJourney,
  attentionQueue, listTemplates, OnboardingError,
} from '@/lib/onboarding';
import type { ApiResponse } from '@/lib/types';

const StartSchema = z.object({
  action: z.literal('start'),
  employee_id: z.number().int().positive(),
  direction: z.enum(['onboarding', 'offboarding']),
  anchor_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'The date must be YYYY-MM-DD'),
  template_id: z.number().int().positive().nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

const CloseSchema = z.object({
  action: z.enum(['complete', 'cancel']),
  journey_id: z.number().int().positive(),
  // Only honoured on 'complete', and only when a blocking task is still open.
  // The library records the override and what it skipped.
  force: zBool.optional(),
});

const BodySchema = z.union([StartSchema, CloseSchema]);

function ipOf(request: NextRequest): string | null {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? request.headers.get('x-real-ip') ?? null;
}

/**
 * GET
 *
 * `mine=1` returns only the caller's own checklist and is open to any signed-in
 * employee. A checklist only HR can see is a checklist HR chases by email, so
 * the person it is about can read their own — and nothing else.
 */
export async function GET(request: NextRequest) {
  const sp = new URL(request.url).searchParams;
  const mine = sp.get('mine') === '1';

  const auth = await requireAuth(request, mine
    ? ['employee', 'manager', 'super_admin']
    : ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  if (mine) {
    const journeys = await listJourneys({ employeeId: auth.id });
    return NextResponse.json<ApiResponse<{ journeys: typeof journeys }>>({
      success: true, data: { journeys },
    });
  }

  const direction = sp.get('direction');
  const status = sp.get('status');
  const journeys = await listJourneys({
    direction: direction === 'onboarding' || direction === 'offboarding' ? direction : undefined,
    status: status === 'in_progress' || status === 'completed' || status === 'cancelled'
      ? status : undefined,
  });

  // The queue and the templates travel with the list. The board cannot be
  // drawn without all three, and three requests would let them render out of
  // step for a frame.
  const [queue, templates] = await Promise.all([
    sp.get('with_queue') === '1' ? attentionQueue() : Promise.resolve(null),
    sp.get('with_templates') === '1' ? listTemplates() : Promise.resolve([]),
  ]);

  return NextResponse.json<ApiResponse<{
    journeys: typeof journeys;
    queue: Awaited<ReturnType<typeof attentionQueue>> | null;
    templates: Awaited<ReturnType<typeof listTemplates>>;
  }>>({ success: true, data: { journeys, queue, templates } });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 }); }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return NextResponse.json<ApiResponse>(
      { success: false, error: `${String(i?.path.join('.') || 'Request')}: ${i?.message}` },
      { status: 400 });
  }

  try {
    if (parsed.data.action === 'start') {
      const d = parsed.data;
      const id = await startJourney({
        employeeId: d.employee_id, direction: d.direction, anchorDate: d.anchor_date,
        templateId: d.template_id ?? null, notes: d.notes ?? null,
        by: auth.id, ip: ipOf(request),
      });
      return NextResponse.json<ApiResponse<{ id: number }>>({ success: true, data: { id } }, { status: 201 });
    }

    if (parsed.data.action === 'complete') {
      await completeJourney({
        journeyId: parsed.data.journey_id, by: auth.id,
        force: parsed.data.force === true, ip: ipOf(request),
      });
    } else {
      await cancelJourney(parsed.data.journey_id, auth.id, ipOf(request));
    }
    return NextResponse.json<ApiResponse>({ success: true });
  } catch (err) {
    // An OnboardingError names something the user can fix — an open blocking
    // task, a duplicate checklist. Anything else is a bug and says nothing.
    if (err instanceof OnboardingError) {
      return NextResponse.json<ApiResponse>({ success: false, error: err.message }, { status: 400 });
    }
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Could not update the checklist.' }, { status: 400 });
  }
}

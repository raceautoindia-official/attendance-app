import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth';
import { editHoliday, removeHoliday, HolidayError } from '@/lib/holidays';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// /api/holidays/[id] — correcting and removing a date on the calendar.
//
//   PATCH   { date?, name?, type?, state_code?, notes? }
//   DELETE  (nothing)
//
// super_admin only, like the rest of the calendar: a holiday takes a day out of
// everybody's required hours, so who may touch it is deliberately narrower than
// leave.
//
// WHY THIS ROUTE EXISTS AT ALL
// ----------------------------
// It did not, and the calendar was append-only. A holiday typed with the wrong
// date or name could not be corrected or removed through the app by anybody —
// the list simply kept it. The guards about what may change, and when, live in
// lib/holidays.ts next to the observance logic they have to agree with.
// ---------------------------------------------------------------------------

const EditSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD').optional(),
  name: z.string().min(1, 'A name is required').max(150).optional(),
  type: z.enum(['national', 'regional', 'company']).optional(),
  state_code: z.string().max(5).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

type Params = { params: Promise<{ id: string }> };

function idFrom(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function failed(err: unknown, fallback: string): NextResponse {
  if (err instanceof HolidayError) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: err.message }, { status: err.status });
  }
  console.error('[holidays]', fallback, err);
  return NextResponse.json<ApiResponse>({ success: false, error: fallback }, { status: 500 });
}

export async function PATCH(request: NextRequest, context: Params) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  const id = idFrom((await context.params).id);
  if (id === null) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid ID' }, { status: 400 });
  }

  let body: unknown;
  try { body = await request.json(); }
  catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = EditSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json<ApiResponse>(
      { success: false, error: `${String(issue?.path.join('.') || 'Request')}: ${issue?.message}` },
      { status: 400 },
    );
  }

  try {
    await editHoliday({
      id,
      date: parsed.data.date,
      name: parsed.data.name,
      type: parsed.data.type,
      stateCode: parsed.data.state_code,
      notes: parsed.data.notes,
      actorId: auth.id,
    });
    return NextResponse.json<ApiResponse>({ success: true, message: 'Holiday updated.' });
  } catch (err) {
    return failed(err, 'Could not update the holiday.');
  }
}

export async function DELETE(request: NextRequest, context: Params) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  const id = idFrom((await context.params).id);
  if (id === null) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid ID' }, { status: 400 });
  }

  try {
    const gone = await removeHoliday({ id, actorId: auth.id });
    // A row from a dataset will be offered again the next time that year is
    // imported. Said here so a reappearing date is not read as a failed delete.
    const willReturn = gone.source !== 'manual';
    return NextResponse.json<ApiResponse>({
      success: true,
      message: willReturn
        ? `Removed "${gone.name}". It came from a dataset, so importing ${gone.date.slice(0, 4)} again will offer it back.`
        : `Removed "${gone.name}".`,
    });
  } catch (err) {
    return failed(err, 'Could not remove the holiday.');
  }
}

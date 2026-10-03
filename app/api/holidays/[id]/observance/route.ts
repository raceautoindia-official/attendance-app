import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth';
import { setObservance, HolidayError, type ObservanceChange } from '@/lib/holidays';
import type { ApiResponse } from '@/lib/types';

const ObservanceSchema = z.object({
  /** null = all locations, including employees with no location assigned. */
  location_id: z.number().int().positive().nullable(),
  is_observed: z.boolean(),
  /**
   * Required to observe a holiday flagged `needs_verification`: the bundled date
   * for a lunar festival is only a placeholder.
   */
  confirmed_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'confirmed_date must be YYYY-MM-DD')
    .optional(),
});

// ---------------------------------------------------------------------------
// PUT /api/holidays/[id]/observance — super_admin only.
//
// THIS is the endpoint that makes a holiday real: it writes a leave_records row
// and flips attendance for the employees in scope. Everything else in the
// holiday calendar is inert.
// ---------------------------------------------------------------------------

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  // Next 16: route params are async.
  const { id } = await context.params;
  const holidayId = Number.parseInt(id, 10);
  if (!Number.isInteger(holidayId) || holidayId <= 0) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Invalid holiday id' },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const parsed = ObservanceSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' },
      { status: 400 },
    );
  }

  try {
    const change = await setObservance({
      holidayId,
      locationId: parsed.data.location_id,
      isObserved: parsed.data.is_observed,
      confirmedDate: parsed.data.confirmed_date,
      actorId: auth.id,
      ip:
        request.headers.get('x-real-ip') ??
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        null,
    });

    const where = change.location_id === null ? 'all locations' : 'that location';
    return NextResponse.json<ApiResponse<ObservanceChange>>({
      success: true,
      data: change,
      message: change.is_observed
        ? `${change.holiday_name} is now a holiday on ${change.holiday_date} for ${where} (${change.employees_in_scope} employee(s) in scope, ${change.attendance_rows_changed} attendance record(s) updated).`
        : `${change.holiday_name} is no longer a holiday for ${where}. ${change.attendance_rows_changed} attendance record(s) reverted.`,
    });
  } catch (err) {
    if (err instanceof HolidayError) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: err.message },
        { status: err.status },
      );
    }
    console.error('[holidays] observance failed:', err);
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Could not update that holiday.' },
      { status: 500 },
    );
  }
}

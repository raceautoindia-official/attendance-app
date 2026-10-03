import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth';
import { query } from '@/lib/db';
import {
  listHolidays,
  addManualHoliday,
  availableBundledYears,
  HolidayError,
  type HolidayWithObservances,
} from '@/lib/holidays';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// Holiday calendar — super_admin only.
//
// A holiday rewrites attendance for everyone in scope, which feeds payroll, so
// this is deliberately narrower than /api/leaves (which also allows manager).
// Reading the calendar changes nothing; observing a holiday is what applies it,
// and that lives in [id]/observance.
// ---------------------------------------------------------------------------

interface LocationOption {
  id: number;
  name: string;
  state_code: string | null;
}

interface HolidayListData {
  year: number;
  holidays: HolidayWithObservances[];
  locations: LocationOption[];
  available_years: number[];
}

// GET /api/holidays?year=YYYY
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  const raw = request.nextUrl.searchParams.get('year');
  const parsedYear = raw ? parseInt(raw, 10) : NaN;
  const year =
    Number.isInteger(parsedYear) && parsedYear >= 2000 && parsedYear <= 2100
      ? parsedYear
      : new Date().getUTCFullYear();

  try {
    const [holidays, locations, availableYears] = await Promise.all([
      listHolidays(year),
      query<LocationOption>(
        `SELECT id, name, state_code FROM locations
          WHERE is_active = TRUE ORDER BY name ASC`,
      ),
      availableBundledYears(),
    ]);

    return NextResponse.json<ApiResponse<HolidayListData>>({
      success: true,
      data: { year, holidays, locations, available_years: availableYears },
    });
  } catch (err) {
    console.error('[holidays] list failed:', err);
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Could not load the holiday calendar.' },
      { status: 500 },
    );
  }
}

const CreateSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  name: z.string().min(1, 'A name is required').max(150),
  type: z.enum(['national', 'regional', 'company']).optional(),
  state_code: z.string().max(5).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

// POST /api/holidays — add a holiday the bundled list does not carry.
// Adds a CANDIDATE only; it still has to be observed to take effect.
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' },
      { status: 400 },
    );
  }

  try {
    const id = await addManualHoliday({
      date: parsed.data.date,
      name: parsed.data.name,
      type: parsed.data.type,
      stateCode: parsed.data.state_code ?? null,
      notes: parsed.data.notes ?? null,
      actorId: auth.id,
    });

    return NextResponse.json<ApiResponse<{ id: number }>>(
      {
        success: true,
        data: { id },
        message:
          'Holiday added to the calendar. It does not affect attendance until you observe it for a location.',
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof HolidayError) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: err.message },
        { status: err.status },
      );
    }
    console.error('[holidays] create failed:', err);
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Could not add that holiday.' },
      { status: 500 },
    );
  }
}

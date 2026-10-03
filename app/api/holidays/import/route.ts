import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth';
import { insertAuditLog } from '@/lib/db';
import { importBundledYear, type ImportResult } from '@/lib/holidays';
import type { ApiResponse } from '@/lib/types';

const ImportSchema = z.object({
  year: z.number().int().min(2000).max(2100),
});

// ---------------------------------------------------------------------------
// POST /api/holidays/import — load data/holidays/IN-<year>.json as CANDIDATES.
//
// Deliberately harmless: this writes to holiday_calendar only. No attendance
// row and no leave_records row is touched, and nothing is observed. Idempotent,
// and it never overwrites a date an admin has already corrected.
// ---------------------------------------------------------------------------

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

  const parsed = ImportSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' },
      { status: 400 },
    );
  }

  try {
    const result = await importBundledYear(parsed.data.year);

    if (result.found === 0 && result.errors.length > 0) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: result.errors[0] },
        { status: 404 },
      );
    }

    await insertAuditLog({
      action: 'holiday_calendar_imported',
      entity: 'holiday',
      performed_by: auth.id,
      ip_address:
        request.headers.get('x-real-ip') ??
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        null,
      details: {
        year: result.year,
        found: result.found,
        inserted: result.inserted,
        skipped: result.skipped,
      },
    });

    return NextResponse.json<ApiResponse<ImportResult>>({
      success: true,
      data: result,
      message:
        result.inserted > 0 || result.refreshed > 0 || result.pruned > 0
          ? `${result.year} calendar updated: ${result.inserted} added, ${result.refreshed} refreshed, ${result.pruned} stale entry(ies) removed. Nothing affects attendance until you observe it.`
          : `The ${result.year} calendar was already up to date.`,
    });
  } catch (err) {
    console.error('[holidays] import failed:', err);
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Could not import that year.' },
      { status: 500 },
    );
  }
}

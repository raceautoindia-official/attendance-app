import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth';
import {
  listCountries, listRegions, listTrackedCountries,
  trackCountry, untrackCountry, importCountryYear,
} from '@/lib/holidayCatalog';
import type { ApiResponse } from '@/lib/types';

const BodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('track'),
    country_code: z.string().length(2),
    region_code: z.string().max(10).nullable().optional(),
  }),
  z.object({ action: z.literal('untrack'), id: z.number().int().positive() }),
  z.object({
    action: z.literal('import'),
    country_code: z.string().length(2),
    region_code: z.string().max(10).nullable().optional(),
    // Bounded because the library will happily compute the year 50000 and
    // spend a while doing it.
    year: z.number().int().min(2000).max(2100),
  }),
]);

function ipOf(request: NextRequest): string | null {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? request.headers.get('x-real-ip') ?? null;
}

/**
 * GET
 *
 * `countries=1` returns all 207. That list is static and a little over 4 KB,
 * so it is fetched once by the picker rather than searched server-side —
 * round-tripping every keystroke to filter a fixed list would be slower and
 * no more correct.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const sp = new URL(request.url).searchParams;
  const country = sp.get('country');

  return NextResponse.json<ApiResponse<{
    countries: ReturnType<typeof listCountries>;
    regions: ReturnType<typeof listRegions>;
    tracked: Awaited<ReturnType<typeof listTrackedCountries>>;
  }>>({
    success: true,
    data: {
      countries: sp.get('countries') === '1' ? listCountries() : [],
      regions: country && country.length === 2 ? listRegions(country) : [],
      tracked: await listTrackedCountries(),
    },
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['super_admin']);
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
    if (parsed.data.action === 'track') {
      await trackCountry({
        countryCode: parsed.data.country_code,
        regionCode: parsed.data.region_code ?? null,
        by: auth.id,
      });
      return NextResponse.json<ApiResponse>({ success: true });
    }

    if (parsed.data.action === 'untrack') {
      await untrackCountry(parsed.data.id);
      return NextResponse.json<ApiResponse>({ success: true });
    }

    // Imports as CANDIDATES. Nothing here changes a working day, required
    // hours or anybody's attendance until the holiday is marked observed, so
    // importing a country speculatively is safe and reversible.
    const result = await importCountryYear({
      countryCode: parsed.data.country_code,
      regionCode: parsed.data.region_code ?? null,
      year: parsed.data.year,
      by: auth.id,
      ip: ipOf(request),
    });
    return NextResponse.json<ApiResponse<typeof result>>({ success: true, data: result });
  } catch (err) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: (err as Error).message || 'Could not update the catalogue.' },
      { status: 400 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { zBool } from '@/lib/zodFields';
import { requireAuth } from '@/lib/auth';
import {
  listCompanies, saveCompany, companyLocations, companyChain, chainGaps, OrgError,
} from '@/lib/org';
import type { ApiResponse } from '@/lib/types';

// A blank field from a form means 'not recorded', which is NULL - not the
// empty string. Without this every validated field below would have to
// special-case '' and the database would fill up with rows that are neither
// absent nor present.
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

/**
 * Statutory identifiers have fixed shapes, and getting one wrong is not
 * cosmetic: a PAN with a transposed digit goes on a filing and comes back
 * rejected months later. The forms can only ask nicely; this is the check
 * that also covers the mobile app and anything calling the API directly.
 *
 * Checked for SHAPE, not for existence - there is no offline way to know
 * whether a well-formed PAN was issued. Case is accepted either way because
 * people copy these out of documents; the shape is what matters.
 */
const statutory = (re: RegExp, example: string) =>
  z.preprocess(blankToNull, z.string().regex(re, `must look like ${example}`).nullable().optional());

/**
 * An IANA zone the runtime actually knows, e.g. Asia/Kolkata.
 *
 * 'IST' and 'GMT+5:30' are what a text box collects, and neither survives
 * contact with a date library. Validated by asking the runtime to use it,
 * which is the only answer that matters.
 */
const ianaTimezone = z.string().max(64).refine(
  z => {
    try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; }
    catch { return false; }
  },
  'must be an IANA timezone name, e.g. Asia/Kolkata',
);
// Several rows are expected, not one: group structures and subsidiaries are
// normal, which is why this is a table and not a settings blob.
const CompanySchema = z.object({
  id: z.number().int().positive().optional(),
  legal_name: z.string().min(1, 'A company needs its registered legal name.').max(200),
  trading_name: z.string().max(200).nullable().optional(),
  registration_no: z.string().max(60).nullable().optional(),
  pan: statutory(/^[A-Za-z]{5}\d{4}[A-Za-z]$/, 'ABCDE1234F'),
  tan: statutory(/^[A-Za-z]{4}\d{5}[A-Za-z]$/, 'CHEA12345B'),
  // 2-digit state code, the holder's PAN, an entity digit, a fixed Z, then a
  // check character.
  gstin: statutory(/^\d{2}[A-Za-z]{5}\d{4}[A-Za-z][A-Za-z\d]Z[A-Za-z\d]$/, '33ABCDE1234F1Z5'),
  pf_code: z.string().max(40).nullable().optional(),
  esi_code: z.string().max(40).nullable().optional(),
  address_line1: z.string().max(200).nullable().optional(),
  address_line2: z.string().max(200).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  state_code: z.string().max(10).nullable().optional(),
  // Two letters, and only letters: 'In', 'ind' and '91' all arrive from a
  // text box and none of them matches the holiday catalog's keys.
  country_code: z.string().regex(/^[A-Za-z]{2}$/, 'must be a two-letter country code, e.g. IN').optional(),
  postal_code: z.string().max(20).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  email: z.string().max(160).nullable().optional(),
  website: z.string().max(200).nullable().optional(),
  logo_url: z.string().max(500).nullable().optional(),
  // The work site that is the registered office. Null clears it.
  registered_location_id: z.number().int().positive().nullable().optional(),
  fy_start_month: z.number().int().min(1).max(12).optional(),
  timezone: ianaTimezone.optional(),
  is_active: zBool.optional(),
});

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;
  const includeInactive = new URL(request.url).searchParams.get('include_inactive') === '1';
  const companies = await listCompanies(includeInactive);
  // The sites come with them: the Company screen offers them as the registered
  // office rather than asking somebody to retype an address that is already on
  // record six times over.
  const locations = await companyLocations();
  // The chain, counted, and what is not attached to it. Every link existed in
  // the schema already and none of it was visible, so nobody could tell
  // whether the company, its sites, its departments and its people were
  // actually connected.
  const [chain, gaps] = await Promise.all([companyChain(), chainGaps()]);
  return NextResponse.json<ApiResponse<{
    companies: typeof companies; locations: typeof locations;
    chain: typeof chain; gaps: typeof gaps;
  }>>({ success: true, data: { companies, locations, chain, gaps } });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 }); }

  const parsed = CompanySchema.safeParse(body);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return NextResponse.json<ApiResponse>(
      { success: false, error: `${String(i?.path[0] ?? 'Field')}: ${i?.message}` }, { status: 400 },
    );
  }
  try {
    const company = await saveCompany(parsed.data, auth.id, request.headers.get('x-forwarded-for'));
    return NextResponse.json<ApiResponse<{ company: typeof company }>>(
      { success: true, data: { company } }, { status: parsed.data.id ? 200 : 201 },
    );
  } catch (err) {
    if (err instanceof OrgError) {
      return NextResponse.json<ApiResponse>({ success: false, error: err.message }, { status: 400 });
    }
    return NextResponse.json<ApiResponse>({ success: false, error: 'Could not save the company.' }, { status: 400 });
  }
}

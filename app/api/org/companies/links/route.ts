import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth';
import { resolveAccess, can } from '@/lib/access';
import {
  setCompanyLinks, companyLocations, departmentsForLinking, OrgError,
} from '@/lib/org';
import type { ApiResponse } from '@/lib/types';

/**
 * /api/org/companies/links — what belongs to a company.
 *
 *   GET ?company_id=     every site and department, flagged with who owns it
 *   POST                 attach and detach, in one call
 *
 * ITS OWN ROUTE, NOT PART OF SAVING A COMPANY
 * -------------------------------------------
 * Saving a company writes its own row. This writes OTHER tables - the sites
 * and the departments - which is a different act with a different audit entry,
 * and folding it into the company upsert would mean a form that quietly
 * reassigns a site because a field was left at its default.
 *
 * A list REPLACES the set. Anything listed is attached, anything attached and
 * not listed is detached, and passing nothing for one side leaves that side
 * alone - so sites and departments can be edited separately.
 */

const BodySchema = z.object({
  company_id: z.number().int().positive(),
  location_ids: z.array(z.number().int().positive()).max(500).optional(),
  department_ids: z.array(z.number().int().positive()).max(500).optional(),
});

function ipOf(request: NextRequest): string | null {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? request.headers.get('x-real-ip') ?? null;
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const ctx = await resolveAccess(auth.id);
  if (!can(ctx, 'org.manage')) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'You do not have permission to change the organisation (org.manage).' },
      { status: 403 },
    );
  }

  const [locations, departments] = await Promise.all([
    companyLocations(),
    departmentsForLinking(),
  ]);

  return NextResponse.json<ApiResponse<{
    locations: typeof locations; departments: typeof departments;
  }>>({ success: true, data: { locations, departments } });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const ctx = await resolveAccess(auth.id);
  if (!can(ctx, 'org.manage')) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'You do not have permission to change the organisation (org.manage).' },
      { status: 403 },
    );
  }

  let body: unknown;
  try { body = await request.json(); }
  catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return NextResponse.json<ApiResponse>(
      { success: false, error: `${String(i?.path.join('.') || 'Request')}: ${i?.message}` },
      { status: 400 },
    );
  }

  try {
    const counts = await setCompanyLinks({
      companyId: parsed.data.company_id,
      locationIds: parsed.data.location_ids,
      departmentIds: parsed.data.department_ids,
      by: auth.id,
      ip: ipOf(request),
    });
    return NextResponse.json<ApiResponse<typeof counts>>({ success: true, data: counts });
  } catch (err) {
    if (err instanceof OrgError) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: err.message }, { status: 400 });
    }
    console.error('[org] company links failed:', err);
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Could not change what belongs to this company.' },
      { status: 500 },
    );
  }
}

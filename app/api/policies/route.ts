import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth';
import { createPolicy, listPolicies, type Policy } from '@/lib/policy';
import type { ApiResponse } from '@/lib/types';
import { policyFieldLabel } from '@/lib/policyFields';

// ---------------------------------------------------------------------------
// /api/policies
//
//   GET  ?include_inactive=1   every policy
//   POST                       create one
//
// Reading is manager | super_admin — a manager needs to know what rules their
// team is held to. Creating is super_admin only: a policy decides how hours,
// leave and statutory deductions are treated for everybody assigned to it.
// ---------------------------------------------------------------------------

/**
 * A weight, which is NOT NULL in the schema with a default — so it may be
 * omitted, but never explicitly set to nothing. A policy that scores on no
 * weights at all cannot rank anybody.
 */
const weight = z.preprocess(
  v => (v === '' || v === null || v === undefined ? undefined : v),
  z.coerce.number().int().min(0).max(100),
).optional();

/** Optional, nullable number from a form that may send '' or null. */
const optNum = (min: number, max: number) =>
  z.preprocess(
    v => (v === '' || v === null || v === undefined ? null : v),
    z.coerce.number().min(min).max(max).nullable(),
  ).optional();

/**
 * Required text that may arrive as null.
 *
 * A form sends '' for a box nobody touched, but a client that normalises
 * blanks to null turns 'you left the name empty' into 'expected string,
 * received null' - a complaint about a type, for what is just an empty box.
 * Folding null back to '' lets the real rule below produce the real message.
 */
const requiredText = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(v => (v === null || v === undefined ? '' : v), schema);

export const PolicySchema = z.object({
  name: requiredText(z.string().min(1, 'A policy needs a name.').max(120)),
  code: requiredText(z.string().regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/,
    'The code must be 2–40 characters: letters, numbers, dot, dash or underscore.',
  )),
  description: z.string().max(500).nullable().optional(),
  is_active: z.boolean().optional(),

  hours_basis: z.enum(['roster', 'fixed_monthly']).optional(),
  monthly_hours: optNum(0, 744),          // 31 days x 24h is the absolute ceiling
  week_offs_per_month: optNum(0, 31),
  default_shift_id: optNum(1, 2_147_483_647),

  // min_hours_full_day / min_hours_half_day are NOT accepted: there is no
  // half-day flow in this business, and the app implements no such concept.
  // The columns exist in the schema, dormant, so introducing one later needs
  // no migration.
  late_grace_minutes: optNum(0, 240),
  overtime_after_minutes: optNum(0, 1440),
  overtime_multiplier: optNum(0, 10),

  casual_leave_days: optNum(0, 365),
  sick_leave_days: optNum(0, 365),
  earned_leave_days: optNum(0, 365),
  carry_forward_days: optNum(0, 365),
  permission_hours_per_month: optNum(0, 100),

  pf_applicable: z.boolean().optional(),
  esi_applicable: z.boolean().optional(),
  professional_tax_applicable: z.boolean().optional(),
  income_tax_tds_applicable: z.boolean().optional(),
  gratuity_applicable: z.boolean().optional(),
  lwf_applicable: z.boolean().optional(),
  bonus_applicable: z.boolean().optional(),

  probation_months: optNum(0, 60),
  notice_period_days: optNum(0, 365),

  score_weight_attendance: weight,
  score_weight_punctuality: weight,
  score_weight_hours: weight,
});

function ipOf(request: NextRequest): string | null {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? request.headers.get('x-real-ip') ?? null;
}

/**
 * Turn a Zod failure into something an administrator can act on.
 *
 * Zod names the field in `path` and the fault in `message`, and reporting the
 * message alone loses the half that matters: "expected string, received null"
 * does not say which of twenty-odd boxes it means. Every issue is reported,
 * not just the first, so filling one blank does not simply reveal the next.
 */
function describeIssues(error: z.ZodError): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const issue of error.issues) {
    const label = policyFieldLabel(issue.path[0]);
    if (seen.has(label)) continue;
    seen.add(label);
    parts.push(`${label}: ${issue.message}`);
  }
  return parts.length ? parts.join(' · ') : 'Invalid request';
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const includeInactive = new URL(request.url).searchParams.get('include_inactive') === '1';
  const policies = await listPolicies(includeInactive);
  return NextResponse.json<ApiResponse<{ policies: Policy[] }>>({
    success: true, data: { policies },
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

  const parsed = PolicySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: describeIssues(parsed.error) },
      { status: 400 },
    );
  }

  try {
    const policy = await createPolicy(parsed.data, auth.id, ipOf(request));
    return NextResponse.json<ApiResponse<{ policy: Policy }>>(
      { success: true, data: { policy } }, { status: 201 },
    );
  } catch (err) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: (err as Error).message }, { status: 400 },
    );
  }
}

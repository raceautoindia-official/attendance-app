import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth';
import { syncPolicyDefaultShift, previewPolicyShiftMoves, resolvePolicyFor } from '@/lib/policy';
import { policyFieldLabel } from '@/lib/policyFields';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// Put employees onto the shift their CURRENT policy names.
//
// Separate from assignment on purpose. Assigning a policy somebody already
// holds is refused, so once a mismatch is noticed after the fact there was no
// route to fixing it — which is the ordinary case, since the disagreement
// usually surfaces on the Working Hours page days later.
// ---------------------------------------------------------------------------

const SyncSchema = z.object({
  employee_ids: z.array(z.number().int().positive()).min(1, 'Choose at least one employee.').max(500),
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'effective_from must be YYYY-MM-DD'),
});

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

function ipOf(request: NextRequest): string | null {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? request.headers.get('x-real-ip') ?? null;
}

/** Who is on a policy whose default shift disagrees with their schedule. */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const sp = new URL(request.url).searchParams;
  const effectiveFrom = sp.get('effective_from') ?? new Date().toISOString().slice(0, 10);
  const ids = (sp.get('employee_ids') ?? '')
    .split(',').map(v => Number(v.trim())).filter(v => Number.isInteger(v) && v > 0);

  if (ids.length === 0) {
    return NextResponse.json<ApiResponse<{ mismatches: unknown[] }>>({
      success: true, data: { mismatches: [] },
    });
  }

  // Grouped by policy, because previewPolicyShiftMoves answers for one policy
  // at a time and different employees may be on different ones.
  const byPolicy = new Map<number, number[]>();
  for (const id of ids) {
    const policy = await resolvePolicyFor(id, effectiveFrom);
    if (!policy?.default_shift_id) continue;
    const list = byPolicy.get(policy.id) ?? [];
    list.push(id);
    byPolicy.set(policy.id, list);
  }

  const mismatches = [];
  for (const [policyId, employeeIds] of byPolicy) {
    mismatches.push(...await previewPolicyShiftMoves({ employeeIds, policyId, effectiveFrom }));
  }

  return NextResponse.json<ApiResponse<{ mismatches: typeof mismatches }>>({
    success: true, data: { mismatches },
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

  const parsed = SyncSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: describeIssues(parsed.error) },
      { status: 400 },
    );
  }

  const results = await syncPolicyDefaultShift({
    employeeIds: parsed.data.employee_ids,
    effectiveFrom: parsed.data.effective_from,
    by: auth.id,
    ip: ipOf(request),
  });

  return NextResponse.json<ApiResponse<{ results: typeof results; moved: number }>>({
    success: true,
    data: { results, moved: results.filter(r => r.moved).length },
  });
}

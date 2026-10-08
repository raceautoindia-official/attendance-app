import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth';
import {
  assignPolicy, endAssignment, listAssignments, previewPolicyShiftMoves,
  syncPolicyDefaultShift,
  type PolicyAssignment, type PolicyShiftMove,
} from '@/lib/policy';
import type { ApiResponse } from '@/lib/types';
import { policyFieldLabel } from '@/lib/policyFields';

// ---------------------------------------------------------------------------
// /api/policies/assign
//
//   GET    ?employee_id= | ?policy_id= | ?current_only=1   who is on what
//   POST   { employee_ids[], policy_id, effective_from }    assign, in bulk
//   DELETE { employee_id, effective_to }                    end an assignment
//
// super_admin only for the writes. Assigning a policy changes which rules a
// person's hours are judged by, which is the same weight of decision as
// creating the policy itself.
// ---------------------------------------------------------------------------

const AssignSchema = z.object({
  // Bulk by design: the brief is "assign to many employees", and doing that one
  // request at a time invites a half-finished rollout nobody notices.
  employee_ids: z.array(z.number().int().positive()).min(1, 'Choose at least one employee.').max(500),
  policy_id: z.number().int().positive(),
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'effective_from must be YYYY-MM-DD'),
  notes: z.string().max(500).nullable().optional(),
  /** Also move these employees onto the policy's default shift. */
  apply_default_shift: z.boolean().optional(),
});

const EndSchema = z.object({
  employee_id: z.number().int().positive(),
  effective_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'effective_to must be YYYY-MM-DD'),
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

  const sp = new URL(request.url).searchParams;
  const employeeId = Number(sp.get('employee_id'));
  const policyId = Number(sp.get('policy_id'));

  // Preview mode: say who a policy would move and off what, changing nothing.
  // A bulk assignment can touch hundreds of people, and 'which shift did this
  // put everyone on' is not a question to answer by trying it.
  if (sp.get('preview') === 'shift_moves') {
    const ids = (sp.get('employee_ids') ?? '')
      .split(',').map(v => Number(v.trim())).filter(v => Number.isInteger(v) && v > 0);
    const effectiveFrom = sp.get('effective_from') ?? '';
    if (!Number.isInteger(policyId) || policyId <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'preview needs policy_id and a valid effective_from.' },
        { status: 400 },
      );
    }
    const moves = await previewPolicyShiftMoves({
      employeeIds: ids, policyId, effectiveFrom,
    });
    return NextResponse.json<ApiResponse<{ shift_moves: PolicyShiftMove[] }>>({
      success: true, data: { shift_moves: moves },
    });
  }

  const assignments = await listAssignments({
    employeeId: Number.isInteger(employeeId) && employeeId > 0 ? employeeId : undefined,
    policyId: Number.isInteger(policyId) && policyId > 0 ? policyId : undefined,
    currentOnly: sp.get('current_only') === '1',
  });

  return NextResponse.json<ApiResponse<{ assignments: PolicyAssignment[] }>>({
    success: true, data: { assignments },
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

  const parsed = AssignSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: describeIssues(parsed.error) },
      { status: 400 },
    );
  }

  const { employee_ids, policy_id, effective_from, notes, apply_default_shift } = parsed.data;

  // Each employee is reported individually. A bulk assignment that fails
  // halfway and returns one error tells nobody which half went through, and
  // "already on this policy" is a perfectly ordinary outcome when somebody
  // re-runs an assignment over a group.
  const assigned: number[] = [];
  const skipped: Array<{ employee_id: number; reason: string }> = [];
  // Captured BEFORE assigning: afterwards they are already on the new shift,
  // so there is nothing left to report having moved them from.
  const moves = apply_default_shift
    ? await previewPolicyShiftMoves({
        employeeIds: employee_ids, policyId: policy_id, effectiveFrom: effective_from,
      })
    : [];

  for (const employeeId of employee_ids) {
    try {
      await assignPolicy({
        employeeId, policyId: policy_id, effectiveFrom: effective_from,
        notes: notes ?? null, by: auth.id, ip: ipOf(request),
        applyDefaultShift: apply_default_shift === true,
      });
      assigned.push(employeeId);
    } catch (err) {
      skipped.push({ employee_id: employeeId, reason: (err as Error).message });
    }
  }

  // Somebody already on this policy is skipped as a duplicate - correctly, but
  // it means the one person whose shift most needs fixing is the one the move
  // misses. They were selected and the box was ticked, so the shift is still
  // what was asked for; only the assignment was redundant.
  const synced: number[] = [];
  if (apply_default_shift) {
    const alreadyOnIt = skipped
      .filter(sk => /already on this policy/i.test(sk.reason))
      .map(sk => sk.employee_id);
    if (alreadyOnIt.length > 0) {
      const results = await syncPolicyDefaultShift({
        employeeIds: alreadyOnIt, effectiveFrom: effective_from,
        by: auth.id, ip: ipOf(request),
      });
      for (const r of results) if (r.moved) synced.push(r.employee_id);
    }
  }

  return NextResponse.json<ApiResponse<{
    assigned: number[];
    skipped: Array<{ employee_id: number; reason: string }>;
    shift_moves: PolicyShiftMove[];
    shift_synced: number[];
  }>>({
    success: true,
    data: {
      assigned,
      skipped,
      shift_moves: moves.filter(
        m => assigned.includes(m.employee_id) || synced.includes(m.employee_id),
      ),
      shift_synced: synced,
    },
  });
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await request.json(); }
  catch {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = EndSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: describeIssues(parsed.error) },
      { status: 400 },
    );
  }

  try {
    await endAssignment({
      employeeId: parsed.data.employee_id,
      effectiveTo: parsed.data.effective_to,
      by: auth.id,
      ip: ipOf(request),
    });
    return NextResponse.json<ApiResponse<{ ended: boolean }>>({ success: true, data: { ended: true } });
  } catch (err) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: (err as Error).message }, { status: 400 },
    );
  }
}

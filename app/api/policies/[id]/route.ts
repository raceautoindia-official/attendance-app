import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth';
import { queryOne } from '@/lib/db';
import { getPolicy, updatePolicy, type Policy } from '@/lib/policy';
import { PolicySchema } from '../route';
import type { ApiResponse } from '@/lib/types';
import { policyFieldLabel } from '@/lib/policyFields';

// ---------------------------------------------------------------------------
// /api/policies/[id]
//
//   GET    one policy
//   PATCH  change it
//   DELETE deactivate it (never a hard delete — see below)
// ---------------------------------------------------------------------------

type Params = { params: Promise<{ id: string }> };

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

export async function GET(request: NextRequest, context: Params) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const id = parseInt((await context.params).id, 10);
  if (Number.isNaN(id)) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid ID' }, { status: 400 });
  }
  const policy = await getPolicy(id);
  if (!policy) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'No such policy' }, { status: 404 });
  }
  return NextResponse.json<ApiResponse<{ policy: Policy }>>({ success: true, data: { policy } });
}

export async function PATCH(request: NextRequest, context: Params) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  const id = parseInt((await context.params).id, 10);
  if (Number.isNaN(id)) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid ID' }, { status: 400 });
  }

  let body: unknown;
  try { body = await request.json(); }
  catch {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = PolicySchema.partial().safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: describeIssues(parsed.error) },
      { status: 400 },
    );
  }

  try {
    const policy = await updatePolicy(id, parsed.data, auth.id, ipOf(request));
    return NextResponse.json<ApiResponse<{ policy: Policy }>>({ success: true, data: { policy } });
  } catch (err) {
    const message = (err as Error).message;
    return NextResponse.json<ApiResponse>(
      { success: false, error: message },
      { status: /No such policy/.test(message) ? 404 : 400 },
    );
  }
}

/**
 * Deactivate, never delete.
 *
 * A policy that has been assigned is part of the record of how somebody's hours
 * were computed — deleting it would orphan that history and make a past month
 * unexplainable. Deactivating stops it being assigned to anybody new while
 * leaving every past assignment intact and resolvable.
 */
export async function DELETE(request: NextRequest, context: Params) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  const id = parseInt((await context.params).id, 10);
  if (Number.isNaN(id)) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid ID' }, { status: 400 });
  }

  const policy = await getPolicy(id);
  if (!policy) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'No such policy' }, { status: 404 });
  }

  const inForce = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM employee_policies WHERE policy_id = ? AND effective_to IS NULL`,
    [id],
  );
  if (Number(inForce?.n ?? 0) > 0) {
    return NextResponse.json<ApiResponse>(
      {
        success: false,
        error: `${inForce!.n} employee(s) are still on "${policy.name}". `
          + 'Move them to another policy first, or end their assignment.',
      },
      { status: 409 },
    );
  }

  const updated = await updatePolicy(id, { is_active: false }, auth.id, ipOf(request));
  return NextResponse.json<ApiResponse<{ policy: Policy }>>({ success: true, data: { policy: updated } });
}

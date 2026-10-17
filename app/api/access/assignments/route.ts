import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth';
import { resolveAccess, assertCan, ForbiddenError } from '@/lib/access';
import { listRoleHolders, grantRole, revokeRole, AccessError } from '@/lib/accessAdmin';
import type { ApiResponse } from '@/lib/types';

const AssignSchema = z.object({
  employee_id: z.number().int().positive(),
  role_id: z.number().int().positive(),
  action: z.enum(['grant', 'revoke']),
});

function ipOf(request: NextRequest): string | null {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? request.headers.get('x-real-ip') ?? null;
}

async function guard(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return { response: auth };
  const ctx = await resolveAccess(auth.id);
  try { assertCan(ctx, 'roles.manage'); }
  catch (e) {
    if (e instanceof ForbiddenError) {
      return { response: NextResponse.json<ApiResponse>({ success: false, error: e.message }, { status: 403 }) };
    }
    throw e;
  }
  return { auth };
}

export async function GET(request: NextRequest) {
  const g = await guard(request);
  if (g.response) return g.response;
  const holders = await listRoleHolders();
  return NextResponse.json<ApiResponse<{ holders: typeof holders }>>({
    success: true, data: { holders },
  });
}

export async function POST(request: NextRequest) {
  const g = await guard(request);
  if (g.response) return g.response;

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 }); }

  const parsed = AssignSchema.safeParse(body);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return NextResponse.json<ApiResponse>(
      { success: false, error: `${String(i?.path[0] ?? 'Field')}: ${i?.message}` }, { status: 400 });
  }

  const { employee_id, role_id, action } = parsed.data;
  try {
    if (action === 'grant') await grantRole(employee_id, role_id, g.auth!.id, ipOf(request));
    // revokeRole refuses to remove the last grant of roles.manage, which is
    // the one mistake on this page that cannot be undone from this page.
    else await revokeRole(employee_id, role_id, g.auth!.id, ipOf(request));
    return NextResponse.json<ApiResponse>({ success: true });
  } catch (err) {
    if (err instanceof AccessError) {
      return NextResponse.json<ApiResponse>({ success: false, error: err.message }, { status: 400 });
    }
    return NextResponse.json<ApiResponse>({ success: false, error: 'Could not change the role.' }, { status: 400 });
  }
}

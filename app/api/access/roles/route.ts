import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { zBool } from '@/lib/zodFields';
import { requireAuth } from '@/lib/auth';
import { listRoles, listPermissions, resolveAccess, assertCan, ForbiddenError } from '@/lib/access';
import { saveRole, deleteRole, AccessError } from '@/lib/accessAdmin';
import type { ApiResponse } from '@/lib/types';

const RoleSchema = z.object({
  id: z.number().int().positive().optional(),
  code: z.string().regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/,
    'The code must be 2-40 characters: letters, numbers, dot, dash or underscore.',
  ),
  name: z.string().min(1, 'A role needs a name.').max(120),
  description: z.string().max(400).nullable().optional(),
  is_active: zBool.optional(),
  grants: z.array(z.object({
    permission_id: z.number().int().positive(),
    scope: z.enum(['self', 'team', 'department', 'all']),
  })).max(200),
});

function ipOf(request: NextRequest): string | null {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? request.headers.get('x-real-ip') ?? null;
}

/**
 * Gated on the PERMISSION, not on the legacy role.
 *
 * This is the first endpoint to check access the new way, and it has to be:
 * a page that hands out permissions cannot itself be guarded by a hard-coded
 * role, or granting somebody 'roles.manage' would do nothing.
 */
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

  const [roles, permissions] = await Promise.all([listRoles(), listPermissions()]);
  // Both together: a matrix cannot be drawn from either half alone, and two
  // requests would let them render out of step for a frame.
  return NextResponse.json<ApiResponse<{ roles: typeof roles; permissions: typeof permissions }>>({
    success: true, data: { roles, permissions },
  });
}

export async function POST(request: NextRequest) {
  const g = await guard(request);
  if (g.response) return g.response;

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 }); }

  const parsed = RoleSchema.safeParse(body);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return NextResponse.json<ApiResponse>(
      { success: false, error: `${String(i?.path[0] ?? 'Field')}: ${i?.message}` }, { status: 400 });
  }

  try {
    const id = await saveRole(parsed.data, g.auth!.id, ipOf(request));
    return NextResponse.json<ApiResponse<{ id: number }>>({ success: true, data: { id } });
  } catch (err) {
    if (err instanceof AccessError) {
      return NextResponse.json<ApiResponse>({ success: false, error: err.message }, { status: 400 });
    }
    const dup = (err as { code?: string }).code === 'ER_DUP_ENTRY';
    return NextResponse.json<ApiResponse>(
      { success: false, error: dup ? 'That role code is already in use.' : 'Could not save the role.' },
      { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  const g = await guard(request);
  if (g.response) return g.response;

  const id = Number(new URL(request.url).searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'id is required' }, { status: 400 });
  }
  try {
    await deleteRole(id, g.auth!.id, ipOf(request));
    return NextResponse.json<ApiResponse>({ success: true });
  } catch (err) {
    if (err instanceof AccessError) {
      return NextResponse.json<ApiResponse>({ success: false, error: err.message }, { status: 400 });
    }
    return NextResponse.json<ApiResponse>({ success: false, error: 'Could not delete the role.' }, { status: 400 });
  }
}

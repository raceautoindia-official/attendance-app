import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { zBool } from '@/lib/zodFields';
import { requireAuth } from '@/lib/auth';
import {
  listDepartments, buildDepartmentTree, saveDepartment, deactivateDepartment, OrgError,
} from '@/lib/org';
import type { ApiResponse } from '@/lib/types';

const DepartmentSchema = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().min(1, 'A department needs a name.').max(120),
  code: z.string().regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/,
    'The code must be 2-40 characters: letters, numbers, dot, dash or underscore.',
  ),
  parent_id: z.number().int().positive().nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  head_employee_id: z.number().int().positive().nullable().optional(),
  sort_order: z.number().int().optional(),
  is_active: zBool.optional(),
  company_id: z.number().int().positive().nullable().optional(),
});

function ipOf(request: NextRequest): string | null {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? request.headers.get('x-real-ip') ?? null;
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const sp = new URL(request.url).searchParams;
  const rows = await listDepartments(sp.get('include_inactive') === '1');
  // Both shapes, because the page draws the tree and the pickers need the flat
  // list. Building the tree twice on the client is how the two drift apart.
  return NextResponse.json<ApiResponse<{ departments: typeof rows; tree: ReturnType<typeof buildDepartmentTree> }>>({
    success: true,
    data: { departments: rows, tree: buildDepartmentTree(rows) },
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 }); }

  const parsed = DepartmentSchema.safeParse(body);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return NextResponse.json<ApiResponse>(
      { success: false, error: `${String(i?.path[0] ?? 'Field')}: ${i?.message}` }, { status: 400 },
    );
  }

  try {
    const department = await saveDepartment(parsed.data, auth.id, ipOf(request));
    return NextResponse.json<ApiResponse<{ department: typeof department }>>(
      { success: true, data: { department } }, { status: parsed.data.id ? 200 : 201 },
    );
  } catch (err) {
    // An OrgError is a rule the administrator can act on; anything else is a
    // bug and must not have its internals shown to a browser.
    if (err instanceof OrgError) {
      return NextResponse.json<ApiResponse>({ success: false, error: err.message }, { status: 400 });
    }
    const dup = (err as { code?: string }).code === 'ER_DUP_ENTRY';
    return NextResponse.json<ApiResponse>(
      { success: false, error: dup ? 'That department code is already in use.' : 'Could not save the department.' },
      { status: 400 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  const id = Number(new URL(request.url).searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'id is required' }, { status: 400 });
  }
  try {
    // Deactivated, never deleted: past assignments point at it, and a report
    // for March must still be able to name the department somebody was in.
    await deactivateDepartment(id, auth.id, ipOf(request));
    return NextResponse.json<ApiResponse>({ success: true });
  } catch (err) {
    if (err instanceof OrgError) {
      return NextResponse.json<ApiResponse>({ success: false, error: err.message }, { status: 400 });
    }
    return NextResponse.json<ApiResponse>({ success: false, error: 'Could not close the department.' }, { status: 400 });
  }
}

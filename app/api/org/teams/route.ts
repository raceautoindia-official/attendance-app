import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { zBool } from '@/lib/zodFields';
import { requireAuth } from '@/lib/auth';
import { listTeams, saveTeam } from '@/lib/org';
import type { ApiResponse } from '@/lib/types';

const TeamSchema = z.object({
  id: z.number().int().positive().optional(),
  department_id: z.number().int().positive(),
  name: z.string().min(1, 'A team needs a name.').max(120),
  code: z.string().min(2, 'A team needs a code.').max(40),
  lead_employee_id: z.number().int().positive().nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  is_active: zBool.optional(),
});

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;
  const sp = new URL(request.url).searchParams;
  const departmentId = Number(sp.get('department_id'));
  const teams = await listTeams({
    departmentId: Number.isInteger(departmentId) && departmentId > 0 ? departmentId : undefined,
    includeInactive: sp.get('include_inactive') === '1',
  });
  return NextResponse.json<ApiResponse<{ teams: typeof teams }>>({ success: true, data: { teams } });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 }); }

  const parsed = TeamSchema.safeParse(body);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return NextResponse.json<ApiResponse>(
      { success: false, error: `${String(i?.path[0] ?? 'Field')}: ${i?.message}` }, { status: 400 },
    );
  }
  try {
    await saveTeam(parsed.data, auth.id, request.headers.get('x-forwarded-for'));
    return NextResponse.json<ApiResponse>({ success: true });
  } catch (err) {
    const dup = (err as { code?: string }).code === 'ER_DUP_ENTRY';
    return NextResponse.json<ApiResponse>(
      { success: false, error: dup ? 'That team code is already in use.' : 'Could not save the team.' },
      { status: 400 },
    );
  }
}

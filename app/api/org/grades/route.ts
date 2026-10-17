import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { zBool } from '@/lib/zodFields';
import { requireAuth } from '@/lib/auth';
import { listGrades, saveGrade } from '@/lib/org';
import type { ApiResponse } from '@/lib/types';

const GradeSchema = z.object({
  id: z.number().int().positive().optional(),
  code: z.string().min(1, 'A grade needs a code.').max(20),
  name: z.string().min(1, 'A grade needs a name.').max(120),
  // Gaps are deliberate when seeding, so a grade can be inserted between two
  // without renumbering. Sorting on this rather than the code is why 'L10'
  // does not come before 'L2'.
  rank_order: z.number().int().min(0).max(100000).optional(),
  description: z.string().max(500).nullable().optional(),
  is_active: zBool.optional(),
});

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;
  const includeInactive = new URL(request.url).searchParams.get('include_inactive') === '1';
  const grades = await listGrades(includeInactive);
  return NextResponse.json<ApiResponse<{ grades: typeof grades }>>({ success: true, data: { grades } });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 }); }

  const parsed = GradeSchema.safeParse(body);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return NextResponse.json<ApiResponse>(
      { success: false, error: `${String(i?.path[0] ?? 'Field')}: ${i?.message}` }, { status: 400 },
    );
  }
  try {
    await saveGrade(parsed.data, auth.id, request.headers.get('x-forwarded-for'));
    return NextResponse.json<ApiResponse>({ success: true });
  } catch (err) {
    const dup = (err as { code?: string }).code === 'ER_DUP_ENTRY';
    return NextResponse.json<ApiResponse>(
      { success: false, error: dup ? 'That grade code is already in use.' : 'Could not save the grade.' },
      { status: 400 },
    );
  }
}

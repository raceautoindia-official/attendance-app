import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth';
import { listAssignments, assignToOrg, unplacedEmployees, OrgError } from '@/lib/org';
import type { ApiResponse } from '@/lib/types';

// A field left out keeps whatever it was; a field sent as null clears it.
// `.optional()` and `.nullable()` are deliberately both present, and mean
// different things - moving somebody between departments must not silently
// delete their reporting line.
const AssignSchema = z.object({
  employee_id: z.number().int().positive(),
  department_id: z.number().int().positive().nullable().optional(),
  team_id: z.number().int().positive().nullable().optional(),
  grade_id: z.number().int().positive().nullable().optional(),
  reports_to: z.number().int().positive().nullable().optional(),
  designation: z.string().max(120).nullable().optional(),
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'effective_from must be YYYY-MM-DD'),
  notes: z.string().max(500).nullable().optional(),
});

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const sp = new URL(request.url).searchParams;
  const employeeId = Number(sp.get('employee_id'));
  const onDate = sp.get('on_date');

  const assignments = await listAssignments({
    employeeId: Number.isInteger(employeeId) && employeeId > 0 ? employeeId : undefined,
    onDate: onDate && /^\d{4}-\d{2}-\d{2}$/.test(onDate) ? onDate : undefined,
  });
  // Returned alongside, because "who is still unplaced" is the question this
  // page exists to close and it should not need a second request to ask it.
  const unplaced = sp.get('with_unplaced') === '1' ? await unplacedEmployees() : [];

  return NextResponse.json<ApiResponse<{ assignments: typeof assignments; unplaced: typeof unplaced }>>({
    success: true, data: { assignments, unplaced },
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 }); }

  const parsed = AssignSchema.safeParse(body);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return NextResponse.json<ApiResponse>(
      { success: false, error: `${String(i?.path[0] ?? 'Field')}: ${i?.message}` }, { status: 400 },
    );
  }

  const d = parsed.data;
  try {
    await assignToOrg({
      employeeId: d.employee_id,
      // Passed through only when present, so `undefined` reaches the library
      // and keeps the existing value rather than clearing it.
      ...(d.department_id !== undefined ? { departmentId: d.department_id } : {}),
      ...(d.team_id !== undefined ? { teamId: d.team_id } : {}),
      ...(d.grade_id !== undefined ? { gradeId: d.grade_id } : {}),
      ...(d.reports_to !== undefined ? { reportsTo: d.reports_to } : {}),
      ...(d.designation !== undefined ? { designation: d.designation } : {}),
      effectiveFrom: d.effective_from,
      notes: d.notes ?? null,
      by: auth.id,
      ip: request.headers.get('x-forwarded-for'),
    });
    return NextResponse.json<ApiResponse>({ success: true });
  } catch (err) {
    if (err instanceof OrgError) {
      return NextResponse.json<ApiResponse>({ success: false, error: err.message }, { status: 400 });
    }
    return NextResponse.json<ApiResponse>({ success: false, error: 'Could not save the placement.' }, { status: 400 });
  }
}

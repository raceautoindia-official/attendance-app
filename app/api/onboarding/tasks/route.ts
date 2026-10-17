import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth';
import { setTaskStatus, listJourneys, OnboardingError } from '@/lib/onboarding';
import { queryOne } from '@/lib/db';
import type { ApiResponse } from '@/lib/types';

const TaskSchema = z.object({
  task_id: z.number().int().positive(),
  status: z.enum(['pending', 'done', 'not_applicable']),
  notes: z.string().max(500).nullable().optional(),
});

function ipOf(request: NextRequest): string | null {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? request.headers.get('x-real-ip') ?? null;
}

/**
 * Tick a task off.
 *
 * An employee may update tasks on THEIR OWN checklist, because several of them
 * are genuinely theirs to do — install the app, give an emergency contact,
 * acknowledge the policies — and routing those through HR is how a checklist
 * becomes a chase.
 *
 * But only their own, and only tasks whose owner is the employee. "Access
 * revoked" and "final settlement paid" are not theirs to mark done, and the
 * check is on the task's owner_role rather than on a list of titles so it
 * keeps working when somebody edits the template.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['employee', 'manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 }); }

  const parsed = TaskSchema.safeParse(body);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return NextResponse.json<ApiResponse>(
      { success: false, error: `${String(i?.path[0] ?? 'Field')}: ${i?.message}` }, { status: 400 });
  }

  const isAdmin = auth.role === 'manager' || auth.role === 'super_admin';

  if (!isAdmin) {
    const owner = await queryOne<{ employee_id: number; owner_role: string }>(
      `SELECT j.employee_id, t.owner_role
         FROM employee_onboarding_tasks t
         JOIN employee_onboarding j ON j.id = t.journey_id
        WHERE t.id = ?`,
      [parsed.data.task_id]);

    if (!owner || Number(owner.employee_id) !== auth.id) {
      // Same answer whether the task belongs to somebody else or does not
      // exist: distinguishing them would confirm that another person's
      // checklist contains a given task id.
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'That task is not on your checklist.' }, { status: 403 });
    }
    if (owner.owner_role !== 'employee') {
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'Somebody else is responsible for that one. Ask them to mark it done.' },
        { status: 403 });
    }
  }

  try {
    await setTaskStatus({
      taskId: parsed.data.task_id, status: parsed.data.status,
      notes: parsed.data.notes, by: auth.id, ip: ipOf(request),
    });
    // The updated journey comes back, so the caller re-renders progress and
    // the overdue count from one response rather than refetching the board.
    const task = await queryOne<{ journey_id: number }>(
      `SELECT journey_id FROM employee_onboarding_tasks WHERE id = ?`, [parsed.data.task_id]);
    const journeys = task
      ? (await listJourneys()).filter(j => j.id === Number(task.journey_id))
      : [];
    return NextResponse.json<ApiResponse<{ journey: typeof journeys[number] | null }>>({
      success: true, data: { journey: journeys[0] ?? null },
    });
  } catch (err) {
    if (err instanceof OnboardingError) {
      return NextResponse.json<ApiResponse>({ success: false, error: err.message }, { status: 400 });
    }
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Could not update that task.' }, { status: 400 });
  }
}

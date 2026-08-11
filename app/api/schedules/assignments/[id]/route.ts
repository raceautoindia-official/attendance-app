import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import type { ApiResponse } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

// ---------------------------------------------------------------------------
// Switch the fence on or off for ONE assigned schedule.
//
// Until now the only way to change geofencing_enabled was to assign a whole new
// schedule, so in practice it was changed with SQL — which is how a fence ended
// up live on phones that were not reporting, and how it stayed that way. It is
// a per-person decision that gets revisited often: someone whose handset cannot
// hold a background location still needs their movements recorded, they just
// must not be judged by a fence.
//
// Turning the fence OFF deliberately leaves live tracking alone. They are
// separate switches: employees.live_tracking_enabled records where somebody
// went, employee_schedules.geofencing_enabled decides whether being outside a
// radius ends their day.
// ---------------------------------------------------------------------------

const PatchSchema = z.object({
  geofencing_enabled: z.boolean(),
});

export async function PATCH(request: NextRequest, context: Params) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const { id } = await context.params;
  const scheduleId = Number(id);
  if (!Number.isInteger(scheduleId) || scheduleId <= 0) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid schedule id' }, { status: 400 });
  }

  const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'geofencing_enabled must be true or false' },
      { status: 400 },
    );
  }
  const { geofencing_enabled } = parsed.data;

  const schedule = await queryOne<{
    id: number;
    employee_id: number;
    location_id: number | null;
    location_active: number | null;
    employee_name: string;
    emp_id: string;
  }>(
    `SELECT es.id, es.employee_id, es.location_id,
            l.is_active AS location_active,
            e.name AS employee_name, e.emp_id
     FROM employee_schedules es
     JOIN employees e ON e.id = es.employee_id
     LEFT JOIN locations l ON l.id = es.location_id
     WHERE es.id = ?`,
    [scheduleId],
  );
  if (!schedule) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Schedule not found' }, { status: 404 });
  }

  // The same rule the assign route applies: a fence needs coordinates. Allowing
  // it without one produces a schedule that looks fenced and enforces nothing —
  // and clock-in silently accepts any location.
  if (geofencing_enabled && !schedule.location_id) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Assign a work location first — a fence needs coordinates to check against' },
      { status: 400 },
    );
  }
  if (geofencing_enabled && schedule.location_active !== 1) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'That work location is deactivated, so no fence can be enforced against it' },
      { status: 400 },
    );
  }

  await query('UPDATE employee_schedules SET geofencing_enabled = ? WHERE id = ?',
    [geofencing_enabled ? 1 : 0, scheduleId]);

  await insertAuditLog({
    action: geofencing_enabled ? 'geofencing_enabled' : 'geofencing_disabled',
    entity: 'employee_schedule',
    entity_id: scheduleId,
    performed_by: auth.id,
    details: {
      employee_id: schedule.employee_id,
      emp_id: schedule.emp_id,
      location_id: schedule.location_id,
    },
    ip_address: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  });

  return NextResponse.json<ApiResponse<{ schedule_id: number; geofencing_enabled: boolean }>>({
    success: true,
    data: { schedule_id: scheduleId, geofencing_enabled },
  });
}

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { overlappingShiftNames, type DayShift } from '@/lib/shifts';
import { parseWorkingDays } from '@/lib/workingDays';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// GET /api/schedules/assignments
//
// Who is rostered on what, today. The Schedules screen needs this to show an
// employee's existing shift before adding a second one, and to surface two
// misconfigurations that are otherwise invisible:
//   • geofencing switched on with no location — nothing is actually fenced
//   • two shifts whose clock windows overlap — they cannot both be worked
// ---------------------------------------------------------------------------

interface AssignmentRow {
  schedule_id: number;
  employee_id: number;
  employee_name: string;
  emp_id: string;
  shift_id: number;
  shift_name: string;
  start_time: string | null;
  end_time: string | null;
  required_hours: number | string | null;
  working_days: unknown;
  location_id: number | null;
  location_name: string | null;
  geofencing_enabled: boolean | number;
  effective_from: string;
}

export interface EmployeeAssignments {
  employee_id: number;
  employee_name: string;
  emp_id: string;
  shifts: Array<{
    schedule_id: number;
    shift_id: number;
    shift_name: string;
    start_time: string | null;
    end_time: string | null;
    location_id: number | null;
    location_name: string | null;
    geofencing_enabled: boolean;
    effective_from: string;
    /** Geofencing is on but no location is set, so no fence is enforced. */
    fence_without_location: boolean;
  }>;
  overlapping_shifts: string[] | null;
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const rows = await query<AssignmentRow>(
    `SELECT es.id AS schedule_id, e.id AS employee_id, e.name AS employee_name, e.emp_id,
            s.id AS shift_id, s.name AS shift_name, s.start_time, s.end_time,
            s.required_hours, s.working_days,
            es.location_id, l.name AS location_name, es.geofencing_enabled,
            DATE_FORMAT(es.effective_from, '%Y-%m-%d') AS effective_from
     FROM employee_schedules es
     JOIN employees e ON e.id = es.employee_id
     JOIN shifts s ON s.id = es.shift_id
     LEFT JOIN locations l ON l.id = es.location_id
     WHERE e.is_active = TRUE
       AND es.effective_from <= CURDATE()
       AND (es.effective_to IS NULL OR es.effective_to >= CURDATE())
       ${auth.role === 'manager' ? 'AND e.manager_id = ?' : ''}
     ORDER BY e.name ASC, COALESCE(s.start_time, '00:00:00') ASC`,
    auth.role === 'manager' ? [auth.id] : [],
  );

  const byEmployee = new Map<number, EmployeeAssignments>();
  const shiftsFor = new Map<number, DayShift[]>();

  for (const r of rows) {
    let entry = byEmployee.get(r.employee_id);
    if (!entry) {
      entry = {
        employee_id: r.employee_id,
        employee_name: r.employee_name,
        emp_id: r.emp_id,
        shifts: [],
        overlapping_shifts: null,
      };
      byEmployee.set(r.employee_id, entry);
      shiftsFor.set(r.employee_id, []);
    }
    const fenced = Boolean(r.geofencing_enabled);
    entry.shifts.push({
      schedule_id: r.schedule_id,
      shift_id: r.shift_id,
      shift_name: r.shift_name,
      start_time: r.start_time,
      end_time: r.end_time,
      location_id: r.location_id,
      location_name: r.location_name,
      geofencing_enabled: fenced,
      effective_from: r.effective_from,
      fence_without_location: fenced && r.location_id == null,
    });
    shiftsFor.get(r.employee_id)!.push({
      shift_id: r.shift_id,
      name: r.shift_name,
      start_time: r.start_time,
      end_time: r.end_time,
      required_hours: r.required_hours,
      working_days: parseWorkingDays(r.working_days),
    } as DayShift);
  }

  for (const [id, entry] of byEmployee) {
    const clash = overlappingShiftNames(shiftsFor.get(id) ?? []);
    entry.overlapping_shifts = clash.length ? clash : null;
  }

  return NextResponse.json<ApiResponse<{ assignments: EmployeeAssignments[] }>>(
    { success: true, data: { assignments: [...byEmployee.values()] } },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * lib/chat/tools/operations.ts — shifts, live-tracking status and audit trail.
 */

import { query } from '@/lib/db';
import { resolveRange, toIstDateTime, toYmdString, type RangeInput } from '../dates';
import { requireSuperAdmin, type ChatContext, type ToolResult } from '../types';

export interface ShiftRow {
  id: number;
  name: string;
  type: string;
  start_time: string | null;
  end_time: string | null;
  required_hours: number | null;
  grace_minutes: number;
  working_days: unknown;
}

/** All configured shifts. */
export async function getShifts(ctx: ChatContext): Promise<ToolResult<ShiftRow>> {
  requireSuperAdmin(ctx);

  const rows = await query<ShiftRow>(
    `SELECT s.id, s.name, s.type, s.start_time, s.end_time,
            s.required_hours, s.grace_minutes, s.working_days
       FROM shifts s
      ORDER BY s.name ASC
      LIMIT 100`,
  );

  return { count: rows.length, rows };
}

export interface ScheduleRow {
  emp_id: string;
  name: string;
  shift_name: string;
  shift_type: string;
  start_time: string | null;
  end_time: string | null;
  location_name: string | null;
  radius_meters: number | null;
  geofencing_enabled: 0 | 1;
  effective_from: string;
  effective_to: string | null;
  is_current: boolean;
}

/**
 * Shift/location assignments for one employee, newest first. Includes expired
 * assignments so "what shift was he on in July" is answerable.
 */
export async function getSchedule(
  ctx: ChatContext,
  args: { employee_id: number },
): Promise<ToolResult<ScheduleRow>> {
  requireSuperAdmin(ctx);

  const rows = await query<{
    emp_id: string;
    name: string;
    shift_name: string;
    shift_type: string;
    start_time: string | null;
    end_time: string | null;
    location_name: string | null;
    radius_meters: number | null;
    geofencing_enabled: 0 | 1;
    effective_from: Date | string;
    effective_to: Date | string | null;
    is_current: 0 | 1;
  }>(
    `SELECT e.emp_id, e.name,
            s.name AS shift_name, s.type AS shift_type, s.start_time, s.end_time,
            l.name AS location_name, l.radius_meters,
            es.geofencing_enabled, es.effective_from, es.effective_to,
            (es.effective_from <= CURDATE()
              AND (es.effective_to IS NULL OR es.effective_to >= CURDATE())) AS is_current
       FROM employee_schedules es
       JOIN employees e ON e.id = es.employee_id
       JOIN shifts    s ON s.id = es.shift_id
       LEFT JOIN locations l ON l.id = es.location_id
      WHERE es.employee_id = ?
      ORDER BY es.effective_from DESC
      LIMIT 50`,
    [args.employee_id],
  );

  return {
    count: rows.length,
    rows: rows.map(r => ({
      ...r,
      effective_from: toYmdString(r.effective_from),
      effective_to: r.effective_to ? toYmdString(r.effective_to) : null,
      is_current: Boolean(Number(r.is_current)),
    })),
    notes: rows.length === 0 ? ['No shift has been assigned to this employee.'] : undefined,
  };
}

export interface LiveTrackingRow {
  emp_id: string;
  name: string;
  department: string | null;
  started_at_ist: string;
  last_ping_ist: string;
  signal_age_minutes: number | null;
  signal_state: 'live' | 'stale' | 'no_ping';
}

/**
 * Employees with an open live-tracking session right now.
 *
 * DELIBERATELY EXCLUDES COORDINATES. This reports whether tracking is active
 * and how fresh the signal is — not where anyone is. Narrating GPS positions or
 * path history in chat has no reporting use and considerable downside, so
 * latitude/longitude and live_tracking_points are not reachable from the chat
 * layer at all. The admin map remains the place for location itself.
 */
export async function getLiveTrackingStatus(
  ctx: ChatContext,
): Promise<ToolResult<LiveTrackingRow>> {
  requireSuperAdmin(ctx);

  const rows = await query<{
    emp_id: string;
    name: string;
    department: string | null;
    started_at_utc: Date;
    last_ping_utc: Date | null;
    signal_age_minutes: number | null;
  }>(
    `SELECT e.emp_id, e.name, e.department,
            t.started_at_utc, t.last_ping_utc,
            TIMESTAMPDIFF(MINUTE, t.last_ping_utc, UTC_TIMESTAMP()) AS signal_age_minutes
       FROM live_tracking_sessions t
       JOIN employees e ON e.id = t.employee_id
      WHERE t.is_active = TRUE
      ORDER BY e.name ASC
      LIMIT 200`,
  );

  return {
    count: rows.length,
    rows: rows.map(r => {
      const age = r.signal_age_minutes == null ? null : Number(r.signal_age_minutes);
      return {
        emp_id: r.emp_id,
        name: r.name,
        department: r.department,
        started_at_ist: toIstDateTime(r.started_at_utc),
        last_ping_ist: toIstDateTime(r.last_ping_utc),
        signal_age_minutes: age,
        signal_state: age == null ? 'no_ping' : age <= 10 ? 'live' : 'stale',
      };
    }),
    notes:
      rows.length === 0
        ? ['No employees are being tracked right now.']
        : ['This reports tracking status only. Locations are on the admin map, not here.'],
  };
}

export interface AuditRow {
  created_at_ist: string;
  action: string;
  entity: string;
  entity_id: number | null;
  performed_by_name: string | null;
  performed_by_emp_id: string | null;
}

/**
 * Who changed what, over a range.
 *
 * SECURITY: the `details` JSON column is intentionally NOT returned. Edit
 * payloads logged elsewhere in the app may embed employee fields, and routing
 * that through the chat would bypass the PII allowlist in lib/chat/types.ts.
 * This returns the shape of the change (who / what / when), not its contents.
 */
export async function getAuditTrail(
  ctx: ChatContext,
  args: { entity?: string; performed_by?: number } & RangeInput = {},
): Promise<ToolResult<AuditRow>> {
  requireSuperAdmin(ctx);

  const range = resolveRange(args);
  const conditions = ['al.created_at >= ?', 'al.created_at < DATE_ADD(?, INTERVAL 1 DAY)'];
  const params: unknown[] = [range.from, range.to];

  if (args.entity) {
    conditions.push('al.entity = ?');
    params.push(args.entity);
  }

  if (Number.isInteger(args.performed_by)) {
    conditions.push('al.performed_by = ?');
    params.push(args.performed_by);
  }

  const rows = await query<{
    created_at: Date;
    action: string;
    entity: string;
    entity_id: number | null;
    performed_by_name: string | null;
    performed_by_emp_id: string | null;
  }>(
    `SELECT al.created_at, al.action, al.entity, al.entity_id,
            e.name   AS performed_by_name,
            e.emp_id AS performed_by_emp_id
       FROM audit_log al
       LEFT JOIN employees e ON e.id = al.performed_by
      WHERE ${conditions.join(' AND ')}
      ORDER BY al.created_at DESC
      LIMIT 200`,
    params,
  );

  return {
    range,
    count: rows.length,
    rows: rows.map(r => ({
      created_at_ist: toIstDateTime(r.created_at),
      action: r.action,
      entity: r.entity,
      entity_id: r.entity_id,
      performed_by_name: r.performed_by_name,
      performed_by_emp_id: r.performed_by_emp_id,
    })),
    notes: rows.length === 0 ? ['No audit entries in this period.'] : undefined,
  };
}

/**
 * lib/chat/tools/leave.ts — leave and holiday queries for the admin chat.
 *
 * SCHEMA NOTE: in `leave_records`, a row with employee_id IS NULL is a
 * COMPANY-WIDE holiday, not a personal leave. Every query below is explicit
 * about which of the two it means — conflating them inflates leave counts.
 */

import { query } from '@/lib/db';
import { resolveRange, toYmdString, type RangeInput } from '../dates';
import { requireSuperAdmin, type ChatContext, type ToolResult } from '../types';

export const LEAVE_TYPES = ['casual', 'sick', 'earned', 'holiday', 'other'] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];

export interface LeaveRecordRow {
  leave_date: string;
  emp_id: string | null;
  name: string | null;
  department: string | null;
  leave_type: LeaveType;
  notes: string | null;
  is_company_wide: boolean;
}

/**
 * Personal leave rows over a range. Company-wide holidays are excluded —
 * use `getHolidays` for those.
 */
export async function getLeaveRecords(
  ctx: ChatContext,
  args: {
    employee_ids?: number[];
    department?: string;
    leave_type?: LeaveType;
  } & RangeInput = {},
): Promise<ToolResult<LeaveRecordRow>> {
  requireSuperAdmin(ctx);

  const range = resolveRange(args);
  const conditions = ['lr.employee_id IS NOT NULL', 'lr.leave_date BETWEEN ? AND ?'];
  const params: unknown[] = [range.from, range.to];

  const ids = (args.employee_ids ?? []).filter(n => Number.isInteger(n));
  if (ids.length > 0) {
    conditions.push(`lr.employee_id IN (${ids.map(() => '?').join(', ')})`);
    params.push(...ids);
  }

  if (args.department) {
    conditions.push('e.department = ?');
    params.push(args.department);
  }

  if (args.leave_type) {
    conditions.push('lr.leave_type = ?');
    params.push(args.leave_type);
  } else {
    conditions.push("lr.leave_type <> 'holiday'");
  }

  const rows = await query<{
    leave_date: Date | string;
    emp_id: string | null;
    name: string | null;
    department: string | null;
    leave_type: LeaveType;
    notes: string | null;
  }>(
    `SELECT lr.leave_date, e.emp_id, e.name, e.department, lr.leave_type, lr.notes
       FROM leave_records lr
       JOIN employees e ON e.id = lr.employee_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY lr.leave_date DESC, e.name ASC
      LIMIT 300`,
    params,
  );

  return {
    range,
    count: rows.length,
    rows: rows.map(r => ({
      leave_date: toYmdString(r.leave_date),
      emp_id: r.emp_id,
      name: r.name,
      department: r.department,
      leave_type: r.leave_type,
      notes: r.notes,
      is_company_wide: false,
    })),
    notes: rows.length === 0 ? ['No leave records in this period.'] : undefined,
  };
}

export interface HolidayRow {
  leave_date: string;
  notes: string | null;
}

/** Company-wide holidays (employee_id IS NULL) in a range. */
export async function getHolidays(
  ctx: ChatContext,
  args: RangeInput = {},
): Promise<ToolResult<HolidayRow>> {
  requireSuperAdmin(ctx);

  const range = resolveRange(args);

  const rows = await query<{ leave_date: Date | string; notes: string | null }>(
    `SELECT lr.leave_date, lr.notes
       FROM leave_records lr
      WHERE lr.employee_id IS NULL
        AND lr.leave_type = 'holiday'
        AND lr.leave_date BETWEEN ? AND ?
      ORDER BY lr.leave_date ASC
      LIMIT 200`,
    [range.from, range.to],
  );

  return {
    range,
    count: rows.length,
    rows: rows.map(r => ({
      leave_date: toYmdString(r.leave_date),
      notes: r.notes,
    })),
    notes: rows.length === 0 ? ['No company holidays in this period.'] : undefined,
  };
}

export interface LeaveBalanceRow {
  emp_id: string;
  name: string;
  year: number;
  leave_type: 'casual' | 'sick' | 'earned';
  allotted: number;
  taken: number;
  remaining: number;
}

/**
 * Quota vs consumed for one employee in a calendar year.
 *
 * `taken` counts DISTINCT leave_date so a duplicated row cannot inflate it.
 * Employees with no `leave_quotas` row for the year report allotted = 0, which
 * the note makes explicit rather than implying zero entitlement.
 */
export async function getLeaveBalance(
  ctx: ChatContext,
  args: { employee_id: number; year?: number },
): Promise<ToolResult<LeaveBalanceRow>> {
  requireSuperAdmin(ctx);

  const year = args.year ?? new Date().getUTCFullYear();

  const quota = await query<{
    emp_id: string;
    name: string;
    casual_total: number | null;
    sick_total: number | null;
    earned_total: number | null;
  }>(
    `SELECT e.emp_id, e.name,
            q.casual_total, q.sick_total, q.earned_total
       FROM employees e
       LEFT JOIN leave_quotas q
              ON q.employee_id = e.id AND q.year = ?
      WHERE e.id = ?
      LIMIT 1`,
    [year, args.employee_id],
  );

  if (quota.length === 0) {
    return { count: 0, rows: [], notes: ['No such employee.'] };
  }

  const taken = await query<{ leave_type: string; days: number }>(
    `SELECT lr.leave_type, COUNT(DISTINCT lr.leave_date) AS days
       FROM leave_records lr
      WHERE lr.employee_id = ?
        AND YEAR(lr.leave_date) = ?
        AND lr.leave_type IN ('casual', 'sick', 'earned')
      GROUP BY lr.leave_type`,
    [args.employee_id, year],
  );

  const takenByType = new Map(taken.map(t => [t.leave_type, Number(t.days)]));
  const q = quota[0];
  const hasQuotaRow =
    q.casual_total != null || q.sick_total != null || q.earned_total != null;

  const types: Array<['casual' | 'sick' | 'earned', number]> = [
    ['casual', Number(q.casual_total ?? 0)],
    ['sick', Number(q.sick_total ?? 0)],
    ['earned', Number(q.earned_total ?? 0)],
  ];

  const rows: LeaveBalanceRow[] = types.map(([leave_type, allotted]) => {
    const used = takenByType.get(leave_type) ?? 0;
    return {
      emp_id: q.emp_id,
      name: q.name,
      year,
      leave_type,
      allotted,
      taken: used,
      remaining: allotted - used,
    };
  });

  return {
    count: rows.length,
    rows,
    notes: hasQuotaRow
      ? undefined
      : [
          `No leave quota has been configured for ${q.name} for ${year}, so allotted shows 0 — this is missing configuration, not a zero entitlement.`,
        ],
  };
}

/**
 * lib/chat/tools/employees.ts — employee lookup for the admin chat.
 *
 * `resolveEmployee` is the entry point for any question naming a person. It
 * deliberately returns ALL candidates rather than guessing, so the model asks
 * which one instead of silently reporting on the wrong Arun.
 */

import { query } from '@/lib/db';
import {
  requireSuperAdmin,
  safeEmployeeSelect,
  type ChatContext,
  type ToolResult,
} from '../types';

/**
 * Escape LIKE wildcards so a search for "50%" or "a_b" matches literally
 * instead of behaving as a pattern. Backslash is MySQL's default LIKE escape
 * character, so prefixing with one is all that is needed — and the backslash
 * itself must be escaped first, hence its presence in the character class.
 */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, ch => '\\' + ch);
}

export interface EmployeeCandidate {
  id: number;
  emp_id: string;
  name: string;
  department: string | null;
  role: string;
  is_active: 0 | 1;
  work_mode: 'on_site' | 'off_site';
  display: string;
}

/**
 * Find employees matching a name fragment or an exact employee ID.
 *
 * Inactive employees are included (historical reports are a legitimate
 * question) but flagged, so the answer can say so.
 */
export async function resolveEmployee(
  ctx: ChatContext,
  args: { search: string; include_inactive?: boolean },
): Promise<ToolResult<EmployeeCandidate>> {
  requireSuperAdmin(ctx);

  const search = (args.search ?? '').trim();
  if (search.length < 2) {
    throw new Error('Provide at least 2 characters to search for an employee.');
  }

  // Backslash is MySQL's default LIKE escape character, so no ESCAPE clause
  // is needed — escapeLike() below prefixes wildcards with it.
  const conditions = ['(e.emp_id = ? OR e.name LIKE ?)'];
  const params: unknown[] = [search, `%${escapeLike(search)}%`];

  if (!args.include_inactive) {
    conditions.push('e.is_active = TRUE');
  }

  const rows = await query<Omit<EmployeeCandidate, 'display'>>(
    `SELECT e.id, e.emp_id, e.name, e.department, e.role, e.is_active, e.work_mode
       FROM employees e
      WHERE ${conditions.join(' AND ')}
      ORDER BY e.is_active DESC, e.name ASC
      LIMIT 25`,
    params,
  );

  return {
    count: rows.length,
    rows: rows.map(r => ({
      ...r,
      display:
        `${r.name} (${r.emp_id})` +
        (r.department ? ` — ${r.department}` : '') +
        (r.is_active ? '' : ' — INACTIVE'),
    })),
    notes: rows.length === 0
      ? [`No employee matches "${search}".`]
      : rows.length > 1
        ? ['More than one employee matched — ask which one before reporting.']
        : undefined,
  };
}

export interface EmployeeProfile {
  id: number;
  emp_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  department: string | null;
  role: string;
  is_active: 0 | 1;
  work_mode: 'on_site' | 'off_site';
  allow_multiple_sessions: 0 | 1;
  live_tracking_enabled: 0 | 1;
  manager_name: string | null;
  shift_name: string | null;
  location_name: string | null;
}

/**
 * Profile for one employee.
 *
 * SECURITY: selects only SAFE_EMPLOYEE_COLUMNS — bank details, PAN and Aadhaar
 * are unreachable from the chat layer by construction.
 */
export async function getEmployeeProfile(
  ctx: ChatContext,
  args: { employee_id: number },
): Promise<ToolResult<EmployeeProfile>> {
  requireSuperAdmin(ctx);

  const rows = await query<EmployeeProfile>(
    `SELECT ${safeEmployeeSelect('e')},
            m.name  AS manager_name,
            s.name  AS shift_name,
            l.name  AS location_name
       FROM employees e
       LEFT JOIN employees m ON m.id = e.manager_id
       LEFT JOIN employee_schedules es
              ON es.employee_id = e.id
             AND es.effective_from <= CURDATE()
             AND (es.effective_to IS NULL OR es.effective_to >= CURDATE())
       LEFT JOIN shifts    s ON s.id = es.shift_id
       LEFT JOIN locations l ON l.id = es.location_id
      WHERE e.id = ?
      ORDER BY es.effective_from DESC
      LIMIT 1`,
    [args.employee_id],
  );

  return { count: rows.length, rows };
}

export interface DepartmentRow {
  department: string;
  employee_count: number;
}

/** The departments that exist, for answering "which teams are there". */
export async function listDepartments(
  ctx: ChatContext,
): Promise<ToolResult<DepartmentRow>> {
  requireSuperAdmin(ctx);

  const rows = await query<DepartmentRow>(
    `SELECT COALESCE(e.department, 'Unassigned') AS department,
            COUNT(*)                            AS employee_count
       FROM employees e
      WHERE e.is_active = TRUE
      GROUP BY COALESCE(e.department, 'Unassigned')
      ORDER BY employee_count DESC, department ASC`,
  );

  return { count: rows.length, rows };
}

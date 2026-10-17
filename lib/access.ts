import { query, queryOne } from '@/lib/db';
import { departmentSubtreeIdsFor } from '@/lib/org';

/**
 * lib/access.ts — what somebody may do, and over whom.
 *
 * A permission on its own answers half the question. "A manager may view
 * attendance" has to mean THEIR people's attendance, so every grant carries a
 * scope and every list narrows to it.
 *
 * THE RULE THAT KEEPS THIS HONEST: scope is applied in the QUERY, not in the
 * page. A page that forgets to filter is a page that shows a manager somebody
 * else's bank details, and it will look perfectly correct in review. So the
 * shape of this module is deliberately awkward to misuse — `visibleEmployeeIds`
 * returns either `'all'` or an explicit list, and there is no third answer
 * meaning "do not bother filtering".
 *
 * IT SHIPS INERT. An employee with no row in `employee_roles` falls back to
 * exactly what `employees.role` already gave them. Applying the migration
 * changes nobody's access; granting a role is the deliberate act that does.
 */

export type Scope = 'self' | 'team' | 'department' | 'all';

/** Widest wins when two roles grant the same thing — see resolveAccess. */
const SCOPE_RANK: Record<Scope, number> = { self: 0, team: 1, department: 2, all: 3 };

export interface AccessContext {
  employeeId: number;
  /** The legacy column. Still the source of the fallback and of the bypass. */
  legacyRole: string;
  /** permission key -> widest scope granted. */
  grants: Map<string, Scope>;
  /** True for super_admin: every check short-circuits. */
  isSuperAdmin: boolean;
  /** True when the grants came from employee_roles rather than the fallback. */
  explicit: boolean;
}

/**
 * Everything the signed-in person may do.
 *
 * Reads `employee_roles` first. When that is empty — which is every employee
 * today — it falls back to the system role matching `employees.role`, so the
 * app behaves exactly as it did before this table existed.
 */
export async function resolveAccess(employeeId: number): Promise<AccessContext> {
  const employee = await queryOne<{ role: string }>(
    `SELECT role FROM employees WHERE id = ?`, [employeeId],
  );
  const legacyRole = employee?.role ?? 'employee';

  // The bypass is deliberate and kept even though super_admin also holds every
  // grant in the database. An access system that can lock out its own
  // administrator eventually will, usually at the worst moment.
  if (legacyRole === 'super_admin') {
    return {
      employeeId, legacyRole, grants: new Map(), isSuperAdmin: true, explicit: false,
    };
  }

  const explicitRows = await query<{ perm_key: string; scope: Scope }>(
    `SELECT p.perm_key, rp.scope
       FROM employee_roles er
       JOIN role_permissions rp ON rp.role_id = er.role_id
       JOIN permissions p ON p.id = rp.permission_id
       JOIN roles r ON r.id = er.role_id AND r.is_active = TRUE
      WHERE er.employee_id = ?`,
    [employeeId],
  );

  // Whether somebody is on the new system is decided by whether they HOLD a
  // role, not by whether that role happens to grant anything.
  //
  // Using the permission count instead meant a role with nothing in it fell
  // through to the legacy fallback - so 'give them an empty role' quietly
  // left them with MORE access than intended rather than none. Holding a role
  // that grants nothing has to mean exactly that.
  const holdsARole = Number((await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM employee_roles er
       JOIN roles r ON r.id = er.role_id AND r.is_active = TRUE
      WHERE er.employee_id = ?`,
    [employeeId],
  ))?.n ?? 0) > 0;

  const rows = holdsARole
    ? explicitRows
    : await query<{ perm_key: string; scope: Scope }>(
        `SELECT p.perm_key, rp.scope
           FROM roles r
           JOIN role_permissions rp ON rp.role_id = r.id
           JOIN permissions p ON p.id = rp.permission_id
          WHERE r.code = ? AND r.is_system = TRUE`,
        [legacyRole],
      );

  // Widest wins. Narrowest-wins would mean that ADDING a role can take access
  // away, which is not what the word "grant" leads anybody to expect.
  const grants = new Map<string, Scope>();
  for (const r of rows) {
    const held = grants.get(r.perm_key);
    if (!held || SCOPE_RANK[r.scope] > SCOPE_RANK[held]) grants.set(r.perm_key, r.scope);
  }

  return {
    employeeId, legacyRole, grants, isSuperAdmin: false,
    explicit: holdsARole,
  };
}

/** May they do this at all, at any scope? */
export function can(ctx: AccessContext, permission: string): boolean {
  return ctx.isSuperAdmin || ctx.grants.has(permission);
}

/** How far this permission reaches. Null when they do not hold it. */
export function scopeOf(ctx: AccessContext, permission: string): Scope | null {
  if (ctx.isSuperAdmin) return 'all';
  return ctx.grants.get(permission) ?? null;
}

/**
 * Whose records this permission lets them see.
 *
 * Returns `'all'`, or an explicit list of employee ids. There is deliberately
 * no "unscoped" answer: a caller that holds no such permission gets an empty
 * list, which narrows a query to nothing rather than widening it to everything.
 * That asymmetry is the whole point — the failure mode of a mistake here must
 * be "sees nothing", never "sees everyone".
 */
export async function visibleEmployeeIds(
  ctx: AccessContext,
  permission: string,
  onDate?: string,
): Promise<'all' | number[]> {
  if (ctx.isSuperAdmin) return 'all';

  const scope = ctx.grants.get(permission);
  // No grant means no rows. Not "no filter".
  if (!scope) return [];
  if (scope === 'all') return 'all';
  if (scope === 'self') return [ctx.employeeId];

  const date = onDate ?? new Date().toISOString().slice(0, 10);

  if (scope === 'team') {
    // Teams they LEAD, not teams they are in. Being on a team does not make
    // somebody's colleagues their business.
    const rows = await query<{ employee_id: number }>(
      `SELECT DISTINCT a.employee_id
         FROM employee_org_assignments a
        WHERE a.team_id IN (SELECT id FROM teams WHERE lead_employee_id = ?)
          AND a.effective_from <= ?
          AND (a.effective_to IS NULL OR a.effective_to >= ?)`,
      [ctx.employeeId, date, date],
    );
    return unique([ctx.employeeId, ...rows.map(r => Number(r.employee_id))]);
  }

  // department: their own department and everything below it in the tree.
  //
  // "Their department" means one they HEAD, or one they are placed in while
  // holding a department-scoped grant. Both are included, because a head is
  // not always formally placed in the department they run.
  const own = await query<{ department_id: number }>(
    `SELECT DISTINCT department_id FROM (
        SELECT a.department_id
          FROM employee_org_assignments a
         WHERE a.employee_id = ? AND a.department_id IS NOT NULL
           AND a.effective_from <= ?
           AND (a.effective_to IS NULL OR a.effective_to >= ?)
        UNION
        SELECT d.id AS department_id FROM departments d WHERE d.head_employee_id = ?
     ) x`,
    [ctx.employeeId, date, date, ctx.employeeId],
  );

  // Somebody with a department scope but no department reaches only
  // themselves. Returning 'all' here would be the leak this module exists to
  // prevent, and an unplaced manager is a perfectly ordinary state.
  if (own.length === 0) return [ctx.employeeId];

  // One read of the tree for all of their departments, not one per
  // department. This resolves on every request a scoped user makes.
  const reachable = new Set<number>(
    await departmentSubtreeIdsFor(own.map(r => Number(r.department_id))),
  );

  const rows = await query<{ employee_id: number }>(
    `SELECT DISTINCT a.employee_id
       FROM employee_org_assignments a
      WHERE a.department_id IN (${[...reachable].map(() => '?').join(',')})
        AND a.effective_from <= ?
        AND (a.effective_to IS NULL OR a.effective_to >= ?)`,
    [...reachable, date, date],
  );
  return unique([ctx.employeeId, ...rows.map(r => Number(r.employee_id))]);
}

function unique(ids: number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

/**
 * A SQL fragment narrowing a query to what they may see.
 *
 * Returns the fragment and its parameters, so a caller splices one piece into
 * its WHERE rather than assembling the list itself and getting it subtly
 * wrong. An empty list becomes `1 = 0` — no rows — never an omitted clause.
 */
export async function employeeScopeSql(
  ctx: AccessContext,
  permission: string,
  column: string,
  onDate?: string,
): Promise<{ sql: string; params: number[] }> {
  const visible = await visibleEmployeeIds(ctx, permission, onDate);
  if (visible === 'all') return { sql: '1 = 1', params: [] };
  if (visible.length === 0) return { sql: '1 = 0', params: [] };
  return {
    sql: `${column} IN (${visible.map(() => '?').join(',')})`,
    params: visible,
  };
}

/** Throws unless they hold the permission. For route handlers. */
export class ForbiddenError extends Error {
  constructor(permission: string) {
    super(`You do not have permission to do that (${permission}).`);
    this.name = 'ForbiddenError';
  }
}

export function assertCan(ctx: AccessContext, permission: string): void {
  if (!can(ctx, permission)) throw new ForbiddenError(permission);
}

/** Every permission, for the Roles admin page. */
export async function listPermissions(): Promise<Array<{
  id: number; perm_key: string; label: string; description: string | null;
  category: string; scopable: boolean; sort_order: number;
}>> {
  const rows = await query<{
    id: number; perm_key: string; label: string; description: string | null;
    category: string; scopable: number; sort_order: number;
  }>(`SELECT * FROM permissions ORDER BY sort_order, perm_key`);
  return rows.map(r => ({ ...r, scopable: Boolean(r.scopable) }));
}

export interface RoleWithGrants {
  id: number; code: string; name: string; description: string | null;
  is_system: boolean; is_active: boolean; holder_count: number;
  grants: Array<{ permission_id: number; perm_key: string; scope: Scope }>;
}

export async function listRoles(): Promise<RoleWithGrants[]> {
  const roles = await query<{
    id: number; code: string; name: string; description: string | null;
    is_system: number; is_active: number; holder_count: number;
  }>(
    `SELECT r.*, (SELECT COUNT(*) FROM employee_roles er WHERE er.role_id = r.id) AS holder_count
       FROM roles r ORDER BY r.is_system DESC, r.name`,
  );
  const grants = await query<{ role_id: number; permission_id: number; perm_key: string; scope: Scope }>(
    `SELECT rp.role_id, rp.permission_id, p.perm_key, rp.scope
       FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id`,
  );
  return roles.map(r => ({
    ...r,
    is_system: Boolean(r.is_system),
    is_active: Boolean(r.is_active),
    holder_count: Number(r.holder_count),
    grants: grants.filter(g => g.role_id === r.id)
      .map(g => ({ permission_id: g.permission_id, perm_key: g.perm_key, scope: g.scope })),
  }));
}

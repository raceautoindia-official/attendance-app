import { query, queryOne, insertAuditLog } from '@/lib/db';
import type { Scope } from '@/lib/access';

/**
 * lib/accessAdmin.ts — changing who may do what.
 *
 * Separate from lib/access.ts on purpose. That module is on the hot path and
 * runs for every request; this one runs only from the Roles page. Keeping them
 * apart means the thing every request imports stays small, and the guards
 * below sit together where they can be read as a set.
 *
 * Those guards are the substance of this file. Access control has one failure
 * mode worse than being too strict: locking out the only person who can undo
 * it. Every rule here exists to keep a route back.
 */

export class AccessError extends Error {
  constructor(message: string) { super(message); this.name = 'AccessError'; }
}

/**
 * Create or update a role and everything it grants.
 *
 * Grants are replaced wholesale rather than merged. A matrix editor sends what
 * the screen shows, and merging would mean a permission unticked on screen
 * quietly stayed granted — the wrong direction for a mistake in this table.
 */
export async function saveRole(
  input: {
    id?: number; code: string; name: string; description?: string | null;
    is_active?: boolean;
    grants: Array<{ permission_id: number; scope: Scope }>;
  },
  by: number,
  ip?: string | null,
): Promise<number> {
  const existing = input.id
    ? await queryOne<{ is_system: number; code: string }>(
        `SELECT is_system, code FROM roles WHERE id = ?`, [input.id])
    : null;
  if (input.id && !existing) throw new AccessError('No such role.');

  // A built-in role may be re-granted but not re-coded. Everybody without an
  // explicit role falls back to one of these BY CODE, so changing the code
  // silently strips permissions from every user on that legacy role.
  if (existing?.is_system && existing.code !== input.code) {
    throw new AccessError(
      'A built-in role cannot be re-coded. Everybody without an explicit role falls '
      + 'back to it by code, so renaming it would silently change what they can do.',
    );
  }

  // An unscopable permission is company-wide by nature. Storing 'team' against
  // one records a state nothing can honour, and the page would then display a
  // limit that does not exist.
  const unscopable = await query<{ id: number; label: string }>(
    `SELECT id, label FROM permissions WHERE scopable = FALSE`);
  const unscopableById = new Map(unscopable.map(u => [Number(u.id), u.label]));
  for (const g of input.grants) {
    if (unscopableById.has(g.permission_id) && g.scope !== 'all') {
      throw new AccessError(
        `"${unscopableById.get(g.permission_id)}" applies to the whole company or not at `
        + 'all, so it cannot be limited to a team or a department.',
      );
    }
  }

  let roleId: number;
  if (input.id) {
    await query(
      `UPDATE roles SET code = ?, name = ?, description = ?, is_active = ? WHERE id = ?`,
      [input.code, input.name, input.description ?? null, input.is_active ?? true, input.id]);
    roleId = input.id;
    await query(`DELETE FROM role_permissions WHERE role_id = ?`, [roleId]);
  } else {
    const res = await query(
      `INSERT INTO roles (code, name, description, is_active, is_system)
       VALUES (?, ?, ?, ?, FALSE)`,
      [input.code, input.name, input.description ?? null, input.is_active ?? true],
    ) as unknown as { insertId: number };
    roleId = res.insertId;
  }

  // One statement. A role granting all twenty-two permissions cost
  // twenty-two round trips, immediately after deleting the old set - so
  // a failure midway left the role holding part of its new grants and
  // none of its old ones, which is the worst state for this table.
  if (input.grants.length > 0) {
    const values: unknown[] = [];
    const rows = input.grants.map(g => {
      values.push(roleId, g.permission_id, g.scope);
      return '(?, ?, ?)';
    });
    await query(
      `INSERT INTO role_permissions (role_id, permission_id, scope)
       VALUES ${rows.join(', ')}`,
      values,
    );
  }

  await insertAuditLog({
    action: input.id ? 'role_updated' : 'role_created', entity: 'role', entity_id: roleId,
    performed_by: by, ip_address: ip ?? null,
    details: { code: input.code, grant_count: input.grants.length },
  });
  return roleId;
}

export async function deleteRole(id: number, by: number, ip?: string | null): Promise<void> {
  const role = await queryOne<{ is_system: number; code: string }>(
    `SELECT is_system, code FROM roles WHERE id = ?`, [id]);
  if (!role) throw new AccessError('No such role.');
  if (role.is_system) {
    throw new AccessError(
      'A built-in role cannot be deleted. Everybody without an explicit role falls back '
      + 'to it, so removing it would leave them with no permissions at all.',
    );
  }
  const holders = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM employee_roles WHERE role_id = ?`, [id]);
  if (Number(holders?.n ?? 0) > 0) {
    throw new AccessError(
      `${holders?.n} person(s) still hold this role. Take it away from them first, so `
      + 'nobody silently loses access they were relying on.',
    );
  }
  await query(`DELETE FROM roles WHERE id = ?`, [id]);
  await insertAuditLog({
    action: 'role_deleted', entity: 'role', entity_id: id,
    performed_by: by, ip_address: ip ?? null, details: { code: role.code },
  });
}

export async function grantRole(
  employeeId: number, roleId: number, by: number, ip?: string | null,
): Promise<void> {
  await query(
    `INSERT INTO employee_roles (employee_id, role_id, granted_by)
     VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE granted_by = VALUES(granted_by)`,
    [employeeId, roleId, by]);
  // "Who gave them that" is asked only after something has gone wrong, by
  // which time it is too late to start recording it.
  await insertAuditLog({
    action: 'role_granted', entity: 'employee_role', entity_id: employeeId,
    performed_by: by, ip_address: ip ?? null,
    details: { employee_id: employeeId, role_id: roleId },
  });
}

export async function revokeRole(
  employeeId: number, roleId: number, by: number, ip?: string | null,
): Promise<void> {
  const role = await queryOne<{ code: string }>(`SELECT code FROM roles WHERE id = ?`, [roleId]);

  // THE LOCKOUT GUARD. Taking the last grant of "manage roles and access"
  // leaves nobody able to grant it back, and the only way out is a database
  // prompt. A super admin counts as a way back, because they bypass all of
  // this by design.
  const grantsRoleAdmin = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = ? AND p.perm_key = 'roles.manage'`, [roleId]);

  if (Number(grantsRoleAdmin?.n ?? 0) > 0) {
    const othersHolding = await queryOne<{ n: number }>(
      `SELECT COUNT(DISTINCT er.employee_id) AS n
         FROM employee_roles er
         JOIN role_permissions rp ON rp.role_id = er.role_id
         JOIN permissions p ON p.id = rp.permission_id
         JOIN employees e ON e.id = er.employee_id AND e.is_active = TRUE
        WHERE p.perm_key = 'roles.manage'
          AND NOT (er.employee_id = ? AND er.role_id = ?)`,
      [employeeId, roleId]);
    const superAdmins = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM employees WHERE role = 'super_admin' AND is_active = TRUE`);

    if (Number(othersHolding?.n ?? 0) === 0 && Number(superAdmins?.n ?? 0) === 0) {
      throw new AccessError(
        'This is the last grant of "manage roles and access" in the system. Removing it '
        + 'would leave nobody able to grant it back.',
      );
    }
  }

  await query(`DELETE FROM employee_roles WHERE employee_id = ? AND role_id = ?`,
    [employeeId, roleId]);
  await insertAuditLog({
    action: 'role_revoked', entity: 'employee_role', entity_id: employeeId,
    performed_by: by, ip_address: ip ?? null,
    details: { employee_id: employeeId, role_id: roleId, role_code: role?.code },
  });
}

export interface RoleHolder {
  employee_id: number;
  name: string;
  emp_id: string;
  legacy_role: string;
  roles: Array<{ id: number; code: string; name: string }>;
}

/** Who holds what. Includes people with no explicit role, who are the point. */
export async function listRoleHolders(): Promise<RoleHolder[]> {
  const rows = await query<{
    employee_id: number; name: string; emp_id: string; legacy_role: string;
    role_id: number | null; role_code: string | null; role_name: string | null;
  }>(
    `SELECT e.id AS employee_id, e.name, e.emp_id, e.role AS legacy_role,
            r.id AS role_id, r.code AS role_code, r.name AS role_name
       FROM employees e
       LEFT JOIN employee_roles er ON er.employee_id = e.id
       LEFT JOIN roles r ON r.id = er.role_id
      WHERE e.is_active = TRUE
      ORDER BY e.name`,
  );

  const byEmployee = new Map<number, RoleHolder>();
  for (const r of rows) {
    const entry = byEmployee.get(r.employee_id) ?? {
      employee_id: r.employee_id, name: r.name, emp_id: r.emp_id,
      legacy_role: r.legacy_role, roles: [],
    };
    if (r.role_id) entry.roles.push({ id: r.role_id, code: r.role_code!, name: r.role_name! });
    byEmployee.set(r.employee_id, entry);
  }
  return [...byEmployee.values()];
}

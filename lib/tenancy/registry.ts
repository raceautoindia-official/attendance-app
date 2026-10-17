import mysql from 'mysql2/promise';
import type { TenantContext } from './context';

/**
 * lib/tenancy/registry.ts — the only database that knows every tenant.
 *
 * Its own small pool, separate from the tenant pools, because it is consulted
 * on every sign-in and must not compete for a tenant's three connections.
 *
 * Nothing here is customer data. The registry answers two questions — where a
 * tenant's database is, and which tenant a login identifier belongs to — and
 * holds no credential, no document and no employee record. That is a
 * deliberate limit: if this database leaked it would disclose that a company
 * is a customer, and nothing about anybody who works there.
 */

const REGISTRY_DB = process.env.REGISTRY_DB_NAME ?? 'worklens_registry';

const globalForRegistry = globalThis as unknown as { __registryPool?: mysql.Pool };

function registryPool(): mysql.Pool {
  if (globalForRegistry.__registryPool) return globalForRegistry.__registryPool;
  const pool = mysql.createPool({
    host: process.env.REGISTRY_DB_HOST ?? process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.REGISTRY_DB_PORT) || Number(process.env.DB_PORT) || 3306,
    user: process.env.REGISTRY_DB_USER ?? process.env.DB_USER,
    password: process.env.REGISTRY_DB_PASSWORD ?? process.env.DB_PASSWORD,
    database: REGISTRY_DB,
    waitForConnections: true,
    // Two is enough: every call here is a single indexed lookup that returns
    // in microseconds, and the registry must never be the thing that starves
    // a tenant of connections.
    connectionLimit: 2,
    queueLimit: 0,
    dateStrings: false,
    timezone: '+00:00',
  });
  globalForRegistry.__registryPool = pool;
  return pool;
}

async function rq<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await registryPool().query(sql, params);
  return rows as T[];
}

export interface TenantRecord extends TenantContext {
  name: string;
  status: 'provisioning' | 'active' | 'suspended' | 'archived';
  plan: string | null;
  maxEmployees: number | null;
}

const SELECT_TENANT = `
  SELECT id, code, name, db_name AS dbName, db_host AS dbHost, db_port AS dbPort,
         status, plan, max_employees AS maxEmployees
    FROM tenants`;

export async function getTenantById(id: number): Promise<TenantRecord | null> {
  const rows = await rq<TenantRecord>(`${SELECT_TENANT} WHERE id = ? LIMIT 1`, [id]);
  return rows[0] ?? null;
}

export async function getTenantByCode(code: string): Promise<TenantRecord | null> {
  const rows = await rq<TenantRecord>(`${SELECT_TENANT} WHERE code = ? LIMIT 1`, [code]);
  return rows[0] ?? null;
}

export async function listTenants(includeInactive = true): Promise<TenantRecord[]> {
  return rq<TenantRecord>(
    `${SELECT_TENANT} ${includeInactive ? '' : "WHERE status = 'active'"} ORDER BY name`,
  );
}

/** Tenants a sign-in may proceed against. */
export async function tenantsForLogin(
  idType: 'emp_id' | 'email',
  identifier: string,
): Promise<Array<{ tenant: TenantRecord; employeeId: number }>> {
  const rows = await rq<TenantRecord & { employee_id: number }>(
    `SELECT t.id, t.code, t.name, t.db_name AS dbName, t.db_host AS dbHost,
            t.db_port AS dbPort, t.status, t.plan, t.max_employees AS maxEmployees,
            d.employee_id
       FROM tenant_login_directory d
       JOIN tenants t ON t.id = d.tenant_id
      WHERE d.id_type = ? AND d.identifier = ? AND d.is_active = TRUE
        AND t.status = 'active'
      ORDER BY t.name`,
    [idType, identifier],
  );
  return rows.map(r => ({
    tenant: {
      id: r.id, code: r.code, name: r.name, dbName: r.dbName,
      dbHost: r.dbHost, dbPort: r.dbPort, status: r.status,
      plan: r.plan, maxEmployees: r.maxEmployees,
    },
    employeeId: Number(r.employee_id),
  }));
}

export type LoginRoute =
  | { kind: 'one'; tenant: TenantRecord; employeeId: number }
  | { kind: 'choose'; options: Array<{ code: string; name: string }> }
  | { kind: 'none' };

/**
 * Where a sign-in should go.
 *
 * `emp_id` is NOT unique across tenants — two customers will both have an
 * `ADMIN001`. So an ambiguous identifier is answered with a choice, never a
 * guess: guessing would hand somebody another company's login prompt and,
 * worse, tell them that company exists.
 *
 * A tenant code supplied by the client settles it outright, which is how a
 * later mobile build will sign in. Today's build sends none, and today there
 * is one tenant, so it takes the `one` branch and behaves exactly as before.
 */
export async function routeLogin(params: {
  idType: 'emp_id' | 'email';
  identifier: string;
  tenantCode?: string | null;
}): Promise<LoginRoute> {
  const { idType, identifier, tenantCode } = params;
  const matches = await tenantsForLogin(idType, identifier);
  if (matches.length === 0) return { kind: 'none' };

  if (tenantCode) {
    const picked = matches.find(m => m.tenant.code === tenantCode);
    // A code that does not match is 'none', not 'choose'. Listing the tenants
    // this identifier DOES belong to would answer a question the caller has
    // no business asking.
    return picked
      ? { kind: 'one', tenant: picked.tenant, employeeId: picked.employeeId }
      : { kind: 'none' };
  }

  if (matches.length === 1) {
    return { kind: 'one', tenant: matches[0].tenant, employeeId: matches[0].employeeId };
  }

  return {
    kind: 'choose',
    options: matches.map(m => ({ code: m.tenant.code, name: m.tenant.name })),
  };
}

/**
 * Keep the routing directory in step. Called whenever an employee is created,
 * has their emp_id or email changed, or is deactivated.
 *
 * The directory is a routing table, not a source of truth — it can be rebuilt
 * from the tenant databases at any time, which is what makes it safe for it to
 * drift briefly rather than needing a distributed transaction.
 */
export async function upsertLoginDirectory(params: {
  tenantId: number;
  employeeId: number;
  empId: string;
  email?: string | null;
  isActive?: boolean;
}): Promise<void> {
  const { tenantId, employeeId, empId, email = null, isActive = true } = params;
  await rq(
    `INSERT INTO tenant_login_directory (tenant_id, id_type, identifier, employee_id, is_active)
     VALUES (?, 'emp_id', ?, ?, ?)
     ON DUPLICATE KEY UPDATE employee_id = VALUES(employee_id), is_active = VALUES(is_active)`,
    [tenantId, empId, employeeId, isActive],
  );
  if (email) {
    await rq(
      `INSERT INTO tenant_login_directory (tenant_id, id_type, identifier, employee_id, is_active)
       VALUES (?, 'email', ?, ?, ?)
       ON DUPLICATE KEY UPDATE employee_id = VALUES(employee_id), is_active = VALUES(is_active)`,
      [tenantId, email.toLowerCase(), employeeId, isActive],
    );
  }
}

export async function registryQuery<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return rq<T>(sql, params);
}

export async function closeRegistryPool(): Promise<void> {
  const p = globalForRegistry.__registryPool;
  if (!p) return;
  globalForRegistry.__registryPool = undefined;
  await p.end().catch(() => { /* shutting down */ });
}

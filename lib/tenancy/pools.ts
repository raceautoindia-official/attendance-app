import mysql from 'mysql2/promise';
import { requireTenant, type TenantContext } from './context';

/**
 * lib/tenancy/pools.ts — one connection pool per tenant, within a budget.
 *
 * A MEASURED CONSTRAINT, not a hypothetical. This MySQL reports
 * `max_connections = 151`. The single-tenant pool was 10, which was fine for
 * one database and fatal for fifteen: 15 x 10 exhausts the server and every
 * tenant fails at once.
 *
 * So two rules:
 *
 *   1. **Small pools.** A tenant is a few dozen people, not a few thousand.
 *      Three connections is generous for that, and 20 active tenants x 3 = 60
 *      leaves room for the registry, for migrations and for a human with a
 *      mysql prompt open.
 *
 *   2. **Evict the idle.** Registered tenants outnumber active ones by a wide
 *      margin — most customers are asleep at any moment. Pools are closed
 *      least-recently-used once the cap is reached, so the budget tracks
 *      concurrent activity rather than how many customers have signed up.
 *
 * Reopening an evicted pool costs one connection handshake. Running out of
 * connections costs every tenant at once. The trade is not close.
 */

/** Per tenant. Deliberately far below the old single-tenant 10. */
const PER_TENANT_CONNECTION_LIMIT = Number(process.env.TENANT_POOL_SIZE) || 3;

/** How many tenant pools may stay open. Budget is this x the limit above. */
const MAX_OPEN_POOLS = Number(process.env.TENANT_POOL_MAX_OPEN) || 20;

interface Entry {
  pool: mysql.Pool;
  dbName: string;
  lastUsed: number;
}

/**
 * Cached on globalThis for the same reason the single pool now is: in
 * development Next.js re-evaluates this module on every hot reload, and a new
 * map each time would abandon every pool in the old one. That is how this
 * project reached 153 connections against a limit of 151.
 */
const globalForPools = globalThis as unknown as {
  __tenantPools?: Map<number, Entry>;
};
const pools: Map<number, Entry> = globalForPools.__tenantPools ?? new Map();
if (process.env.NODE_ENV !== 'production') globalForPools.__tenantPools = pools;

function createPool(tenant: TenantContext): mysql.Pool {
  return mysql.createPool({
    host: tenant.dbHost ?? process.env.DB_HOST ?? 'localhost',
    port: tenant.dbPort ?? (Number(process.env.DB_PORT) || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: tenant.dbName,
    waitForConnections: true,
    connectionLimit: PER_TENANT_CONNECTION_LIMIT,
    queueLimit: 0,
    dateStrings: false,
    // Every tenant reads and writes UTC, exactly as the single-tenant pool
    // did. A tenant in another timezone displays differently; it does not
    // store differently.
    timezone: '+00:00',
  });
}

/** Close the least recently used pools until we are back inside the cap. */
async function evictIfNeeded(): Promise<void> {
  while (pools.size > MAX_OPEN_POOLS) {
    let oldestId: number | null = null;
    let oldestAt = Infinity;
    for (const [id, entry] of pools) {
      if (entry.lastUsed < oldestAt) {
        oldestAt = entry.lastUsed;
        oldestId = id;
      }
    }
    if (oldestId === null) return;
    const victim = pools.get(oldestId)!;
    pools.delete(oldestId);
    // Closing can reject if a connection is mid-flight. The pool is already
    // unreachable by then, so the only thing left to do is not crash the
    // request that happened to trigger the eviction.
    victim.pool.end().catch(() => { /* already detached */ });
  }
}

/** The pool for the tenant in context. Throws when there is none. */
export async function tenantPool(): Promise<mysql.Pool> {
  const tenant = requireTenant('tenantPool()');
  return poolForTenant(tenant);
}

/** The pool for a named tenant. Used by fleet jobs, which have no context. */
export async function poolForTenant(tenant: TenantContext): Promise<mysql.Pool> {
  const existing = pools.get(tenant.id);
  if (existing) {
    // A tenant moved to another host or database keeps its id, so the cached
    // pool would quietly keep talking to the old place.
    if (existing.dbName === tenant.dbName) {
      existing.lastUsed = Date.now();
      return existing.pool;
    }
    pools.delete(tenant.id);
    existing.pool.end().catch(() => { /* replaced */ });
  }

  const pool = createPool(tenant);
  pools.set(tenant.id, { pool, dbName: tenant.dbName, lastUsed: Date.now() });
  await evictIfNeeded();
  return pool;
}

/** For the provider console and for tests. */
export function openPoolStats(): { open: number; cap: number; perPool: number } {
  return { open: pools.size, cap: MAX_OPEN_POOLS, perPool: PER_TENANT_CONNECTION_LIMIT };
}

/** Close everything. Used by scripts so a test run does not leak connections. */
export async function closeAllTenantPools(): Promise<void> {
  const entries = [...pools.values()];
  pools.clear();
  await Promise.allSettled(entries.map(e => e.pool.end()));
}

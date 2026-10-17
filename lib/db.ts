// Validate required environment variables at startup — throws with a
// descriptive message if any are missing (skipped during `next build`).
import './env';

import mysql from 'mysql2/promise';

/**
 * In development Next.js re-evaluates a module on every hot reload. Calling
 * createPool at module scope therefore builds a NEW pool of connectionLimit
 * sockets each time and abandons the previous one, which still holds its
 * connections open. An afternoon of editing exhausts MySQL's max_connections
 * and the app starts failing with ER_CON_COUNT_ERROR for reasons nothing in
 * the code suggests.
 *
 * Production never hits this - the module is instantiated once and there is no
 * HMR - so the pool is cached on globalThis only outside production, leaving
 * the production path exactly as it was.
 */
const globalForDb = globalThis as unknown as { __attendancePool?: mysql.Pool };

const pool = globalForDb.__attendancePool ?? mysql.createPool({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // Return JS Date objects for DATETIME/DATE columns
  dateStrings: false,
  // Always read/write as UTC — the app layer handles IST conversion
  timezone: '+00:00',
});

if (process.env.NODE_ENV !== 'production') globalForDb.__attendancePool = pool;

// Verify connectivity at startup (non-fatal — the pool retries on first use).
pool
  .getConnection()
  .then(conn => conn.release())
  .catch(err => {
    console.error('[db] Initial connection test failed:', err.message);
  });

/**
 * WHICH DATABASE A QUERY RUNS AGAINST.
 *
 * This is the whole tenant boundary. Every one of the application's ~130 SQL
 * call sites already funnels through query()/queryOne(), so placing the
 * boundary here means a forgotten filter can only ever show a tenant its own
 * data - the other tenants' rows are not reachable from this connection.
 *
 * Two modes, chosen by deployment and never per request:
 *
 *   MULTI_TENANT unset or '0' - LEGACY. One database, the pool above, exactly
 *     as before. This is what production runs today and what the 823 existing
 *     checks run against. It is not a fallback; it is a single-tenant
 *     deployment, which is a true description of the current server.
 *
 *   MULTI_TENANT='1' - the tenant comes from async context and there is NO
 *     default. Work that reaches here without one throws. A fallback would be
 *     the bug this entire design exists to prevent: some path loses its
 *     context, quietly reads whichever tenant is first, and nobody notices
 *     until a customer sees a name they do not employ.
 *
 * The flag flips once every route establishes context. Until then the two
 * modes let the boundary be built and tested without a flag day.
 */
const MULTI_TENANT = process.env.MULTI_TENANT === '1';

async function activePool(): Promise<mysql.Pool> {
  if (!MULTI_TENANT) return pool;
  // Imported lazily so a single-tenant deployment never loads the tenancy
  // layer at all, and so this module stays importable by scripts that have no
  // registry to talk to.
  const { tenantPool } = await import('@/lib/tenancy/pools');
  return tenantPool();
}

/** The pool for the current tenant, for the few places that need a transaction. */
export async function connectionPool(): Promise<mysql.Pool> {
  return activePool();
}

/**
 * Run a parameterised query and return all matching rows typed as T[].
 * Prefer this over raw pool.execute for routine SELECT / INSERT / UPDATE.
 */
export async function query<T>(sql: string, params?: unknown[]): Promise<T[]> {
  // pool.query() uses the text protocol — it handles all value types including
  // LIMIT/OFFSET integers correctly. pool.execute() (prepared statements) rejects
  // numeric LIMIT/OFFSET params with ER_WRONG_ARGUMENTS in mysql2.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [rows] = await (await activePool()).query(sql, params as any[]);
  return rows as T[];
}

/**
 * Run a parameterised query and return the first row, or null when no rows
 * match. Handy for look-ups by unique key (e.g. find user by emp_id).
 */
export async function queryOne<T>(
  sql: string,
  params?: unknown[],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/**
 * Fire-and-forget audit log insert. Errors are logged but never re-thrown so
 * that an audit failure never breaks the primary operation.
 */
export async function insertAuditLog(params: {
  action: string;
  entity: string;
  entity_id?: number | null;
  performed_by?: number | null;
  details?: Record<string, unknown> | null;
  ip_address?: string | null;
}): Promise<void> {
  try {
    await query(
      // created_at explicitly, in UTC. The column default is CURRENT_TIMESTAMP,
      // which is whatever timezone the DATABASE SERVER happens to run in — UTC
      // on the production host, IST on a local dev box. Every other datetime in
      // this schema is written as explicit UTC; the audit log was the one
      // exception, and on a non-UTC server its entries land shifted against the
      // very events they narrate.
      `INSERT INTO audit_log
         (action, entity, entity_id, performed_by, details, ip_address, created_at)
       VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
      [
        params.action,
        params.entity,
        params.entity_id ?? null,
        params.performed_by ?? null,
        params.details !== undefined && params.details !== null
          ? JSON.stringify(params.details)
          : null,
        params.ip_address ?? null,
      ],
    );
  } catch (err) {
    console.error('[db] insertAuditLog failed:', err);
  }
}

/**
 * The raw pool is exported for operations that need a dedicated connection:
 * transactions, batch inserts, or streaming large result sets.
 *
 * Usage pattern:
 *   const conn = await pool.getConnection();
 *   await conn.beginTransaction();
 *   try {
 *     await conn.execute(...);
 *     await conn.execute(...);
 *     await conn.commit();
 *   } catch (err) {
 *     await conn.rollback();
 *     throw err;
 *   } finally {
 *     conn.release();
 *   }
 */
export { pool };

// ---------------------------------------------------------------------------
// Graceful shutdown — drain the connection pool before the process exits.
// Prevents "Cannot enqueue Query after invoking quit" errors in PM2 cluster.
// ---------------------------------------------------------------------------

let _shutdownRegistered = false;

if (!_shutdownRegistered && typeof process !== 'undefined') {
  _shutdownRegistered = true;

  const graceful = (signal: string) => async () => {
    console.log(`[db] Received ${signal} — closing connection pool…`);
    try {
      await pool.end();
      console.log('[db] Pool closed cleanly.');
    } catch (err) {
      console.error('[db] Error closing pool:', err);
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', graceful('SIGTERM'));
  process.on('SIGINT', graceful('SIGINT'));
}

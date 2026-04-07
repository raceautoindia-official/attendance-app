// Validate required environment variables at startup — throws with a
// descriptive message if any are missing (skipped during `next build`).
import './env';

import mysql from 'mysql2/promise';

const pool = mysql.createPool({
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

// Verify connectivity at startup (non-fatal — the pool retries on first use).
pool
  .getConnection()
  .then(conn => conn.release())
  .catch(err => {
    console.error('[db] Initial connection test failed:', err.message);
  });

/**
 * Run a parameterised query and return all matching rows typed as T[].
 * Prefer this over raw pool.execute for routine SELECT / INSERT / UPDATE.
 */
export async function query<T>(sql: string, params?: unknown[]): Promise<T[]> {
  // pool.query() uses the text protocol — it handles all value types including
  // LIMIT/OFFSET integers correctly. pool.execute() (prepared statements) rejects
  // numeric LIMIT/OFFSET params with ER_WRONG_ARGUMENTS in mysql2.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [rows] = await pool.query(sql, params as any[]);
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
      `INSERT INTO audit_log
         (action, entity, entity_id, performed_by, details, ip_address)
       VALUES (?, ?, ?, ?, ?, ?)`,
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

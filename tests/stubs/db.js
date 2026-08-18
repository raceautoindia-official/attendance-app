// A stand-in for lib/db that behaves like a database WITHOUT the optional
// migrations, and hands JSON columns back the way mysql2 really does on the
// production pool — already parsed, as objects.
//
// Both halves matter. A column that has not been migrated must produce
// ER_BAD_FIELD_ERROR exactly as MySQL would, so a test can prove the route
// never names it; and details arriving as an object is what silently emptied
// every timeline event.

const MISSING_COLUMNS = new Set();

/** Columns this fake database does NOT have. */
function setMissingColumns(names) {
  MISSING_COLUMNS.clear();
  for (const n of names) MISSING_COLUMNS.add(n);
}

const queries = [];
let auditRows = [];
let attendanceRow = null;

function setAuditRows(rows) { auditRows = rows; }
function setAttendanceRow(row) { attendanceRow = row; }
function recorded() { return queries.slice(); }
function reset() { queries.length = 0; }

function guard(sql) {
  // The migration probe asks about the column by NAME, in a string literal.
  // Asking whether a column exists is exactly the thing that must not fail.
  if (/INFORMATION_SCHEMA/i.test(sql)) return;
  for (const col of MISSING_COLUMNS) {
    // Only a BARE mention counts. `NULL AS out_of_fence_reason` is the guarded
    // form and is exactly what the route should emit — an alias is not a read.
    const stripped = sql.replace(new RegExp(`AS\\s+${col}\\b`, 'gi'), '');
    if (new RegExp(`\\b(?:[a-z]+\\.)?${col}\\b`, 'i').test(stripped)) {
      const err = new Error(`Unknown column '${col}' in 'field list'`);
      err.code = 'ER_BAD_FIELD_ERROR';
      err.errno = 1054;
      throw err;
    }
  }
}

/**
 * MySQL returns the CONSTANT for `NULL AS out_of_fence_reason`, not the stored
 * value — the whole point of a guarded SELECT. Without this the stub would hand
 * back the row as written and a test could not tell a guard from a read.
 */
function withSelectConstants(sql, row) {
  const out = { ...row };
  const alias = /(NULL|\d+)\s+AS\s+([a-z_]+)/gi;
  let m;
  while ((m = alias.exec(sql)) !== null) {
    out[m[2]] = m[1].toUpperCase() === 'NULL' ? null : Number(m[1]);
  }
  return out;
}

async function query(sql, params) {
  queries.push(sql);
  guard(sql);

  if (/INFORMATION_SCHEMA\.COLUMNS/i.test(sql)) {
    // Which column is this guard asking about?
    const m = /COLUMN_NAME\s*=\s*'([a-z_]+)'/i.exec(sql);
    const col = m ? m[1] : '';
    return [{ c: MISSING_COLUMNS.has(col) ? 0 : 1 }];
  }
  if (/FROM\s+audit_log/i.test(sql)) return auditRows;
  if (/FROM\s+attendance/i.test(sql)) {
    return attendanceRow ? [withSelectConstants(sql, attendanceRow)] : [];
  }
  if (/FROM\s+live_tracking_points/i.test(sql)) {
    return [{ points: 0, first_utc: null, last_utc: null }];
  }
  if (/FROM\s+employees/i.test(sql)) return [{ name: 'Shankar ganesh', emp_id: 'RACE018' }];
  return [];
}

async function queryOne(sql, params) {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

async function insertAuditLog() {}

module.exports = {
  query, queryOne, insertAuditLog,
  setMissingColumns, setAuditRows, setAttendanceRow, recorded, reset,
};

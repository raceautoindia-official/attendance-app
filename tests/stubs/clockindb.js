// A database for the clock-in route: enough rows for a clock-in to succeed,
// with the one thing under test — whether an OPEN session exists — settable.

let openSession = null;
let inserted = null;
const queries = [];

function setOpenSession(row) { openSession = row; }
function insertedRow() { return inserted; }
function recorded() { return queries.slice(); }
function reset() { openSession = null; inserted = null; queries.length = 0; }

async function query(sql, params) {
  queries.push(sql);

  // Migration probes: this database has every column.
  if (/INFORMATION_SCHEMA/i.test(sql)) return [{ c: 1 }];

  // The duplicate guard.
  if (/FROM\s+attendance/i.test(sql) && /clock_out_utc\s+IS\s+NULL/i.test(sql)) {
    return openSession ? [openSession] : [];
  }
  // Today's row, looked up to be converted in place. There is none: the point
  // of these cases is the OPEN session on another day.
  if (/FROM\s+attendance\s+WHERE\s+employee_id\s*=\s*\?\s*AND\s+work_date/i.test(sql)) {
    return [];
  }
  if (/INSERT\s+INTO\s+attendance/i.test(sql)) {
    inserted = params;
    return { insertId: 501 };
  }
  if (/FROM\s+attendance/i.test(sql)) return [];

  // No fence, no shift roster: a flexible-time employee with nothing to be
  // late for, which is how the production employees are actually configured.
  if (/FROM\s+employee_schedules/i.test(sql)) return [];
  if (/FROM\s+employees/i.test(sql)) {
    return [{ work_mode: 'on_site', allow_multiple_sessions: 0, name: 'Nalini', emp_id: 'RACE0xx' }];
  }
  if (/FROM\s+audit_log/i.test(sql)) return [];
  if (/FROM\s+permission_requests/i.test(sql)) return [];
  if (/UPDATE\s+/i.test(sql)) return { affectedRows: 1 };
  return [];
}

async function queryOne(sql, params) {
  const rows = await query(sql, params);
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}

async function insertAuditLog() {}

module.exports = {
  query, queryOne, insertAuditLog,
  setOpenSession, insertedRow, recorded, reset,
};

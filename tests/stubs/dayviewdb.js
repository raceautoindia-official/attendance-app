// One query matters to the day view test: the big per-employee SELECT. Whatever
// rows are set are what it returns.
let rows = [];
function setRows(r) { rows = r; }
function reset() { rows = []; }

async function query(sql) {
  if (/INFORMATION_SCHEMA/i.test(sql)) return [{ c: 1 }];
  if (/FROM\s+employees\s+e/i.test(sql)) return rows;
  return [];
}
async function queryOne(sql, p) {
  const r = await query(sql, p);
  return Array.isArray(r) ? (r[0] ?? null) : null;
}
async function insertAuditLog() {}
module.exports = { query, queryOne, insertAuditLog, setRows, reset };

// A database for the clock-out route: one open session, and control over
// whether the employee is fenced at all.
let fencedRows = 0;
const audits = [];
const updates = [];

function setFenced(n) { fencedRows = n; }
function auditEntries() { return audits.slice(); }
function attendanceUpdates() { return updates.slice(); }
function reset() { fencedRows = 0; audits.length = 0; updates.length = 0; }

async function query(sql, params) {
  if (/INFORMATION_SCHEMA/i.test(sql)) return [{ c: 1 }];
  if (/FROM\s+employee_schedules\s+es/i.test(sql)) return [{ n: fencedRows }];
  if (/^\s*UPDATE\s+attendance/i.test(sql)) { updates.push({ sql, params }); return { affectedRows: 1 }; }
  if (/FROM\s+attendance/i.test(sql)) {
    return [{
      id: 900, employee_id: 1, work_date: '2026-08-18',
      clock_in_utc: new Date(Date.now() - 8 * 3600_000),
      clock_out_utc: null, status: 'present',
      end_time: null, shift_type: null, grace_minutes: null,
      banked_minutes: 0, session_count: 1, first_clock_in_utc: null,
    }];
  }
  if (/FROM\s+employees/i.test(sql)) return [{ id: 1, emp_id: 'RACE001', name: 'Nalini' }];
  return [];
}
async function queryOne(sql, p) {
  const r = await query(sql, p);
  return Array.isArray(r) ? (r[0] ?? null) : null;
}
async function insertAuditLog(e) { audits.push(e); }
module.exports = { query, queryOne, insertAuditLog, setFenced, auditEntries, attendanceUpdates, reset };

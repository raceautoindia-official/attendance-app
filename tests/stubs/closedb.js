// A database for the end-of-day settling sweep. One employee, one forgotten
// clock-out, and control over the two things that decide what it is worth:
// whether the phone left any tracking fixes, and what a normal day is for them.

let pending = [];
let lastFixUtc = null;      // Date | null — the phone's final report
const updates = [];         // { id, clock_out_utc, total_minutes }
const audits = [];

function setPending(rows) { pending = rows; }
function setLastFix(d) { lastFixUtc = d; }
function updated() { return updates.slice(); }
function auditEntries() { return audits.slice(); }
function reset() { pending = []; lastFixUtc = null; updates.length = 0; audits.length = 0; }

async function query(sql, params) {
  if (/INFORMATION_SCHEMA/i.test(sql)) return [{ c: 1 }];

  // The rows about to be settled.
  if (/FROM\s+attendance\s+a\s+WHERE/i.test(sql)) return pending;

  // Read back for the audit entries.
  if (/JOIN\s+employees\s+e\s+ON\s+e\.id\s*=\s*a\.employee_id/i.test(sql)
      && /a\.total_minutes/i.test(sql)) {
    return pending.map(p => {
      const u = updates.find(x => x.id === p.id);
      return {
        id: p.id,
        employee_id: p.employee_id,
        emp_id: 'RACE001',
        name: 'Nalini',
        work_date: p.work_date,
        clock_in_utc: p.clock_in_utc,
        clock_out_utc: u ? u.clock_out_utc : null,
        total_minutes: u ? u.total_minutes : null,
        banked_minutes: 0,
      };
    });
  }

  if (/UPDATE\s+attendance/i.test(sql) && /clock_out_utc\s*=\s*\?/i.test(sql)) {
    updates.push({ clock_out_utc: params[0], total_minutes: params[1], id: params[2] });
    return { affectedRows: 1 };
  }

  // Carry-over check and the tracking-session sweep: nothing to do.
  if (/live_tracking_sessions/i.test(sql)) return [];
  if (/FROM\s+live_tracking_points/i.test(sql)) return [];
  return [];
}

async function queryOne(sql, params) {
  if (/MAX\(tracked_at_utc\)/i.test(sql)) return { at: lastFixUtc };
  const rows = await query(sql, params);
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}

async function insertAuditLog(entry) { audits.push(entry); }

module.exports = {
  query, queryOne, insertAuditLog,
  setPending, setLastFix, updated, auditEntries, reset,
};

// A database for the geofence watchdog. One fenced employee, clocked in, and
// control over the only thing the rule turns on: what their phone confirmed.

let candidate = null;
let lastInsideFix = null;   // Date | null — last fix that landed inside
const updates = [];
const audits = [];

function setCandidate(c) { candidate = c; }
function setLastInsideFix(d) { lastInsideFix = d; }
function attendanceUpdates() { return updates.filter(u => /UPDATE attendance/i.test(u.sql)); }
function auditEntries() { return audits.slice(); }
function reset() { candidate = null; lastInsideFix = null; updates.length = 0; audits.length = 0; }

async function query(sql, params) {
  if (/INFORMATION_SCHEMA/i.test(sql)) return [{ c: 1 }];
  if (/FROM\s+employees\s*$|role IN \('super_admin'/i.test(sql)) return [];
  if (/FROM\s+attendance\s+a[\s\S]*employee_schedules/i.test(sql)) {
    return candidate ? [candidate] : [];
  }
  if (/FROM\s+live_tracking_points/i.test(sql)) {
    return lastInsideFix ? [{ tracked_at_utc: lastInsideFix, latitude: 13.0, longitude: 80.0 }] : [];
  }
  if (/FROM\s+live_tracking_sessions\s+s/i.test(sql)) return [];
  if (/^\s*UPDATE/i.test(sql)) { updates.push({ sql, params }); return { affectedRows: 1 }; }
  if (/FROM\s+audit_log/i.test(sql)) {
    // the once-per-day guard, and the stale-alert cooldown
    return [{ n: audits.some(a => a.action === 'geofence_presence_unverifiable') ? 1 : 0, total: 0 }];
  }
  if (/FROM\s+permission_requests/i.test(sql)) return [];
  return [];
}

async function queryOne(sql, params) {
  const rows = await query(sql, params);
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}

async function insertAuditLog(e) { audits.push(e); }

module.exports = {
  query, queryOne, insertAuditLog,
  setCandidate, setLastInsideFix, attendanceUpdates, auditEntries, reset,
};

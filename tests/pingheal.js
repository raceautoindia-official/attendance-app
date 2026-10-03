// A phone that can prove where an on-shift employee is must never be refused.
//
// The whole fleet went dark at once, and this is the mechanism: the stale
// monitor ended any session quiet for 3 minutes (doze, a lift, a network
// blip), after which every later fix from that phone bounced off "no active
// live-tracking session" — a 404 — for the rest of the day. A 3-minute gap
// became permanent silence, for every employee at once.
//
// Two rules fix it, and this test pins both:
//   1. ping SELF-HEALS: no session + clocked in + tracking enabled → a session
//      is created and the points land. The phone does not need to understand
//      sessions to be tracked.
//   2. Staleness is REPORTED, never executed: the monitor alerts about a quiet
//      phone but leaves the session alive, and only alerts about people who
//      are actually on shift.
//
//   node tests/pingheal.js
//
// Needs a running server. Everything it touches is restored.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
const mysql = require(path.join(ROOT, 'node_modules', 'mysql2', 'promise'));
const env = {};
for (const l of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2];
}
const BASE = process.env.TEST_BASE_URL || 'http://localhost:3123';
const UA = 'okhttp/4.9.2 AttendanceApp Android';
const EMP = Number(process.env.TEST_EMPLOYEE_ID || 6);
const CRON = process.env.CRON_SECRET || 'test-cron-secret-local-only';

let pass = 0, fail = 0;
const check = (l, c, d) => c
  ? (pass++, console.log(`  PASS  ${l}`))
  : (fail++, console.log(`  FAIL  ${l}${d !== undefined ? ` — ${d}` : ''}`));

const tok = jwt.sign({ id: EMP, emp_id: 'REENA001', role: 'employee', tv: 0 },
  env.JWT_ACCESS_SECRET, { expiresIn: '30m' });
const hdrs = { 'Content-Type': 'application/json', 'user-agent': UA,
               'x-device-id': 'pingheal-phone', Authorization: `Bearer ${tok}` };

const ping = () => fetch(`${BASE}/api/live-tracking/ping`, {
  method: 'POST', headers: hdrs,
  body: JSON.stringify({
    points: [{ latitude: 13.0080078, longitude: 80.1970224, accuracy_meters: 8,
               tracked_at_utc: new Date().toISOString() }],
    device_now_utc: new Date().toISOString(),
  }),
});
const sweep = () => fetch(`${BASE}/api/cron/live-tracking-monitor`,
  { method: 'POST', headers: { 'x-cron-secret': CRON } });

(async () => {
  const c = await mysql.createConnection({
    host: env.DB_HOST, user: env.DB_USER, password: env.DB_PASSWORD,
    database: env.DB_NAME, timezone: '+00:00' });

  const [[origEmp]] = await c.query(
    'SELECT work_mode, live_tracking_enabled FROM employees WHERE id = ?', [EMP]);
  const [origSched] = await c.query(
    `SELECT id, shift_id, location_id, geofencing_enabled, effective_from, effective_to, assigned_by
       FROM employee_schedules WHERE employee_id = ?`, [EMP]);
  const [[wd]] = await c.query(
    "SELECT DATE_FORMAT(DATE(DATE_SUB(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+05:30'), INTERVAL 7 HOUR)),'%Y-%m-%d') AS d");

  const wipe = async () => {
    await c.query('DELETE FROM attendance WHERE employee_id = ?', [EMP]);
    await c.query('DELETE FROM live_tracking_sessions WHERE employee_id = ?', [EMP]);
    await c.query('DELETE FROM employee_devices WHERE employee_id = ?', [EMP]);
  };
  const restore = async () => {
    await wipe();
    await c.query('DELETE FROM employee_schedules WHERE employee_id = ?', [EMP]);
    for (const o of origSched) {
      await c.query(
        `INSERT INTO employee_schedules
           (id, employee_id, shift_id, location_id, geofencing_enabled, effective_from, effective_to, assigned_by)
         VALUES (?,?,?,?,?,?,?,?)`,
        [o.id, EMP, o.shift_id, o.location_id, o.geofencing_enabled,
         o.effective_from, o.effective_to, o.assigned_by]);
    }
    await c.query('UPDATE employees SET work_mode = ?, live_tracking_enabled = ? WHERE id = ?',
      [origEmp.work_mode, origEmp.live_tracking_enabled, EMP]);
  };

  const session = async () => {
    const [[r]] = await c.query(
      `SELECT id, is_active, TIMESTAMPDIFF(MINUTE, last_ping_utc, UTC_TIMESTAMP()) AS ping_age
         FROM live_tracking_sessions WHERE employee_id = ? ORDER BY id DESC LIMIT 1`, [EMP]);
    return r;
  };

  try {
    // Clocked in, tracking on, geofencing OFF (this test is about tracking).
    await c.query('DELETE FROM employee_schedules WHERE employee_id = ?', [EMP]);
    await c.query(
      `INSERT INTO employee_schedules (employee_id, shift_id, location_id, geofencing_enabled, effective_from)
       VALUES (?, (SELECT MIN(id) FROM shifts), NULL, FALSE, '2026-01-01')`, [EMP]);
    await c.query("UPDATE employees SET work_mode='on_site', live_tracking_enabled=TRUE WHERE id=?", [EMP]);
    await wipe();
    await c.query(
      `INSERT INTO attendance (employee_id, work_date, clock_in_utc, status)
       VALUES (?, ?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 120 MINUTE), 'present')`, [EMP, wd.d]);

    console.log('\n1. On shift, session destroyed — the next fix heals it');
    let r = await ping();
    check('the ping is accepted, not 404ed', r.status === 200, r.status);
    let s = await session();
    check('a session now exists and is active', !!s && s.is_active === 1, JSON.stringify(s));
    const [[pts]] = await c.query(
      'SELECT COUNT(*) AS n FROM live_tracking_points WHERE employee_id = ?', [EMP]);
    check('and the point was stored', Number(pts.n) === 1, pts.n);

    console.log('\n2. A quiet spell is reported, never executed');
    await c.query(
      `UPDATE live_tracking_sessions SET last_ping_utc = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 20 MINUTE)
        WHERE employee_id = ? AND is_active = TRUE`, [EMP]);
    r = await sweep();
    check('the sweep runs', r.status === 200, r.status);
    s = await session();
    check('the session SURVIVES going quiet — the fix that un-darkened the fleet',
      !!s && s.is_active === 1, JSON.stringify(s));
    const [[alerted]] = await c.query(
      `SELECT COUNT(*) AS n FROM audit_log
        WHERE action = 'live_tracking_signal_lost'
          AND JSON_EXTRACT(details, '$.employee_id') = ?
          AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 MINUTE)`, [EMP]);
    check('but the silence IS reported to admins', Number(alerted.n) >= 1, alerted.n);

    console.log('\n3. And the phone can resume as if nothing happened');
    r = await ping();
    check('the next fix lands in the same session', r.status === 200, r.status);
    s = await session();
    check('ping age reset', !!s && Number(s.ping_age) <= 1, JSON.stringify(s));

    console.log('\n4. Clocked out means STOP — no healing for a closed day');
    await c.query('UPDATE attendance SET clock_out_utc = UTC_TIMESTAMP(), total_minutes = 120 WHERE employee_id = ?', [EMP]);
    r = await ping();
    check('the ping is refused once the day is over', r.status === 403, r.status);

    console.log('\n5. Silence after clock-out raises no alerts');
    await c.query(
      `UPDATE live_tracking_sessions SET last_ping_utc = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 45 MINUTE)
        WHERE employee_id = ?`, [EMP]);
    await c.query(
      `DELETE FROM audit_log WHERE action = 'live_tracking_signal_lost'
        AND JSON_EXTRACT(details, '$.employee_id') = ?`, [EMP]);
    await sweep();
    const [[quiet]] = await c.query(
      `SELECT COUNT(*) AS n FROM audit_log
        WHERE action = 'live_tracking_signal_lost'
          AND JSON_EXTRACT(details, '$.employee_id') = ?`, [EMP]);
    check('no alert for someone who simply went home', Number(quiet.n) === 0, quiet.n);
  } finally {
    await restore();
    await c.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });

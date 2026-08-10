// The diagnostic must agree with the watchdog. For each gate, break exactly one
// thing and confirm the report names THAT gate — and that the watchdog really
// does leave the person alone.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const mysql = require(path.join(ROOT, 'node_modules', 'mysql2', 'promise'));
const env = {};
for (const l of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2];
}
const BASE = process.env.TEST_BASE_URL || 'http://localhost:3123';
const EMP = 6; // REENA001

let pass = 0, fail = 0;
const check = (l, c, d) => c ? (pass++, console.log(`  PASS  ${l}`)) : (fail++, console.log(`  FAIL  ${l}${d !== undefined ? ` — ${d}` : ''}`));

const SQL = fs.readFileSync(path.join(ROOT, 'database', 'why_no_auto_logout.sql'), 'utf8');

(async () => {
  const c = await mysql.createConnection({
    host: env.DB_HOST, user: env.DB_USER, password: env.DB_PASSWORD,
    database: env.DB_NAME, multipleStatements: true, timezone: '+00:00' });

  const [origSched] = await c.query(
    'SELECT id,shift_id,location_id,geofencing_enabled,effective_from,effective_to,assigned_by FROM employee_schedules WHERE employee_id=?', [EMP]);
  const [[origEmp]] = await c.query(
    'SELECT work_mode, live_tracking_enabled FROM employees WHERE id=?', [EMP]);
  const [[site]] = await c.query('SELECT id FROM locations WHERE is_active=TRUE LIMIT 1');
  const [[wd]] = await c.query(
    "SELECT DATE_FORMAT(DATE(DATE_SUB(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+05:30'), INTERVAL 7 HOUR)),'%Y-%m-%d') AS d");

  // The fully-correct setup: on site, tracking on, fenced location, clocked in
  // 90 minutes ago, no fixes at all (so presence was never confirmed).
  const setup = async () => {
    await c.query('DELETE FROM attendance WHERE employee_id=?', [EMP]);
    await c.query('DELETE FROM employee_schedules WHERE employee_id=?', [EMP]);
    await c.query('DELETE FROM live_tracking_points WHERE employee_id=?', [EMP]);
    await c.query('DELETE FROM live_tracking_sessions WHERE employee_id=?', [EMP]);
    await c.query(
      `INSERT INTO employee_schedules (employee_id, shift_id, location_id, geofencing_enabled, effective_from)
       VALUES (?, (SELECT MIN(id) FROM shifts), ?, TRUE, '2026-01-01')`, [EMP, site.id]);
    await c.query("UPDATE employees SET work_mode='on_site', live_tracking_enabled=TRUE WHERE id=?", [EMP]);
    await c.query(
      `INSERT INTO attendance (employee_id, work_date, clock_in_utc, status, banked_minutes, session_count)
       VALUES (?, ?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 MINUTE), 'present', 0, 1)`, [EMP, wd.d]);
  };

  const verdict = async () => {
    const res = await c.query(SQL);
    const rows = res[0].filter(r => Array.isArray(r))[0] || [];
    const mine = rows.find(r => r.emp_id === 'REENA001');
    return mine ? mine.verdict : '(not listed)';
  };
  const sweep = async () => {
    await fetch(`${BASE}/api/cron/live-tracking-monitor`,
      { method: 'POST', headers: { 'x-cron-secret': process.env.CRON_SECRET || 'test-cron-secret-local-only' } });
    const [[r]] = await c.query(
      'SELECT clock_out_utc FROM attendance WHERE employee_id=? AND work_date=?', [EMP, wd.d]);
    return r?.clock_out_utc != null;
  };

  console.log('\n0. Everything correct — the watchdog SHOULD act');
  await setup();
  let v = await verdict();
  console.log(`   verdict: ${v}`);
  check('report says it would be clocked out', /WOULD BE CLOCKED OUT/.test(v), v);
  check('and the watchdog actually does', await sweep());

  const cases = [
    ['geofencing OFF',   "UPDATE employee_schedules SET geofencing_enabled=FALSE WHERE employee_id=?", /geofencing OFF/],
    ['no location',      "UPDATE employee_schedules SET location_id=NULL, geofencing_enabled=TRUE WHERE employee_id=?", /no location|geofencing OFF/],
    ['tracking off',     "UPDATE employees SET live_tracking_enabled=FALSE WHERE id=?", /tracking off/],
    ['not on_site',      "UPDATE employees SET work_mode='off_site' WHERE id=?", /not on_site/],
  ];

  let n = 1;
  for (const [label, sql, expect] of cases) {
    console.log(`\n${n++}. Break one thing: ${label}`);
    await setup();
    await c.query(sql, [EMP]);
    v = await verdict();
    console.log(`   verdict: ${v}`);
    check(`report blames "${label}"`, expect.test(v), v);
    check('and the watchdog leaves them clocked in', !(await sweep()));
  }

  console.log('\n5. Clocked in only 5 minutes — inside the grace period');
  await setup();
  await c.query(
    'UPDATE attendance SET clock_in_utc = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 MINUTE) WHERE employee_id=?', [EMP]);
  v = await verdict();
  console.log(`   verdict: ${v}`);
  check('report says within grace', /within grace/.test(v), v);
  check('and the watchdog waits', !(await sweep()));

  console.log('\n6. Seen inside the fence 2 minutes ago — presence is vouched for');
  await setup();
  const [sx] = await c.query(
    'INSERT INTO live_tracking_sessions (employee_id, started_at_utc, is_active) VALUES (?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 MINUTE), TRUE)', [EMP]);
  const [[loc]] = await c.query('SELECT latitude, longitude FROM locations WHERE id=?', [site.id]);
  await c.query(
    'INSERT INTO live_tracking_points (session_id, employee_id, latitude, longitude, accuracy_meters, tracked_at_utc) VALUES (?,?,?,?,10, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 MINUTE))',
    [sx.insertId, EMP, loc.latitude, loc.longitude]);
  v = await verdict();
  console.log(`   verdict: ${v}`);
  check('report says presence was confirmed recently', /seen inside the fence recently/.test(v), v);
  check('and the watchdog correctly leaves them clocked in', !(await sweep()));

  // Restore
  await c.query('DELETE FROM attendance WHERE employee_id=?', [EMP]);
  await c.query('DELETE FROM employee_schedules WHERE employee_id=?', [EMP]);
  for (const o of origSched) {
    await c.query(
      `INSERT INTO employee_schedules (id,employee_id,shift_id,location_id,geofencing_enabled,effective_from,effective_to,assigned_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [o.id, EMP, o.shift_id, o.location_id, o.geofencing_enabled, o.effective_from, o.effective_to, o.assigned_by]);
  }
  await c.query('UPDATE employees SET work_mode=?, live_tracking_enabled=? WHERE id=?',
    [origEmp.work_mode, origEmp.live_tracking_enabled, EMP]);
  await c.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });

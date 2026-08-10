// A 10 m fence must BE 10 m: clock-in refused just outside it, and someone who
// walks 25 m away is auto clocked-out. Previously both were silently 200 m.
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
const EMP = 6;
const RADIUS = 10;

let pass = 0, fail = 0;
const check = (l, c, d) => c ? (pass++, console.log(`  PASS  ${l}`)) : (fail++, console.log(`  FAIL  ${l}${d !== undefined ? ` — ${d}` : ''}`));

const tok = jwt.sign({ id: EMP, emp_id: 'REENA001', role: 'employee', tv: 0 },
  env.JWT_ACCESS_SECRET, { expiresIn: '30m' });
const hdrs = { 'Content-Type': 'application/json', 'user-agent': UA,
               'x-device-id': 'tight-phone', Authorization: `Bearer ${tok}` };
const north = (lat, m) => lat + m / 111320;

(async () => {
  const c = await mysql.createConnection({
    host: env.DB_HOST, user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME, timezone: '+00:00' });
  const [origSched] = await c.query(
    'SELECT id,shift_id,location_id,geofencing_enabled,effective_from,effective_to,assigned_by FROM employee_schedules WHERE employee_id=?', [EMP]);
  const [[origEmp]] = await c.query('SELECT work_mode, live_tracking_enabled FROM employees WHERE id=?', [EMP]);
  const [[site]] = await c.query('SELECT id, latitude, longitude, radius_meters FROM locations WHERE is_active=TRUE LIMIT 1');
  const origRadius = site.radius_meters;
  const LAT = Number(site.latitude), LNG = Number(site.longitude);
  const [[wd]] = await c.query(
    "SELECT DATE_FORMAT(DATE(DATE_SUB(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+05:30'), INTERVAL 7 HOUR)),'%Y-%m-%d') AS d");

  await c.query('UPDATE locations SET radius_meters = ? WHERE id = ?', [RADIUS, site.id]);
  await c.query('DELETE FROM employee_schedules WHERE employee_id=?', [EMP]);
  await c.query(
    `INSERT INTO employee_schedules (employee_id, shift_id, location_id, geofencing_enabled, effective_from)
     VALUES (?, (SELECT MIN(id) FROM shifts), ?, TRUE, '2026-01-01')`, [EMP, site.id]);
  await c.query("UPDATE employees SET work_mode='on_site', live_tracking_enabled=TRUE WHERE id=?", [EMP]);
  const wipe = async () => {
    await c.query('DELETE FROM attendance WHERE employee_id=?', [EMP]);
    await c.query('DELETE FROM live_tracking_points WHERE employee_id=?', [EMP]);
    await c.query('DELETE FROM live_tracking_sessions WHERE employee_id=?', [EMP]);
    await c.query('DELETE FROM employee_devices WHERE employee_id=?', [EMP]);
  };
  await wipe();

  console.log(`   fence set to ${RADIUS} m`);

  console.log('\n1. The phone is told the real radius');
  const today = await (await fetch(`${BASE}/api/attendance/today`, { headers: hdrs })).json();
  const sent = today.data?.schedule?.location?.radius_meters;
  console.log(`   radius sent to phone: ${sent}`);
  check('no hidden widening', Number(sent) === RADIUS, sent);

  console.log('\n2. Clock-in from 5 m away — inside');
  const clockIn = (m) => fetch(`${BASE}/api/attendance/clock-in`, {
    method: 'POST', headers: hdrs, body: JSON.stringify({ latitude: north(LAT, m), longitude: LNG }) });
  let r = await clockIn(5);
  let j = await r.json();
  console.log(`   ${r.status} ${j.error ?? 'accepted'}`);
  check('accepted', r.status === 201, `${r.status} ${j.error ?? ''}`);

  console.log('\n3. Clock-in from 60 m away — OUTSIDE a 10 m fence');
  await wipe();
  r = await clockIn(60);
  j = await r.json();
  console.log(`   ${r.status} ${j.error ?? ''}`);
  check('refused — the 10 m fence is real now', r.status === 403, r.status);
  check('the message quotes the configured radius', /within 10 m/.test(j.error ?? ''), j.error);

  console.log('\n4. Walk 25 m away mid-shift — the watchdog ends the day');
  await wipe();
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString().slice(0, 19).replace('T', ' ');
  await c.query(
    `INSERT INTO attendance (employee_id, work_date, clock_in_utc, status, banked_minutes, session_count)
     VALUES (?, ?, ?, 'present', 0, 1)`, [EMP, wd.d, ago(120)]);
  const [sess] = await c.query(
    `INSERT INTO live_tracking_sessions (employee_id, started_at_utc, is_active, last_ping_utc)
     VALUES (?, ?, TRUE, ?)`, [EMP, ago(120), ago(1)]);
  // Inside 90 min ago, then 25 m away ever since — outside a 10 m fence.
  await c.query(
    `INSERT INTO live_tracking_points (session_id, employee_id, latitude, longitude, accuracy_meters, tracked_at_utc)
     VALUES (?,?,?,?,5,?)`, [sess.insertId, EMP, LAT, LNG, ago(90)]);
  for (const m of [60, 30, 10, 1]) {
    await c.query(
      `INSERT INTO live_tracking_points (session_id, employee_id, latitude, longitude, accuracy_meters, tracked_at_utc)
       VALUES (?,?,?,?,5,?)`, [sess.insertId, EMP, north(LAT, 25), LNG, ago(m)]);
  }
  const sweepRes = await (await fetch(`${BASE}/api/cron/live-tracking-monitor`,
    { method: 'POST', headers: { 'x-cron-secret': process.env.CRON_SECRET || 'test-cron-secret-local-only' } })).json();
  console.log(`   sweep: ${JSON.stringify(sweepRes)}`);
  const [[row]] = await c.query(
    'SELECT clock_out_utc, total_minutes FROM attendance WHERE employee_id=? AND work_date=?', [EMP, wd.d]);
  check('25 m away IS outside a 10 m fence — clocked out', row?.clock_out_utc != null, JSON.stringify(row));
  check('credited only up to the last confirmed presence (~30 min)',
    row?.total_minutes != null && Math.abs(Number(row.total_minutes) - 30) <= 3, row?.total_minutes);

  console.log('\n5. Sitting inside the fence is left alone');
  await wipe();
  await c.query(
    `INSERT INTO attendance (employee_id, work_date, clock_in_utc, status, banked_minutes, session_count)
     VALUES (?, ?, ?, 'present', 0, 1)`, [EMP, wd.d, ago(120)]);
  const [sess2] = await c.query(
    `INSERT INTO live_tracking_sessions (employee_id, started_at_utc, is_active, last_ping_utc)
     VALUES (?, ?, TRUE, ?)`, [EMP, ago(120), ago(1)]);
  await c.query(
    `INSERT INTO live_tracking_points (session_id, employee_id, latitude, longitude, accuracy_meters, tracked_at_utc)
     VALUES (?,?,?,?,3,?)`, [sess2.insertId, EMP, north(LAT, 3), LNG, ago(2)]);
  await fetch(`${BASE}/api/cron/live-tracking-monitor`,
    { method: 'POST', headers: { 'x-cron-secret': process.env.CRON_SECRET || 'test-cron-secret-local-only' } });
  const [[stay]] = await c.query(
    'SELECT clock_out_utc FROM attendance WHERE employee_id=? AND work_date=?', [EMP, wd.d]);
  check('still on shift', stay?.clock_out_utc == null, stay?.clock_out_utc);

  console.log('\n6. A wildly inaccurate fix cannot vouch from far away');
  // 25 m out with a claimed accuracy of 500 m: the allowance is capped at the
  // fence, so this can excuse at most 10 m and still counts as outside.
  await wipe();
  await c.query(
    `INSERT INTO attendance (employee_id, work_date, clock_in_utc, status, banked_minutes, session_count)
     VALUES (?, ?, ?, 'present', 0, 1)`, [EMP, wd.d, ago(120)]);
  const [sess3] = await c.query(
    `INSERT INTO live_tracking_sessions (employee_id, started_at_utc, is_active, last_ping_utc)
     VALUES (?, ?, TRUE, ?)`, [EMP, ago(120), ago(1)]);
  await c.query(
    `INSERT INTO live_tracking_points (session_id, employee_id, latitude, longitude, accuracy_meters, tracked_at_utc)
     VALUES (?,?,?,?,500,?)`, [sess3.insertId, EMP, north(LAT, 25), LNG, ago(1)]);
  await fetch(`${BASE}/api/cron/live-tracking-monitor`,
    { method: 'POST', headers: { 'x-cron-secret': process.env.CRON_SECRET || 'test-cron-secret-local-only' } });
  const [[fuzzy]] = await c.query(
    'SELECT clock_out_utc FROM attendance WHERE employee_id=? AND work_date=?', [EMP, wd.d]);
  check('a 500 m accuracy claim does not excuse being 25 m out',
    fuzzy?.clock_out_utc != null, fuzzy?.clock_out_utc);

  // Restore
  await wipe();
  await c.query('UPDATE locations SET radius_meters = ? WHERE id = ?', [origRadius, site.id]);
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

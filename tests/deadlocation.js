// A DEACTIVATED location must not fence anybody.
//
// Production has a location at 0,0 that was deactivated — an unfinished record.
// The watchdog already ignored inactive locations, but clock-in did not, so an
// employee still assigned to one would be measured against the middle of the
// Atlantic: refused every clock-in with "you are outside", while the watchdog
// skipped them entirely. Two halves of the system disagreeing.
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

let pass = 0, fail = 0;
const check = (l, c, d) => c ? (pass++, console.log(`  PASS  ${l}`)) : (fail++, console.log(`  FAIL  ${l}${d !== undefined ? ` — ${d}` : ''}`));

const tok = jwt.sign({ id: EMP, emp_id: 'REENA001', role: 'employee', tv: 0 },
  env.JWT_ACCESS_SECRET, { expiresIn: '30m' });
const hdrs = { 'Content-Type': 'application/json', 'user-agent': UA,
               'x-device-id': 'dead-loc-phone', Authorization: `Bearer ${tok}` };

(async () => {
  const c = await mysql.createConnection({
    host: env.DB_HOST, user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME, timezone: '+00:00' });
  const [origSched] = await c.query(
    'SELECT id,shift_id,location_id,geofencing_enabled,effective_from,effective_to,assigned_by FROM employee_schedules WHERE employee_id=?', [EMP]);
  const [[origEmp]] = await c.query('SELECT work_mode, live_tracking_enabled FROM employees WHERE id=?', [EMP]);

  // A deactivated site at 0,0 — exactly production's location id 1.
  await c.query("DELETE FROM locations WHERE name = 'ZZ Dead Site'");
  const [dead] = await c.query(
    `INSERT INTO locations (name, address, latitude, longitude, radius_meters, is_active)
     VALUES ('ZZ Dead Site', 'unfinished record', 0.0000000, 0.0000000, 200, FALSE)`);

  await c.query('DELETE FROM attendance WHERE employee_id=?', [EMP]);
  await c.query('DELETE FROM employee_devices WHERE employee_id=?', [EMP]);
  await c.query('DELETE FROM employee_schedules WHERE employee_id=?', [EMP]);
  await c.query(
    `INSERT INTO employee_schedules (employee_id, shift_id, location_id, geofencing_enabled, effective_from)
     VALUES (?, (SELECT MIN(id) FROM shifts), ?, TRUE, '2026-01-01')`, [EMP, dead.insertId]);
  await c.query("UPDATE employees SET work_mode='on_site', live_tracking_enabled=TRUE WHERE id=?", [EMP]);

  console.log('\n1. The phone is not handed a dead fence');
  const today = await (await fetch(`${BASE}/api/attendance/today`, { headers: hdrs })).json();
  console.log(`   location sent: ${JSON.stringify(today.data?.schedule?.location)}`);
  check('no location is sent for a deactivated site', !today.data?.schedule?.location,
    JSON.stringify(today.data?.schedule?.location));

  console.log('\n2. Clock-in is not measured against 0,0');
  const r = await fetch(`${BASE}/api/attendance/clock-in`, {
    method: 'POST', headers: hdrs,
    body: JSON.stringify({ latitude: 13.0081980, longitude: 80.1970099 }) });
  const j = await r.json();
  console.log(`   ${r.status} ${j.error ?? 'accepted'}`);
  check('not refused with a misleading "you are outside"',
    !/outside/i.test(j.error ?? ''), j.error);
  // Geofencing is on with no USABLE location, so the honest answer is the
  // misconfiguration refusal — not a distance complaint about the Atlantic.
  check('refused as a misconfiguration instead', r.status === 409 && /not been set up/i.test(j.error ?? ''),
    `${r.status} ${j.error ?? ''}`);

  console.log('\n3. Reactivating the site makes it work again');
  await c.query('UPDATE locations SET is_active = TRUE, latitude = 13.0081980, longitude = 80.1970099, radius_meters = 50 WHERE id = ?', [dead.insertId]);
  await c.query('DELETE FROM attendance WHERE employee_id=?', [EMP]);
  const r2 = await fetch(`${BASE}/api/attendance/clock-in`, {
    method: 'POST', headers: hdrs,
    body: JSON.stringify({ latitude: 13.0081980, longitude: 80.1970099 }) });
  const j2 = await r2.json();
  console.log(`   ${r2.status} ${j2.error ?? 'accepted'}`);
  check('clock-in works against an active site', r2.status === 201, `${r2.status} ${j2.error ?? ''}`);

  // Restore
  await c.query('DELETE FROM attendance WHERE employee_id=?', [EMP]);
  await c.query('DELETE FROM employee_devices WHERE employee_id=?', [EMP]);
  await c.query('DELETE FROM employee_schedules WHERE employee_id=?', [EMP]);
  for (const o of origSched) {
    await c.query(
      `INSERT INTO employee_schedules (id,employee_id,shift_id,location_id,geofencing_enabled,effective_from,effective_to,assigned_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [o.id, EMP, o.shift_id, o.location_id, o.geofencing_enabled, o.effective_from, o.effective_to, o.assigned_by]);
  }
  await c.query('UPDATE employees SET work_mode=?, live_tracking_enabled=? WHERE id=?',
    [origEmp.work_mode, origEmp.live_tracking_enabled, EMP]);
  await c.query('DELETE FROM locations WHERE id = ?', [dead.insertId]);
  await c.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });

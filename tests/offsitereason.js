// Clocking in away from the work site, with a reason.
//
// Being outside the fence was simply refused. That is right for someone trying
// it on and wrong for the ordinary case — a delivery, a customer visit, a site
// inspection — where the employee could do nothing at all and no record was
// kept that they had even tried.
//
// They can now clock in by saying why. The day is still recorded as OUTSIDE the
// fence, the reason is stored, an admin is alerted, and the whole thing goes to
// the audit log. It is a recorded exception, not a hole in the fence.
//
//   node tests/offsitereason.js
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
const RADIUS = 100;

let pass = 0, fail = 0;
const check = (l, c, d) => c
  ? (pass++, console.log(`  PASS  ${l}`))
  : (fail++, console.log(`  FAIL  ${l}${d !== undefined ? ` — ${d}` : ''}`));

const tok = jwt.sign({ id: EMP, emp_id: 'REENA001', role: 'employee', tv: 0 },
  env.JWT_ACCESS_SECRET, { expiresIn: '30m' });
const hdrs = { 'Content-Type': 'application/json', 'user-agent': UA,
               'x-device-id': 'offsite-phone', Authorization: `Bearer ${tok}` };
const north = (lat, m) => lat + m / 111320;

(async () => {
  const c = await mysql.createConnection({
    host: env.DB_HOST, user: env.DB_USER, password: env.DB_PASSWORD,
    database: env.DB_NAME, timezone: '+00:00' });

  const [origSched] = await c.query(
    `SELECT id, shift_id, location_id, geofencing_enabled, effective_from, effective_to, assigned_by
       FROM employee_schedules WHERE employee_id = ?`, [EMP]);
  const [[origEmp]] = await c.query(
    'SELECT work_mode, live_tracking_enabled FROM employees WHERE id = ?', [EMP]);
  const [[site]] = await c.query(
    'SELECT id, latitude, longitude, radius_meters FROM locations WHERE is_active = TRUE LIMIT 1');
  const origRadius = site.radius_meters;
  const LAT = Number(site.latitude), LNG = Number(site.longitude);

  const wipe = async () => {
    await c.query('DELETE FROM attendance WHERE employee_id = ?', [EMP]);
    await c.query('DELETE FROM employee_devices WHERE employee_id = ?', [EMP]);
  };

  const restore = async () => {
    await wipe();
    await c.query('DELETE FROM live_tracking_sessions WHERE employee_id = ?', [EMP]);
    await c.query('UPDATE locations SET radius_meters = ? WHERE id = ?', [origRadius, site.id]);
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

  const clockIn = (metresNorth, reason) => fetch(`${BASE}/api/attendance/clock-in`, {
    method: 'POST', headers: hdrs,
    body: JSON.stringify({
      latitude: north(LAT, metresNorth), longitude: LNG,
      ...(reason ? { out_of_fence_reason: reason } : {}),
    }),
  });
  const dayRow = async () => {
    const [[r]] = await c.query(
      `SELECT geofence_status, out_of_fence_reason FROM attendance
        WHERE employee_id = ? ORDER BY id DESC LIMIT 1`, [EMP]);
    return r;
  };

  try {
    await c.query('UPDATE locations SET radius_meters = ? WHERE id = ?', [RADIUS, site.id]);
    await c.query('DELETE FROM employee_schedules WHERE employee_id = ?', [EMP]);
    await c.query(
      `INSERT INTO employee_schedules (employee_id, shift_id, location_id, geofencing_enabled, effective_from)
       VALUES (?, (SELECT MIN(id) FROM shifts), ?, TRUE, '2026-01-01')`, [EMP, site.id]);
    await c.query("UPDATE employees SET work_mode='on_site', live_tracking_enabled=TRUE WHERE id=?", [EMP]);
    await wipe();

    console.log('\n1. Outside with NO reason is still refused — and says so machine-readably');
    let r = await clockIn(600);
    let j = await r.json();
    console.log(`   ${r.status} code=${j.code} distance=${j.distance_m}m radius=${j.radius_m}m`);
    check('refused', r.status === 403, r.status);
    check("code is 'outside_fence', not just prose the app must string-match",
      j.code === 'outside_fence', j.code);
    check('it reports how far out they are', Number(j.distance_m) > 500, j.distance_m);
    check('and the radius being enforced', Number(j.radius_m) === RADIUS, j.radius_m);
    check('nothing was recorded', (await dayRow()) === undefined || (await dayRow()) == null);

    console.log('\n2. A reason gets them in — recorded as OUTSIDE, not softened');
    r = await clockIn(600, 'Customer visit at Ambattur');
    j = await r.json();
    console.log(`   ${r.status} ${j.error ?? 'accepted'}`);
    check('accepted', r.status === 201, `${r.status} ${j.error ?? ''}`);
    let row = await dayRow();
    check('the day is marked outside the fence', row?.geofence_status === 'outside', row?.geofence_status);
    check('the reason is stored', row?.out_of_fence_reason === 'Customer visit at Ambattur',
      row?.out_of_fence_reason);

    console.log('\n3. An admin is told, in the audit log — not only by email');
    // Email has been misconfigured for weeks on the real deployment, so an
    // alert that exists only in an SMTP call is no alert at all.
    const [[audit]] = await c.query(
      `SELECT JSON_UNQUOTE(JSON_EXTRACT(details,'$.reason')) AS reason,
              JSON_EXTRACT(details,'$.distance_m') AS distance_m
         FROM audit_log
        WHERE action = 'clock_in_outside_fence' AND JSON_EXTRACT(details,'$.employee_id') = ?
        ORDER BY created_at DESC LIMIT 1`, [EMP]);
    check('an audit row exists', !!audit);
    check('carrying the reason', audit?.reason === 'Customer visit at Ambattur', audit?.reason);
    check('and how far out they were', Number(audit?.distance_m) > 500, audit?.distance_m);

    console.log('\n4. A reason from INSIDE the fence records no exception');
    await wipe();
    r = await clockIn(5, 'I am at my desk but typing this anyway');
    check('accepted', r.status === 201, r.status);
    row = await dayRow();
    check('marked inside', row?.geofence_status === 'inside', row?.geofence_status);
    check('and NO reason stored — the exception never happened',
      row?.out_of_fence_reason == null, row?.out_of_fence_reason);

    console.log('\n5. A blank or one-word reason is not an explanation');
    await wipe();
    r = await clockIn(600, 'x');
    check('too short is rejected', r.status === 400, r.status);
    check('and still nothing recorded', (await dayRow()) == null);

    console.log('\n6. No fence, no prompt');
    await wipe();
    await c.query('UPDATE employee_schedules SET geofencing_enabled = FALSE WHERE employee_id = ?', [EMP]);
    r = await clockIn(600);
    check('unfenced employees clock in from anywhere, as before', r.status === 201, r.status);
    row = await dayRow();
    check('no reason attached', row?.out_of_fence_reason == null, row?.out_of_fence_reason);
  } finally {
    await restore();
    await c.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });

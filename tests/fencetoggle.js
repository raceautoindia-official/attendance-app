// Switching the fence on and off, per person, from the admin UI.
//
// geofencing_enabled could only be set while ASSIGNING a schedule, so in
// practice it was changed with SQL — which is how a fence ended up live on
// phones that were not reporting, and how it stayed that way for weeks. It is a
// per-person decision that gets revisited: someone whose handset cannot hold a
// background location still needs their movements recorded, they just must not
// be judged by a radius.
//
// The two must stay independent: turning the fence off leaves live tracking on.
//
//   node tests/fencetoggle.js
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

let pass = 0, fail = 0;
const check = (l, c, d) => c
  ? (pass++, console.log(`  PASS  ${l}`))
  : (fail++, console.log(`  FAIL  ${l}${d !== undefined ? ` — ${d}` : ''}`));

(async () => {
  const c = await mysql.createConnection({
    host: env.DB_HOST, user: env.DB_USER, password: env.DB_PASSWORD,
    database: env.DB_NAME, timezone: '+00:00' });

  const [[admin]] = await c.query(
    "SELECT id, emp_id FROM employees WHERE role IN ('super_admin','manager') AND is_active = TRUE ORDER BY FIELD(role,'super_admin','manager'), id LIMIT 1");
  const [[emp]] = await c.query(
    "SELECT id, emp_id, name FROM employees WHERE is_active = TRUE AND role = 'employee' ORDER BY id LIMIT 1");
  if (!admin || !emp) throw new Error('need an admin and an employee');
  console.log(`  admin    : ${admin.emp_id}`);
  console.log(`  employee : ${emp.emp_id} ${emp.name}`);

  const tok = jwt.sign({ id: admin.id, emp_id: admin.emp_id, role: 'super_admin', tv: 0 },
    env.JWT_ACCESS_SECRET, { expiresIn: '30m' });
  const hdrs = { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` };

  const setFence = (scheduleId, enabled) =>
    fetch(`${BASE}/api/schedules/assignments/${scheduleId}`, {
      method: 'PATCH', headers: hdrs, body: JSON.stringify({ geofencing_enabled: enabled }) });

  const [origSched] = await c.query(
    `SELECT id, shift_id, location_id, geofencing_enabled, effective_from, effective_to, assigned_by
       FROM employee_schedules WHERE employee_id = ?`, [emp.id]);
  const [[origEmp]] = await c.query(
    'SELECT live_tracking_enabled, work_mode FROM employees WHERE id = ?', [emp.id]);

  const restore = async () => {
    await c.query('DELETE FROM employee_schedules WHERE employee_id = ?', [emp.id]);
    for (const o of origSched) {
      await c.query(
        `INSERT INTO employee_schedules
           (id, employee_id, shift_id, location_id, geofencing_enabled, effective_from, effective_to, assigned_by)
         VALUES (?,?,?,?,?,?,?,?)`,
        [o.id, emp.id, o.shift_id, o.location_id, o.geofencing_enabled,
         o.effective_from, o.effective_to, o.assigned_by]);
    }
    await c.query('UPDATE employees SET live_tracking_enabled = ?, work_mode = ? WHERE id = ?',
      [origEmp.live_tracking_enabled, origEmp.work_mode, emp.id]);
    await c.query("DELETE FROM locations WHERE name = 'ZZ Toggle Site'");
  };

  const fenceState = async id => {
    const [[r]] = await c.query(
      `SELECT es.geofencing_enabled AS gf, e.live_tracking_enabled AS lt
         FROM employee_schedules es JOIN employees e ON e.id = es.employee_id
        WHERE es.id = ?`, [id]);
    return r;
  };

  try {
    await c.query("DELETE FROM locations WHERE name = 'ZZ Toggle Site'");
    const [loc] = await c.query(
      `INSERT INTO locations (name, address, latitude, longitude, radius_meters, is_active)
       VALUES ('ZZ Toggle Site', 'test', 13.0080078, 80.1970224, 200, TRUE)`);

    await c.query('DELETE FROM employee_schedules WHERE employee_id = ?', [emp.id]);
    const [withLoc] = await c.query(
      `INSERT INTO employee_schedules (employee_id, shift_id, location_id, geofencing_enabled, effective_from)
       VALUES (?, (SELECT MIN(id) FROM shifts), ?, FALSE, '2026-01-01')`, [emp.id, loc.insertId]);
    await c.query("UPDATE employees SET live_tracking_enabled = TRUE, work_mode = 'on_site' WHERE id = ?", [emp.id]);

    console.log('\n1. Ticking the box fences them');
    let r = await setFence(withLoc.insertId, true);
    check('accepted', r.status === 200, r.status);
    let st = await fenceState(withLoc.insertId);
    check('the fence is on', Number(st.gf) === 1);
    check('live tracking untouched', Number(st.lt) === 1);

    console.log('\n2. Unticking leaves them TRACKED but not judged');
    r = await setFence(withLoc.insertId, false);
    check('accepted', r.status === 200, r.status);
    st = await fenceState(withLoc.insertId);
    check('the fence is off', Number(st.gf) === 0);
    check('live tracking is STILL on — the whole point of the toggle',
      Number(st.lt) === 1, `live_tracking_enabled=${st.lt}`);

    console.log('\n3. A fence needs coordinates');
    await c.query('UPDATE employee_schedules SET location_id = NULL WHERE id = ?', [withLoc.insertId]);
    r = await setFence(withLoc.insertId, true);
    const j = await r.json();
    check('refused without a work location', r.status === 400, r.status);
    check('and says why', /location/i.test(j.error ?? ''), j.error);
    st = await fenceState(withLoc.insertId);
    check('nothing was changed', Number(st.gf) === 0);

    console.log('\n4. A deactivated site cannot be fenced against');
    await c.query('UPDATE employee_schedules SET location_id = ? WHERE id = ?', [loc.insertId, withLoc.insertId]);
    await c.query('UPDATE locations SET is_active = FALSE WHERE id = ?', [loc.insertId]);
    r = await setFence(withLoc.insertId, true);
    check('refused', r.status === 400, r.status);
    check('still not fenced', Number((await fenceState(withLoc.insertId)).gf) === 0);
    await c.query('UPDATE locations SET is_active = TRUE WHERE id = ?', [loc.insertId]);

    console.log('\n5. Only admins may change it');
    const empTok = jwt.sign({ id: emp.id, emp_id: emp.emp_id, role: 'employee', tv: 0 },
      env.JWT_ACCESS_SECRET, { expiresIn: '30m' });
    r = await fetch(`${BASE}/api/schedules/assignments/${withLoc.insertId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${empTok}` },
      body: JSON.stringify({ geofencing_enabled: true }) });
    check('an employee cannot fence themselves', r.status === 401 || r.status === 403, r.status);

    console.log('\n6. A missing schedule is a 404, not a silent success');
    r = await setFence(99999999, true);
    check('404', r.status === 404, r.status);
  } finally {
    await restore();
    await c.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });

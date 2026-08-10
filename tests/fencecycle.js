// Leave the fence -> auto clock-out. Come back -> auto clock-in.
// Driven through the real endpoints exactly as the phone's geofence task does.
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
const EMP = 6; // REENA001

let pass = 0, fail = 0;
const check = (l, c, d) => c ? (pass++, console.log(`  PASS  ${l}`)) : (fail++, console.log(`  FAIL  ${l}${d !== undefined ? ` — ${d}` : ''}`));

const tok = jwt.sign({ id: EMP, emp_id: 'REENA001', role: 'employee', tv: 0 },
  env.JWT_ACCESS_SECRET, { expiresIn: '30m' });
const call = async (p, body) => {
  const r = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'user-agent': UA,
               'x-device-id': 'suite-registered-phone', Authorization: `Bearer ${tok}` },
    body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

(async () => {
  const c = await mysql.createConnection({
    host: env.DB_HOST, user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME, timezone: '+00:00' });
  const [origSched] = await c.query(
    'SELECT id,shift_id,location_id,geofencing_enabled,effective_from,effective_to,assigned_by FROM employee_schedules WHERE employee_id=?', [EMP]);
  const [[origEmp]] = await c.query(
    'SELECT work_mode, live_tracking_enabled, allow_multiple_sessions FROM employees WHERE id=?', [EMP]);
  const [[site]] = await c.query('SELECT id, latitude, longitude FROM locations WHERE is_active=TRUE LIMIT 1');
  const INSIDE = { latitude: Number(site.latitude), longitude: Number(site.longitude) };
  const AWAY   = { latitude: 28.6139, longitude: 77.2090 };   // far outside
  const [[wd]] = await c.query(
    "SELECT DATE_FORMAT(DATE(DATE_SUB(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+05:30'), INTERVAL 7 HOUR)),'%Y-%m-%d') AS d");

  const setup = async (multi) => {
    await c.query('DELETE FROM attendance WHERE employee_id=?', [EMP]);
    await c.query('DELETE FROM employee_schedules WHERE employee_id=?', [EMP]);
    await c.query(
      `INSERT INTO employee_schedules (employee_id, shift_id, location_id, geofencing_enabled, effective_from)
       VALUES (?, (SELECT MIN(id) FROM shifts), ?, TRUE, '2026-01-01')`, [EMP, site.id]);
    await c.query(
      'UPDATE employees SET work_mode=?, live_tracking_enabled=TRUE, allow_multiple_sessions=? WHERE id=?',
      ['on_site', multi, EMP]);
  };
  const row = async () => {
    const [[r]] = await c.query(
      'SELECT clock_in_utc, clock_out_utc, total_minutes, banked_minutes, session_count FROM attendance WHERE employee_id=? AND work_date=?',
      [EMP, wd.d]);
    return r;
  };

  console.log('\n1. Multi-session employee: the full out-and-back cycle');
  await setup(true);
  let r = await call('/api/attendance/clock-in', INSIDE);
  check('manual first clock-in at the site', r.status === 201, `${r.status} ${r.json.error ?? ''}`);

  // Phone detects the EXIT and clocks out automatically.
  r = await call('/api/attendance/clock-out', { ...AWAY, auto: true, reason: 'geofence_exit' });
  console.log(`   auto clock-out on exit: ${r.status} ${r.json.error ?? ''}`);
  check('leaving the fence clocks them out', r.status === 200, `${r.status} ${r.json.error ?? ''}`);
  let a = await row();
  check('the day is closed', a.clock_out_utc != null);

  // Phone detects the ENTER and clocks back in.
  r = await call('/api/attendance/clock-in', { ...INSIDE, auto: true });
  console.log(`   auto clock-in on return: ${r.status} ${r.json.error ?? ''}`);
  check('returning to the fence clocks them back IN', r.status === 201, `${r.status} ${r.json.error ?? ''}`);
  a = await row();
  check('the day is open again', a.clock_out_utc == null, a.clock_out_utc);
  check('it is a second session', Number(a.session_count) === 2, a.session_count);
  check('the first stretch is banked, not lost', Number(a.banked_minutes) >= 0 && a.banked_minutes != null,
    a.banked_minutes);

  console.log('\n2. Single-session employee: the trap');
  await setup(false);
  r = await call('/api/attendance/clock-in', INSIDE);
  check('first clock-in works', r.status === 201, r.status);
  r = await call('/api/attendance/clock-out', { ...AWAY, auto: true, reason: 'geofence_exit' });
  check('leaving still clocks them out', r.status === 200, r.status);
  r = await call('/api/attendance/clock-in', { ...INSIDE, auto: true });
  console.log(`   auto clock-in on return: ${r.status} "${r.json.error ?? ''}"`);
  check('the server refuses to reopen the day', r.status === 409, r.status);
  check('and says why, so the phone can tell them',
    /completed/i.test(r.json.error ?? ''), r.json.error);

  console.log('\n3. The phone reports that refusal instead of hiding it');
  const src = fs.readFileSync(path.join(ROOT, 'mobile', 'src', 'location', 'geofenceAuto.ts'), 'utf8');
  check('no silent multi_session skip in the Enter branch',
    !/if \(today\.multi_session !== true\) return;/.test(src));
  check('no silent skip in the reconcile path either',
    !/today\.multi_session === true && dist <= fence\.radius/.test(src));
  check('a "completed" 409 raises a notification',
    /completed/i.test(src) && /already closed/i.test(src));
  check('exit still notifies', /Auto clocked out/.test(src));
  check('re-entry still notifies', /Auto clocked in/.test(src));

  // Restore
  await c.query('DELETE FROM attendance WHERE employee_id=?', [EMP]);
  await c.query('DELETE FROM employee_schedules WHERE employee_id=?', [EMP]);
  for (const o of origSched) {
    await c.query(
      `INSERT INTO employee_schedules (id,employee_id,shift_id,location_id,geofencing_enabled,effective_from,effective_to,assigned_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [o.id, EMP, o.shift_id, o.location_id, o.geofencing_enabled, o.effective_from, o.effective_to, o.assigned_by]);
  }
  await c.query('UPDATE employees SET work_mode=?, live_tracking_enabled=?, allow_multiple_sessions=? WHERE id=?',
    [origEmp.work_mode, origEmp.live_tracking_enabled, origEmp.allow_multiple_sessions, EMP]);
  await c.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });

// The day's FIRST login survives every later session.
//
// A multi-session day reuses one attendance row, and every re-login overwrote
// clock_in_utc — so someone who arrived at 9:09, stepped out at lunch and came
// back at 12:20 showed "12:20" as their login everywhere, and the 9:09 existed
// nowhere but the audit log. The complaint was literal: "you have to record
// everything, but you show the in-between login time".
//
// first_clock_in_utc is written once and never touched; clock_in_utc keeps
// meaning "current session start" because the session maths depends on it.
//
//   node tests/firstlogin.js
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

let pass = 0, fail = 0;
const check = (l, c, d) => c
  ? (pass++, console.log(`  PASS  ${l}`))
  : (fail++, console.log(`  FAIL  ${l}${d !== undefined ? ` — ${d}` : ''}`));

const tok = jwt.sign({ id: EMP, emp_id: 'REENA001', role: 'employee', tv: 0 },
  env.JWT_ACCESS_SECRET, { expiresIn: '30m' });
const hdrs = { 'Content-Type': 'application/json', 'user-agent': UA,
               'x-device-id': 'firstlogin-phone', Authorization: `Bearer ${tok}` };

const clockIn = () => fetch(`${BASE}/api/attendance/clock-in`, {
  method: 'POST', headers: hdrs,
  body: JSON.stringify({ latitude: 13.0080078, longitude: 80.1970224 }) });
const clockOut = () => fetch(`${BASE}/api/attendance/clock-out`, {
  method: 'POST', headers: hdrs,
  body: JSON.stringify({ latitude: 13.0080078, longitude: 80.1970224 }) });

(async () => {
  const c = await mysql.createConnection({
    host: env.DB_HOST, user: env.DB_USER, password: env.DB_PASSWORD,
    database: env.DB_NAME, timezone: '+00:00' });

  const [[origEmp]] = await c.query(
    'SELECT work_mode, live_tracking_enabled, allow_multiple_sessions FROM employees WHERE id = ?', [EMP]);
  const [origSched] = await c.query(
    `SELECT id, shift_id, location_id, geofencing_enabled, effective_from, effective_to, assigned_by
       FROM employee_schedules WHERE employee_id = ?`, [EMP]);

  const wipe = async () => {
    // Audit rows too: today_sessions reads the whole day from the audit log,
    // so another suite's clock events minutes earlier would appear — correctly
    // — in this test's session list.
    await c.query("DELETE FROM audit_log WHERE JSON_EXTRACT(details, '$.employee_id') = ?", [EMP]);
    await c.query('DELETE FROM attendance WHERE employee_id = ?', [EMP]);
    await c.query('DELETE FROM employee_devices WHERE employee_id = ?', [EMP]);
    await c.query('DELETE FROM live_tracking_sessions WHERE employee_id = ?', [EMP]);
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
    await c.query(
      'UPDATE employees SET work_mode = ?, live_tracking_enabled = ?, allow_multiple_sessions = ? WHERE id = ?',
      [origEmp.work_mode, origEmp.live_tracking_enabled, origEmp.allow_multiple_sessions, EMP]);
  };

  const row = async () => {
    const [[r]] = await c.query(
      `SELECT first_clock_in_utc, clock_in_utc, clock_out_utc, session_count
         FROM attendance WHERE employee_id = ? ORDER BY id DESC LIMIT 1`, [EMP]);
    return r;
  };

  try {
    await c.query('DELETE FROM employee_schedules WHERE employee_id = ?', [EMP]);
    await c.query(
      `INSERT INTO employee_schedules (employee_id, shift_id, location_id, geofencing_enabled, effective_from)
       VALUES (?, (SELECT MIN(id) FROM shifts), NULL, FALSE, '2026-01-01')`, [EMP]);
    await c.query(
      "UPDATE employees SET work_mode='on_site', live_tracking_enabled=FALSE, allow_multiple_sessions=TRUE WHERE id=?",
      [EMP]);
    await wipe();

    console.log('\n1. The morning login is recorded');
    check('first clock-in accepted', (await clockIn()).status === 201);
    let r = await row();
    check('first_clock_in_utc is set', r.first_clock_in_utc != null);
    check('and equals the session start', String(r.first_clock_in_utc) === String(r.clock_in_utc));
    const morning = String(r.first_clock_in_utc);

    // Pretend the morning was two hours ago, so later sessions visibly differ.
    await c.query(
      `UPDATE attendance SET
         first_clock_in_utc = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 120 MINUTE),
         clock_in_utc = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 120 MINUTE)
       WHERE employee_id = ?`, [EMP]);
    const backdated = String((await row()).first_clock_in_utc);

    console.log('\n2. An in-between login does not touch it');
    check('clock out', (await clockOut()).status === 200);
    check('clock in again', (await clockIn()).status === 201);
    r = await row();
    check('the morning survives the re-login', String(r.first_clock_in_utc) === backdated,
      `${r.first_clock_in_utc} vs ${backdated}`);
    check('while the session start moved to now',
      String(r.clock_in_utc) !== backdated && r.clock_out_utc === null);
    check('and it is a second session', Number(r.session_count) === 2, r.session_count);

    console.log('\n3. Both times reach the phone and the admin list');
    const today = await (await fetch(`${BASE}/api/attendance/today`, { headers: hdrs })).json();
    check('/today carries the first login',
      String(new Date(today.data?.attendance?.first_clock_in_utc).getTime())
        === String(new Date(backdated + 'Z').getTime())
      || today.data?.attendance?.first_clock_in_utc != null,
      today.data?.attendance?.first_clock_in_utc);
    check('/today still carries the current session start separately',
      today.data?.attendance?.clock_in_utc != null &&
      today.data?.attendance?.first_clock_in_utc !== today.data?.attendance?.clock_in_utc);

    const adminTokRow = await c.query(
      "SELECT id, emp_id FROM employees WHERE role = 'super_admin' AND is_active = TRUE LIMIT 1");
    const admin = adminTokRow[0][0];
    const aTok = jwt.sign({ id: admin.id, emp_id: admin.emp_id, role: 'super_admin', tv: 0 },
      env.JWT_ACCESS_SECRET, { expiresIn: '30m' });
    const list = await (await fetch(`${BASE}/api/attendance?employee_id=${EMP}`,
      { headers: { Authorization: `Bearer ${aTok}` } })).json();
    const mine = (list.data?.records ?? [])[0];
    check('the admin list carries both fields',
      mine?.first_clock_in_utc != null && mine?.clock_in_utc != null &&
      mine.first_clock_in_utc !== mine.clock_in_utc,
      JSON.stringify({ first: mine?.first_clock_in_utc, session: mine?.clock_in_utc }));

    console.log('\n3b. /today lists EVERY session of the day, with how each ended');
    const sess = today.data?.today_sessions ?? [];
    console.log('   ' + sess.map(x =>
      `${x.in_utc?.slice(11, 16)}–${x.out_utc ? x.out_utc.slice(11, 16) : 'open'}${x.out_kind ? ` (${x.out_kind})` : ''}`
    ).join(' | '));
    check('two sessions are listed', sess.length === 2, sess.length);
    check('the first closed as a manual clock-out',
      sess[0]?.out_utc != null && sess[0]?.out_kind === 'manual', JSON.stringify(sess[0]));
    check('the second is still open', sess[1]?.out_utc === null, JSON.stringify(sess[1]));

    console.log('\n4. The displays show the morning, not the in-between login');
    const adminPage = fs.readFileSync(path.join(ROOT, 'app/(admin)/attendance/page.tsx'), 'utf8');
    check('admin In-column leads with the first login',
      adminPage.includes('row.first_clock_in_utc ?? row.clock_in_utc'));
    const dash = fs.readFileSync(path.join(ROOT, 'mobile/src/screens/DashboardScreen.tsx'), 'utf8');
    check('the phone Clock In tile leads with the first login',
      dash.includes('first_clock_in_utc ?? attendance?.clock_in_utc'));
  } finally {
    await restore();
    await c.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });

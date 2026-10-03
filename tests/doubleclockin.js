// Two clock-ins must never both succeed.
//
// Production has a day with two clock_in audit rows four minutes apart and no
// clock-out between them — a state the duplicate-clock-in check says cannot
// happen. It can, because the check and the write are separate statements: two
// requests both read "no open session", then both re-open the day. A phone
// retrying a request that felt slow is enough to arrange it.
//
// The damage is quiet. session_count counts a session that never happened, and
// banked_minutes is overwritten with the same stale figure by both writers, so
// the minutes between the two clock-ins are simply gone from the employee's day.
//
//   node tests/doubleclockin.js
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
const FIRES = 5;

let pass = 0, fail = 0;
const check = (l, c, d) => c
  ? (pass++, console.log(`  PASS  ${l}`))
  : (fail++, console.log(`  FAIL  ${l}${d !== undefined ? ` — ${d}` : ''}`));

const tok = jwt.sign({ id: EMP, emp_id: 'REENA001', role: 'employee', tv: 0 },
  env.JWT_ACCESS_SECRET, { expiresIn: '30m' });
const hdrs = { 'Content-Type': 'application/json', 'user-agent': UA,
               'x-device-id': 'double-clockin-phone', Authorization: `Bearer ${tok}` };

const clockIn  = () => fetch(`${BASE}/api/attendance/clock-in`,
  { method: 'POST', headers: hdrs, body: JSON.stringify({ latitude: 13.0080078, longitude: 80.1970224 }) });
const clockOut = () => fetch(`${BASE}/api/attendance/clock-out`,
  { method: 'POST', headers: hdrs, body: JSON.stringify({ latitude: 13.0080078, longitude: 80.1970224 }) });

(async () => {
  const c = await mysql.createConnection({
    host: env.DB_HOST, user: env.DB_USER, password: env.DB_PASSWORD,
    database: env.DB_NAME, timezone: '+00:00' });

  const [[origEmp]] = await c.query(
    'SELECT work_mode, live_tracking_enabled, allow_multiple_sessions FROM employees WHERE id = ?', [EMP]);
  const [origSched] = await c.query(
    `SELECT id, shift_id, location_id, geofencing_enabled, effective_from, effective_to, assigned_by
       FROM employee_schedules WHERE employee_id = ?`, [EMP]);

  const restore = async () => {
    await c.query('DELETE FROM attendance WHERE employee_id = ?', [EMP]);
    await c.query('DELETE FROM employee_devices WHERE employee_id = ?', [EMP]);
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

  try {
    // Geofencing off — this test is about the race, not about location.
    await c.query('DELETE FROM attendance WHERE employee_id = ?', [EMP]);
    await c.query('DELETE FROM employee_devices WHERE employee_id = ?', [EMP]);
    await c.query('DELETE FROM employee_schedules WHERE employee_id = ?', [EMP]);
    await c.query(
      `INSERT INTO employee_schedules (employee_id, shift_id, location_id, geofencing_enabled, effective_from)
       VALUES (?, (SELECT MIN(id) FROM shifts), NULL, FALSE, '2026-01-01')`, [EMP]);
    await c.query(
      `UPDATE employees SET work_mode = 'on_site', live_tracking_enabled = FALSE,
                            allow_multiple_sessions = TRUE WHERE id = ?`, [EMP]);

    const day = async () => {
      const [[r]] = await c.query(
        `SELECT session_count, banked_minutes, total_minutes, clock_out_utc
           FROM attendance WHERE employee_id = ? ORDER BY id DESC LIMIT 1`, [EMP]);
      return r;
    };

    console.log('\n1. One finished session to re-open');
    check('clock in', (await clockIn()).status === 201);
    // Backdate so the finished session has real minutes to bank.
    await c.query(
      'UPDATE attendance SET clock_in_utc = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 120 MINUTE) WHERE employee_id = ?',
      [EMP]);
    check('clock out', (await clockOut()).status === 200);
    const after1 = await day();
    console.log(`   sessions=${after1.session_count} total=${after1.total_minutes}`);
    check('the finished session banked its minutes', Number(after1.total_minutes) >= 119,
      after1.total_minutes);

    console.log(`\n2. ${FIRES} clock-ins fired at once — the race`);
    const results = await Promise.all(Array.from({ length: FIRES }, () => clockIn()));
    const codes = results.map(r => r.status).sort();
    console.log(`   statuses: ${codes.join(', ')}`);
    const created = codes.filter(s => s === 201).length;
    const refused = codes.filter(s => s === 409).length;
    check('exactly ONE clock-in succeeded', created === 1, `${created} succeeded`);
    check('the others were refused with 409', refused === FIRES - 1, `${refused} refused`);

    console.log('\n3. The day is not corrupted');
    const after2 = await day();
    console.log(`   sessions=${after2.session_count} banked=${after2.banked_minutes}`);
    check('session_count counts 2 sessions, not more',
      Number(after2.session_count) === 2, after2.session_count);
    check('the first session is still banked in full',
      Number(after2.banked_minutes) >= 119, after2.banked_minutes);
    check('the day is open again', after2.clock_out_utc === null);

    const [[open]] = await c.query(
      `SELECT COUNT(*) AS n FROM attendance
        WHERE employee_id = ? AND clock_in_utc IS NOT NULL AND clock_out_utc IS NULL`, [EMP]);
    check('exactly one open session exists', Number(open.n) === 1, open.n);

    console.log('\n4. A sequential repeat is still refused');
    const again = await clockIn();
    check('second clock-in while open is refused', again.status === 409, again.status);
  } finally {
    await restore();
    await c.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });

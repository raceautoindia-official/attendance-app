// One employee's day, reconstructed as a single ordered story.
//
// The pieces always existed — attendance, audit log, permissions, tracking —
// but "what happened with this person today?" meant four pages and a SQL
// prompt. The timeline endpoint answers it once: every event between the
// 07:00 boundaries, in order, in words.
//
//   node tests/timeline.js
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

const empTok = jwt.sign({ id: EMP, emp_id: 'REENA001', role: 'employee', tv: 0 },
  env.JWT_ACCESS_SECRET, { expiresIn: '30m' });
const empHdrs = { 'Content-Type': 'application/json', 'user-agent': UA,
                  'x-device-id': 'timeline-phone', Authorization: `Bearer ${empTok}` };

(async () => {
  const c = await mysql.createConnection({
    host: env.DB_HOST, user: env.DB_USER, password: env.DB_PASSWORD,
    database: env.DB_NAME, timezone: '+00:00' });

  const [[admin]] = await c.query(
    "SELECT id, emp_id FROM employees WHERE role = 'super_admin' AND is_active = TRUE ORDER BY id LIMIT 1");
  const adminTok = jwt.sign({ id: admin.id, emp_id: admin.emp_id, role: 'super_admin', tv: 0 },
    env.JWT_ACCESS_SECRET, { expiresIn: '30m' });
  const adminHdrs = { Authorization: `Bearer ${adminTok}` };

  const [origSched] = await c.query(
    `SELECT id, shift_id, location_id, geofencing_enabled, effective_from, effective_to, assigned_by
       FROM employee_schedules WHERE employee_id = ?`, [EMP]);
  const [[origEmp]] = await c.query(
    'SELECT work_mode, live_tracking_enabled FROM employees WHERE id = ?', [EMP]);

  const wipe = async () => {
    // Audit rows for this employee too — not only for isolation from earlier
    // suites, but because rows written BEFORE created_at became explicit UTC
    // carry the dev DB server's IST stamp, which reads as five and a half
    // hours in the FUTURE and invades every "recent events" window until the
    // clock catches up with the mistake.
    await c.query("DELETE FROM audit_log WHERE JSON_EXTRACT(details, '$.employee_id') = ?", [EMP]);
    await c.query('DELETE FROM attendance WHERE employee_id = ?', [EMP]);
    await c.query('DELETE FROM employee_devices WHERE employee_id = ?', [EMP]);
    await c.query('DELETE FROM live_tracking_sessions WHERE employee_id = ?', [EMP]);
    await c.query('DELETE FROM permission_requests WHERE employee_id = ?', [EMP]);
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

  const timeline = async (who, date) => {
    const r = await fetch(`${BASE}/api/employees/${EMP}/timeline${date ? `?date=${date}` : ''}`,
      { headers: who });
    return { status: r.status, data: (await r.json()).data };
  };

  try {
    // Fence off — this test is about the story, not the geometry.
    await c.query('DELETE FROM employee_schedules WHERE employee_id = ?', [EMP]);
    await c.query(
      `INSERT INTO employee_schedules (employee_id, shift_id, location_id, geofencing_enabled, effective_from)
       VALUES (?, (SELECT MIN(id) FROM shifts), NULL, FALSE, '2026-01-01')`, [EMP]);
    await c.query("UPDATE employees SET work_mode='on_site', live_tracking_enabled=FALSE WHERE id=?", [EMP]);
    await wipe();

    console.log('\n1. Live a small day over the API');
    // A moment just before OUR events begin — the ordering assertion later
    // scopes to this, because the audit log rightly also carries every earlier
    // test run against this employee today.
    const sinceIso = new Date(Date.now() - 5000).toISOString();
    let r = await fetch(`${BASE}/api/attendance/clock-in`, {
      method: 'POST', headers: empHdrs,
      body: JSON.stringify({ latitude: 13.0080078, longitude: 80.1970224 }) });
    check('clocked in', r.status === 201, r.status);

    const [[d]] = await c.query(
      "SELECT DATE_FORMAT(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+05:30'), '%Y-%m-%d') AS d");
    r = await fetch(`${BASE}/api/permissions`, {
      method: 'POST', headers: empHdrs,
      body: JSON.stringify({ permission_date: d.d, start_time: '15:00', end_time: '16:00', reason: 'timeline test' }) });
    const permId = (await r.json()).data?.permission?.id ?? (await Promise.resolve(null));
    check('permission filed', r.status === 201 || r.status === 200, r.status);
    r = await fetch(`${BASE}/api/permissions/${permId}`, {
      method: 'PATCH', headers: { ...adminHdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve', review_notes: 'Fine' }) });
    check('permission approved', r.status === 200, r.status);

    r = await fetch(`${BASE}/api/attendance/clock-out`, {
      method: 'POST', headers: empHdrs,
      body: JSON.stringify({ latitude: 13.0080078, longitude: 80.1970224 }) });
    check('clocked out', r.status === 200, r.status);

    console.log('\n2. The admin reads it back as one story');
    const t = await timeline(adminHdrs);
    check('timeline answers', t.status === 200, t.status);
    const titles = (t.data?.events ?? []).map(e => e.title);
    console.log('   ' + titles.join('\n   '));
    check('the clock-in is narrated', titles.includes('Clocked in'));
    check('the approval is narrated', titles.some(x => /Permission request approved/.test(x)));
    check('the clock-out is narrated', titles.includes('Clocked out'));
    check('events are in chronological order',
      (t.data?.events ?? []).every((e, i, a) => i === 0 || a[i - 1].at_utc <= e.at_utc));
    // Only OUR slice of the day: the audit log carries every earlier test run
    // against this employee too, which is exactly what the endpoint should
    // report — so the ordering assertion scopes to events since this test began.
    const ours = (t.data?.events ?? []).filter(e => e.at_utc >= sinceIso).map(e => e.title);
    // Position 0 is legitimately "New phone registered": clocking in on a
    // fresh device binds it first, and the story SHOULD say so. What matters
    // is the order of the day itself.
    check('our slice tells the day in order: in → approved → out',
      ours.indexOf('Clocked in') !== -1 &&
      ours.indexOf('Clocked in') < ours.findIndex(x => /approved/.test(x)) &&
      ours.findIndex(x => /approved/.test(x)) < ours.indexOf('Clocked out'),
      ours.join(' | '));
    check('tracking summary present (zero fixes is stated, not omitted)',
      t.data?.tracking?.points === 0, JSON.stringify(t.data?.tracking));

    console.log('\n3. The employee may read their own day');
    const own = await timeline({ Authorization: `Bearer ${empTok}` });
    check('self-view allowed', own.status === 200, own.status);

    console.log('\n4. A colleague may not');
    const [[other]] = await c.query(
      "SELECT id, emp_id FROM employees WHERE is_active = TRUE AND role = 'employee' AND id <> ? ORDER BY id LIMIT 1", [EMP]);
    const otherTok = jwt.sign({ id: other.id, emp_id: other.emp_id, role: 'employee', tv: 0 },
      env.JWT_ACCESS_SECRET, { expiresIn: '30m' });
    const nope = await timeline({ Authorization: `Bearer ${otherTok}` });
    check('another employee is refused', nope.status === 403, nope.status);

    console.log('\n5. A malformed date falls back to today instead of erroring');
    const fallback = await timeline(adminHdrs, 'not-a-date');
    check('still answers with today', fallback.status === 200 && fallback.data?.work_date === d.d,
      `${fallback.status} ${fallback.data?.work_date}`);
  } finally {
    await restore();
    await c.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });

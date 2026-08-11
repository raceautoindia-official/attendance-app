// Live Tracking must list everyone who is CLOCKED IN, reporting or not.
//
// The page was driven by live_tracking_sessions, so an employee on shift whose
// phone had gone quiet simply vanished from it — and "vanished" looks exactly
// like "went home". Three people disappeared from the list on an afternoon they
// were sitting at their desks, and working out why took four wrong guesses:
// duplicate schedules, dead sessions, a client-side filter, a time window. None
// of them were it.
//
// Someone on shift now always appears. Whether their phone reports is a fact
// shown ABOUT them, not something inferred from their absence.
//
//   node tests/livelist.js
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
  if (!admin) throw new Error('need an active admin to read the live page as');
  const [staff] = await c.query(
    "SELECT id, emp_id, name FROM employees WHERE is_active = TRUE AND role = 'employee' ORDER BY id LIMIT 2");
  if (staff.length < 2) throw new Error('need 2 active employees');
  const [QUIET, REPORTING] = staff;
  console.log(`  admin           : ${admin.emp_id}`);
  console.log(`  quiet phone     : ${QUIET.emp_id} ${QUIET.name}`);
  console.log(`  reporting phone : ${REPORTING.emp_id} ${REPORTING.name}`);

  const adminTok = jwt.sign({ id: admin.id, emp_id: admin.emp_id, role: 'super_admin', tv: 0 },
    env.JWT_ACCESS_SECRET, { expiresIn: '30m' });
  const hdrs = { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` };

  const live = async () => {
    const r = await fetch(`${BASE}/api/live-tracking/live`, { headers: hdrs });
    const j = await r.json();
    return { status: r.status, rows: j.data?.sessions ?? [], body: j };
  };
  const rowFor = (rows, id) => rows.find(s => Number(s.employee_id) === id);

  const ids = staff.map(s => s.id);
  const [[wd]] = await c.query(
    "SELECT DATE_FORMAT(DATE(DATE_SUB(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+05:30'), INTERVAL 7 HOUR)),'%Y-%m-%d') AS d");

  const wipe = async () => {
    await c.query('DELETE FROM attendance WHERE employee_id IN (?)', [ids]);
    await c.query('DELETE FROM live_tracking_sessions WHERE employee_id IN (?)', [ids]);
  };
  await wipe();

  try {
    console.log('\n1. Clocked in, phone sending NOTHING — must still be listed');
    await c.query(
      `INSERT INTO attendance (employee_id, work_date, clock_in_utc, status)
       VALUES (?, ?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 MINUTE), 'present')`, [QUIET.id, wd.d]);
    let r = await live();
    check('the endpoint answers 200 with nobody tracking at all', r.status === 200,
      `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    const quiet = rowFor(r.rows, QUIET.id);
    check('the on-shift employee IS in the list', !!quiet,
      `saw ${r.rows.length} row(s)`);
    check('with no session', quiet ? quiet.session_id == null : false);
    check('and no coordinates, rather than being hidden',
      quiet ? quiet.latitude == null : false);
    check('the shift start still reported, from their clock-in',
      quiet ? !!quiet.started_at_utc : false);

    console.log('\n2. A reporting phone shows its position');
    await c.query(
      `INSERT INTO attendance (employee_id, work_date, clock_in_utc, status)
       VALUES (?, ?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 60 MINUTE), 'present')`, [REPORTING.id, wd.d]);
    const [s] = await c.query(
      `INSERT INTO live_tracking_sessions (employee_id, started_at_utc, is_active, last_ping_utc)
       VALUES (?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 60 MINUTE), TRUE, UTC_TIMESTAMP())`, [REPORTING.id]);
    for (const min of [50, 30, 10, 1]) {
      await c.query(
        `INSERT INTO live_tracking_points (session_id, employee_id, tracked_at_utc, latitude, longitude, accuracy_meters)
         VALUES (?,?,DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE),13.0080078,80.1970224,8)`,
        [s.insertId, REPORTING.id, min]);
    }
    r = await live();
    const rep = rowFor(r.rows, REPORTING.id);
    check('the reporting employee is listed', !!rep);
    check('with coordinates', rep ? rep.latitude != null : false);
    check('and the quiet one is STILL listed alongside them',
      !!rowFor(r.rows, QUIET.id), `saw ${r.rows.length} row(s)`);

    console.log('\n3. Clocking out removes them');
    await c.query('UPDATE attendance SET clock_out_utc = UTC_TIMESTAMP() WHERE employee_id = ?', [QUIET.id]);
    r = await live();
    check('someone clocked out is no longer on the page', !rowFor(r.rows, QUIET.id));
    check('the one still on shift remains', !!rowFor(r.rows, REPORTING.id));
  } finally {
    await wipe();
    await c.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });

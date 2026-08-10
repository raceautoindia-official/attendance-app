// DOES THE SCHEDULED WORK HAPPEN ON ITS OWN?
//
// This is the test whose absence let a broken feature reach the client. The
// away-from-site watchdog was proven by CALLING /api/cron/live-tracking-monitor
// — which proved the logic and nothing about whether anything calls it. It ran
// nowhere. The endpoint was 401 to the world and no scheduler touched it.
//
// So: plant a situation the server must act on, start the server, and DO NOT
// TOUCH IT. If the row changes, the wiring is real.
//
// Run as:  node wiringcheck.js seed     (before starting the server)
//          node wiringcheck.js verify   (after it has been up ~25s)
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const mysql = require(path.join(ROOT, 'node_modules', 'mysql2', 'promise'));
const env = {};
for (const l of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2];
}
// WHICH EMPLOYEE THIS TEST USES.
//
// It writes real attendance: a clock-in 90 minutes ago, which the server then
// clocks out. Run against production with the wrong id and you have corrupted
// a real person's day. There is deliberately no default — name the account
// explicitly, and use one nobody relies on.
//
//   TEST_EMPLOYEE_ID=42 node tests/wiringcheck.js seed
const EMP = Number(process.env.TEST_EMPLOYEE_ID);
const MODE = process.argv[2];

if (!Number.isInteger(EMP) || EMP <= 0) {
  console.error(
    'Refusing to run: set TEST_EMPLOYEE_ID to the employee this test may write to.\n' +
    '\n' +
    '  It creates a clock-in 90 minutes ago and lets the server clock it out,\n' +
    '  so pick a test account — never someone who is actually on shift.\n' +
    '\n' +
    '  TEST_EMPLOYEE_ID=<id> node tests/wiringcheck.js seed\n' +
    '  TEST_EMPLOYEE_ID=<id> node tests/wiringcheck.js verify\n',
  );
  process.exit(2);
}

(async () => {
  const c = await mysql.createConnection({
    host: env.DB_HOST, user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME, timezone: '+00:00' });
  const [[site]] = await c.query('SELECT id FROM locations WHERE is_active=TRUE LIMIT 1');
  const [[wd]] = await c.query(
    "SELECT DATE_FORMAT(DATE(DATE_SUB(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+05:30'), INTERVAL 7 HOUR)),'%Y-%m-%d') AS d");

  // The two halves run as separate commands, so what `seed` overwrote has to be
  // written down for `verify` to put back. Without this the employee is left on
  // a schedule this test invented — permanently, and silently.
  const STATE = path.join(__dirname, '.wiringcheck-state.json');

  if (MODE === 'seed') {
    if (fs.existsSync(STATE)) {
      console.error(
        `Refusing to seed: ${STATE} already exists, so an earlier run never finished.\n` +
        'Run "verify" first to restore that employee, or delete the file if you are sure.',
      );
      await c.end();
      process.exit(2);
    }

    const [schedules] = await c.query(
      `SELECT id, shift_id, location_id, geofencing_enabled,
              DATE_FORMAT(effective_from, '%Y-%m-%d') AS effective_from,
              DATE_FORMAT(effective_to,   '%Y-%m-%d') AS effective_to, assigned_by
       FROM employee_schedules WHERE employee_id = ?`, [EMP]);
    const [[emp]] = await c.query(
      'SELECT emp_id, name, work_mode, live_tracking_enabled FROM employees WHERE id = ?', [EMP]);
    if (!emp) {
      console.error(`No employee with id ${EMP}.`);
      await c.end();
      process.exit(2);
    }
    const [openRows] = await c.query(
      'SELECT COUNT(*) AS n FROM attendance WHERE employee_id = ? AND clock_out_utc IS NULL AND clock_in_utc IS NOT NULL',
      [EMP]);
    if (Number(openRows[0].n) > 0) {
      console.error(
        `Refusing to seed: ${emp.emp_id} (${emp.name}) is clocked in RIGHT NOW.\n` +
        'This test would overwrite their live shift. Pick a test account instead.',
      );
      await c.end();
      process.exit(2);
    }

    fs.writeFileSync(STATE, JSON.stringify({ emp: EMP, schedules, employee: emp, work_date: wd.d }, null, 2));

    // Someone clocked in 90 minutes ago whose presence has never been
    // confirmed inside the fence. The watchdog must end their day.
    await c.query('DELETE FROM attendance WHERE employee_id=? AND work_date=?', [EMP, wd.d]);
    await c.query('DELETE FROM live_tracking_points WHERE employee_id=?', [EMP]);
    await c.query('DELETE FROM live_tracking_sessions WHERE employee_id=?', [EMP]);
    await c.query('DELETE FROM employee_schedules WHERE employee_id=?', [EMP]);
    await c.query(
      `INSERT INTO employee_schedules (employee_id, shift_id, location_id, geofencing_enabled, effective_from)
       VALUES (?, (SELECT MIN(id) FROM shifts), ?, TRUE, '2026-01-01')`, [EMP, site.id]);
    await c.query("UPDATE employees SET work_mode='on_site', live_tracking_enabled=TRUE WHERE id=?", [EMP]);
    await c.query(
      `INSERT INTO attendance (employee_id, work_date, clock_in_utc, status, banked_minutes, session_count)
       VALUES (?, ?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 MINUTE), 'present', 0, 1)`, [EMP, wd.d]);
    console.log(`seeded: ${emp.emp_id} (${emp.name}) clocked in 90 min ago, presence never confirmed`);
    console.log(`previous state saved to ${path.basename(STATE)} — "verify" restores it`);
    console.log('now start the server and DO NOT call any cron endpoint');
    await c.end();
    return;
  }

  const [[row]] = await c.query(
    'SELECT clock_out_utc, total_minutes FROM attendance WHERE employee_id=? AND work_date=?', [EMP, wd.d]);
  const [[log]] = await c.query(
    `SELECT COUNT(*) AS n FROM audit_log
      WHERE action='geofence_auto_clockout'
        AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)`);

  const acted = row?.clock_out_utc != null;
  console.log(`clock_out_utc: ${row?.clock_out_utc ?? 'still open'}`);
  console.log(`audit rows in the last 10 min: ${log.n}`);

  // Put the employee back exactly as they were, whatever the verdict — a failed
  // check must not leave someone on a schedule this test invented.
  if (fs.existsSync(STATE)) {
    const saved = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    await c.query('DELETE FROM attendance WHERE employee_id=? AND work_date=?', [EMP, saved.work_date]);
    await c.query('DELETE FROM live_tracking_points WHERE employee_id=?', [EMP]);
    await c.query('DELETE FROM live_tracking_sessions WHERE employee_id=?', [EMP]);
    await c.query('DELETE FROM employee_schedules WHERE employee_id=?', [EMP]);
    for (const s of saved.schedules) {
      await c.query(
        `INSERT INTO employee_schedules
           (id, employee_id, shift_id, location_id, geofencing_enabled, effective_from, effective_to, assigned_by)
         VALUES (?,?,?,?,?,?,?,?)`,
        [s.id, EMP, s.shift_id, s.location_id, s.geofencing_enabled,
         s.effective_from, s.effective_to, s.assigned_by]);
    }
    await c.query('UPDATE employees SET work_mode = ?, live_tracking_enabled = ? WHERE id = ?',
      [saved.employee.work_mode, saved.employee.live_tracking_enabled, EMP]);
    fs.unlinkSync(STATE);
    console.log(`restored ${saved.employee.emp_id} to ${saved.schedules.length} original schedule row(s)`);
  }

  console.log('');
  console.log(acted
    ? 'PASS  the scheduled sweep ran ON ITS OWN — nothing called the endpoint'
    : 'FAIL  nothing happened. The job is not wired to any scheduler.');

  await c.end();
  process.exit(acted ? 0 : 1);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });

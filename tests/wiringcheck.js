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
const EMP = 6;
const MODE = process.argv[2];

(async () => {
  const c = await mysql.createConnection({
    host: env.DB_HOST, user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME, timezone: '+00:00' });
  const [[site]] = await c.query('SELECT id FROM locations WHERE is_active=TRUE LIMIT 1');
  const [[wd]] = await c.query(
    "SELECT DATE_FORMAT(DATE(DATE_SUB(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+05:30'), INTERVAL 7 HOUR)),'%Y-%m-%d') AS d");

  if (MODE === 'seed') {
    // Someone clocked in 90 minutes ago whose presence has never been
    // confirmed inside the fence. The watchdog must end their day.
    await c.query('DELETE FROM attendance WHERE employee_id=?', [EMP]);
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
    console.log('seeded: employee 6 clocked in 90 min ago, presence never confirmed');
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
  console.log('');
  console.log(acted
    ? 'PASS  the scheduled sweep ran ON ITS OWN — nothing called the endpoint'
    : 'FAIL  nothing happened. The job is not wired to any scheduler.');

  await c.end();
  process.exit(acted ? 0 : 1);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });

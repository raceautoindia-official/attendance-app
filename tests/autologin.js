// Coming back to the site must clock you back in — even when the SERVER was
// what clocked you out.
//
// The phone re-opened a day only if the PHONE had closed it. In production the
// server's away-from-site watchdog closes nearly all of them, because it is the
// half that still works once the app has been swiped away. So the phone treated
// every real clock-out as deliberate: it refused to clock back in and called
// stopGeofenceAutoMode(), which tears the geofence down for the rest of the day.
//
// Every single re-entry in production was recorded as auto: false. People were
// clocked out for stepping away and never clocked back in, on a phone that had
// also quietly stopped watching.
//
//   node tests/autologin.js
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
const RADIUS = 50;
const CRON = process.env.CRON_SECRET || 'test-cron-secret-local-only';

let pass = 0, fail = 0;
const check = (l, c, d) => c
  ? (pass++, console.log(`  PASS  ${l}`))
  : (fail++, console.log(`  FAIL  ${l}${d !== undefined ? ` — ${d}` : ''}`));

const tok = jwt.sign({ id: EMP, emp_id: 'REENA001', role: 'employee', tv: 0 },
  env.JWT_ACCESS_SECRET, { expiresIn: '30m' });
const hdrs = { 'Content-Type': 'application/json', 'user-agent': UA,
               'x-device-id': 'autologin-phone', Authorization: `Bearer ${tok}` };
const north = (lat, m) => lat + m / 111320;
const ago = (min) => new Date(Date.now() - min * 60000).toISOString().slice(0, 19).replace('T', ' ');

const today = async () => (await (await fetch(`${BASE}/api/attendance/today`, { headers: hdrs })).json()).data;
const sweep = () => fetch(`${BASE}/api/cron/live-tracking-monitor`,
  { method: 'POST', headers: { 'x-cron-secret': CRON } });

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
  const [[wd]] = await c.query(
    "SELECT DATE_FORMAT(DATE(DATE_SUB(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+05:30'), INTERVAL 7 HOUR)),'%Y-%m-%d') AS d");

  const wipe = async () => {
    await c.query('DELETE FROM attendance WHERE employee_id = ?', [EMP]);
    await c.query('DELETE FROM live_tracking_points WHERE employee_id = ?', [EMP]);
    await c.query('DELETE FROM live_tracking_sessions WHERE employee_id = ?', [EMP]);
    await c.query('DELETE FROM employee_devices WHERE employee_id = ?', [EMP]);
  };

  const restore = async () => {
    await wipe();
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

  try {
    await c.query('UPDATE locations SET radius_meters = ? WHERE id = ?', [RADIUS, site.id]);
    await c.query('DELETE FROM employee_schedules WHERE employee_id = ?', [EMP]);
    await c.query(
      `INSERT INTO employee_schedules (employee_id, shift_id, location_id, geofencing_enabled, effective_from)
       VALUES (?, (SELECT MIN(id) FROM shifts), ?, TRUE, '2026-01-01')`, [EMP, site.id]);
    await c.query(
      "UPDATE employees SET work_mode='on_site', live_tracking_enabled=TRUE, allow_multiple_sessions=TRUE WHERE id=?",
      [EMP]);
    await wipe();

    // A shift that started two hours ago, seen inside 90 minutes ago and 200 m
    // away ever since — the watchdog will end it.
    const plantWalkOut = async () => {
      await wipe();
      await c.query(
        `INSERT INTO attendance (employee_id, work_date, clock_in_utc, status, banked_minutes, session_count)
         VALUES (?, ?, ?, 'present', 0, 1)`, [EMP, wd.d, ago(120)]);
      const [s] = await c.query(
        `INSERT INTO live_tracking_sessions (employee_id, started_at_utc, is_active, last_ping_utc)
         VALUES (?, ?, TRUE, ?)`, [EMP, ago(120), ago(1)]);
      await c.query(
        `INSERT INTO live_tracking_points (session_id, employee_id, latitude, longitude, accuracy_meters, tracked_at_utc)
         VALUES (?,?,?,?,5,?)`, [s.insertId, EMP, LAT, LNG, ago(90)]);
      for (const m of [60, 30, 10, 1]) {
        await c.query(
          `INSERT INTO live_tracking_points (session_id, employee_id, latitude, longitude, accuracy_meters, tracked_at_utc)
           VALUES (?,?,?,?,5,?)`, [s.insertId, EMP, north(LAT, 200), LNG, ago(m)]);
      }
    };

    console.log('\n1. The watchdog ends the day, and says so');
    await plantWalkOut();
    await sweep();
    const afterWatchdog = await today();
    console.log(`   clocked out: ${afterWatchdog?.attendance?.clock_out_utc != null}` +
                `  auto_clocked_out: ${afterWatchdog?.attendance?.auto_clocked_out}`);
    check('the watchdog closed the session', afterWatchdog?.attendance?.clock_out_utc != null);
    check('today tells the phone it was AUTOMATIC — the whole fix',
      afterWatchdog?.attendance?.auto_clocked_out === true,
      String(afterWatchdog?.attendance?.auto_clocked_out));

    console.log('\n2. Returning to the site clocks them back in');
    const back = await fetch(`${BASE}/api/attendance/clock-in`, {
      method: 'POST', headers: hdrs,
      body: JSON.stringify({ latitude: LAT, longitude: LNG, auto: true }) });
    const backJson = await back.json();
    console.log(`   ${back.status} ${backJson.error ?? 'accepted'}`);
    check('the server accepts the automatic re-entry', back.status === 201,
      `${back.status} ${backJson.error ?? ''}`);
    const reopened = await today();
    check('the day is open again', reopened?.attendance?.clock_out_utc == null);
    check('and no longer flagged as auto-closed', reopened?.attendance?.auto_clocked_out === false,
      String(reopened?.attendance?.auto_clocked_out));

    console.log('\n3. A MANUAL clock-out is not an invitation to reopen');
    await wipe();
    const in2 = await fetch(`${BASE}/api/attendance/clock-in`, {
      method: 'POST', headers: hdrs, body: JSON.stringify({ latitude: LAT, longitude: LNG }) });
    check('clock in', in2.status === 201, in2.status);
    const out2 = await fetch(`${BASE}/api/attendance/clock-out`, {
      method: 'POST', headers: hdrs, body: JSON.stringify({ latitude: LAT, longitude: LNG }) });
    check('clock out by hand', out2.status === 200, out2.status);
    const afterManual = await today();
    console.log(`   auto_clocked_out: ${afterManual?.attendance?.auto_clocked_out}`);
    check('a manual clock-out is NOT reported as automatic',
      afterManual?.attendance?.auto_clocked_out === false,
      String(afterManual?.attendance?.auto_clocked_out));

    console.log('\n4. The phone acts on it — both paths');
    const src = fs.readFileSync(path.join(ROOT, 'mobile/src/location/geofenceAuto.ts'), 'utf8');
    // The live OS-geofence Enter handler.
    check('the Enter handler accepts a watchdog closure',
      /closedForLeaving[\s\S]{0,200}auto_clocked_out === true/.test(src));
    check('it no longer tears the geofence down for one',
      /if \(!closedForLeaving\) \{[\s\S]{0,80}stopGeofenceAutoMode/.test(src));
    // The repair path, which runs on app open and from the periodic watch —
    // the one that catches a missed OS geofence event.
    // Scoped to the function body rather than a character-distance window —
    // the first version of this check failed purely because the code had been
    // wrapped over more lines than the regex allowed for.
    const reconcile = src.slice(src.indexOf('export async function reconcileGeofenceAttendance'));
    const reconcileBody = reconcile.slice(0, reconcile.indexOf('\n}'));
    check('the reconcile repair path accepts it too',
      reconcileBody.includes('auto_clocked_out === true') && reconcileBody.includes('doAutoClockIn'),
      reconcileBody.includes('doAutoClockIn') ? 'no auto_clocked_out check' : 'function body not found');
    check('an older server without the field falls back safely, not to a crash',
      /auto_clocked_out\?: boolean/.test(src));
  } finally {
    await restore();
    await c.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });

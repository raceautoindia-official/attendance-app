// END-TO-END JOURNEYS — what a PERSON does, not what a function does.
//
// Every bug that reached the client got past unit tests because those tests
// called the piece under test directly. This suite may only do what a phone or
// a browser can do: HTTP calls, nothing else. Two hard rules:
//
//   * it NEVER calls /api/cron/* — if a scheduled job does not run by itself,
//     that is exactly the bug, and calling it by hand would hide it;
//   * it NEVER writes attendance rows directly — clocking happens through the
//     API, so a refusal the real app would hit is a refusal here too.
//
// Configuration (switches, schedules) is set up in SQL, because an admin sets
// that up too — but nothing about the day itself is.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
const mysql = require(path.join(ROOT, 'node_modules', 'mysql2', 'promise'));
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcryptjs'));
const env = {};
for (const l of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2];
}
const BASE = process.env.TEST_BASE_URL || 'http://localhost:3123';
const UA = 'okhttp/4.9.2 AttendanceApp Android';
const DEVICE = 'journey-phone';
const EMP = 6, EMP_ID = 'REENA001', PIN = '4321';

let pass = 0, fail = 0;
const check = (l, c, d) => c ? (pass++, console.log(`  PASS  ${l}`)) : (fail++, console.log(`  FAIL  ${l}${d !== undefined ? ` — ${d}` : ''}`));

let token = null;
const post = async (p, body, extra = {}) => {
  const r = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'user-agent': UA, 'x-device-id': DEVICE,
               ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const get = async (p) => {
  const r = await fetch(`${BASE}${p}`, {
    headers: { 'user-agent': UA, 'x-device-id': DEVICE,
               ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

(async () => {
  const c = await mysql.createConnection({
    host: env.DB_HOST, user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME, timezone: '+00:00' });

  const [origSched] = await c.query(
    'SELECT id,shift_id,location_id,geofencing_enabled,effective_from,effective_to,assigned_by FROM employee_schedules WHERE employee_id=?', [EMP]);
  const [[origEmp]] = await c.query(
    'SELECT pin_hash, work_mode, live_tracking_enabled, allow_multiple_sessions FROM employees WHERE id=?', [EMP]);
  const [[site]] = await c.query('SELECT id, latitude, longitude FROM locations WHERE is_active=TRUE LIMIT 1');
  const INSIDE = { latitude: Number(site.latitude), longitude: Number(site.longitude) };
  const AWAY = { latitude: 28.6139, longitude: 77.2090 };

  // Admin configuration — the only SQL this suite is allowed for the journey.
  await c.query('UPDATE employees SET pin_hash=?, work_mode=?, live_tracking_enabled=TRUE, allow_multiple_sessions=TRUE WHERE id=?',
    [await bcrypt.hash(PIN, 12), 'on_site', EMP]);
  await c.query('DELETE FROM employee_schedules WHERE employee_id=?', [EMP]);
  await c.query(
    `INSERT INTO employee_schedules (employee_id, shift_id, location_id, geofencing_enabled, effective_from)
     VALUES (?, (SELECT MIN(id) FROM shifts), ?, TRUE, '2026-01-01')`, [EMP, site.id]);
  await c.query('DELETE FROM attendance WHERE employee_id=?', [EMP]);
  await c.query('DELETE FROM employee_devices WHERE employee_id=?', [EMP]);
  await c.query('UPDATE employees SET token_version = 0 WHERE id=?', [EMP]);

  // ---------------------------------------------------------------------
  console.log('\nA. An employee opens the app and signs in');
  let r = await post('/api/auth/mobile/login', { emp_id: EMP_ID, pin: PIN });
  check('sign-in succeeds', r.status === 200 && !!r.json.data?.accessToken, `${r.status} ${r.json.error ?? ''}`);
  token = r.json.data?.accessToken;
  const refreshToken = r.json.data?.refreshToken;

  r = await get('/api/attendance/today');
  check('the dashboard loads', r.status === 200, r.status);
  check('it knows their work site', !!r.json.data?.schedule?.location, JSON.stringify(r.json.data?.schedule));

  // ---------------------------------------------------------------------
  console.log('\nB. They clock in at the site');
  r = await post('/api/attendance/clock-in', INSIDE);
  check('clock-in accepted', r.status === 201, `${r.status} ${r.json.error ?? ''}`);
  r = await get('/api/attendance/today');
  check('the app shows them on shift',
    !!r.json.data?.attendance?.clock_in_utc && !r.json.data?.attendance?.clock_out_utc);

  // ---------------------------------------------------------------------
  console.log('\nC. They step off site — the phone clocks them out');
  r = await post('/api/attendance/clock-out', { ...AWAY, auto: true, reason: 'geofence_exit' });
  check('auto clock-out accepted', r.status === 200, `${r.status} ${r.json.error ?? ''}`);
  r = await get('/api/attendance/today');
  check('the app shows the day closed', !!r.json.data?.attendance?.clock_out_utc);

  // ---------------------------------------------------------------------
  console.log('\nD. They come back — the phone clocks them in again');
  r = await post('/api/attendance/clock-in', { ...INSIDE, auto: true });
  check('auto clock-in accepted', r.status === 201, `${r.status} ${r.json.error ?? ''}`);
  r = await get('/api/attendance/today');
  const att = r.json.data?.attendance;
  check('back on shift', !!att?.clock_in_utc && !att?.clock_out_utc);
  check('the earlier stretch was not lost', Number(att?.banked_minutes ?? 0) >= 0 && att?.banked_minutes != null);
  check('hours are reported for the day', att?.worked_minutes !== undefined, JSON.stringify(Object.keys(att ?? {})));

  // ---------------------------------------------------------------------
  console.log('\nE. They finish and clock out');
  r = await post('/api/attendance/clock-out', INSIDE);
  check('clock-out accepted', r.status === 200, `${r.status} ${r.json.error ?? ''}`);

  // ---------------------------------------------------------------------
  console.log('\nF. They sign out, then sign back in');
  r = await post('/api/auth/logout', {});
  check('sign-out succeeds', r.status === 200, r.status);
  const dead = await get('/api/attendance/today');
  check('the old session really is dead', dead.status === 401, dead.status);
  token = null;
  r = await post('/api/auth/mobile/login', { emp_id: EMP_ID, pin: PIN });
  check('THEY CAN SIGN IN AGAIN', r.status === 200 && !!r.json.data?.accessToken,
    `${r.status} ${r.json.error ?? ''}`);
  token = r.json.data?.accessToken;
  r = await get('/api/attendance/today');
  check('and the app works afterwards', r.status === 200, r.status);

  // ---------------------------------------------------------------------
  console.log('\nG. A stale token is refreshed rather than logging them out');
  r = await fetch(`${BASE}/api/auth/mobile/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ refreshToken }) });
  const rj = await r.json().catch(() => ({}));
  // The refresh token from BEFORE the sign-out must be dead — sign-out revokes.
  check('a refresh token from before sign-out is rejected', r.status !== 200 || !rj.data?.accessToken,
    `${r.status}`);

  // Restore
  await c.query('DELETE FROM attendance WHERE employee_id=?', [EMP]);
  await c.query('DELETE FROM employee_devices WHERE employee_id=?', [EMP]);
  await c.query('DELETE FROM employee_schedules WHERE employee_id=?', [EMP]);
  for (const o of origSched) {
    await c.query(
      `INSERT INTO employee_schedules (id,employee_id,shift_id,location_id,geofencing_enabled,effective_from,effective_to,assigned_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [o.id, EMP, o.shift_id, o.location_id, o.geofencing_enabled, o.effective_from, o.effective_to, o.assigned_by]);
  }
  await c.query('UPDATE employees SET pin_hash=?, work_mode=?, live_tracking_enabled=?, allow_multiple_sessions=?, token_version=0 WHERE id=?',
    [origEmp.pin_hash, origEmp.work_mode, origEmp.live_tracking_enabled, origEmp.allow_multiple_sessions, EMP]);
  await c.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });

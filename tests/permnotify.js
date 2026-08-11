// An approved (or rejected) permission must actually REACH the employee.
//
// Approval used to change a status in a list nobody was looking at; employees
// found out by asking. There is no push server, so the design is: the server
// carries recent decisions in /api/attendance/today — which the phone polls
// from the dashboard and the background watch anyway — and the phone raises a
// local notification once per decision, remembering what it has announced.
//
// This tests the server half over HTTP, and pins the phone half's wiring.
//
//   node tests/permnotify.js
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
const empHdrs = { 'Content-Type': 'application/json', 'user-agent': UA, Authorization: `Bearer ${empTok}` };

(async () => {
  const c = await mysql.createConnection({
    host: env.DB_HOST, user: env.DB_USER, password: env.DB_PASSWORD,
    database: env.DB_NAME, timezone: '+00:00' });

  const [[admin]] = await c.query(
    "SELECT id, emp_id FROM employees WHERE role = 'super_admin' AND is_active = TRUE ORDER BY id LIMIT 1");
  const adminTok = jwt.sign({ id: admin.id, emp_id: admin.emp_id, role: 'super_admin', tv: 0 },
    env.JWT_ACCESS_SECRET, { expiresIn: '30m' });
  const adminHdrs = { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` };

  const wipe = () => c.query('DELETE FROM permission_requests WHERE employee_id = ?', [EMP]);
  const todayUpdates = async () => {
    const j = await (await fetch(`${BASE}/api/attendance/today`, { headers: empHdrs })).json();
    return j.data?.permission_updates ?? [];
  };
  const file = async (start, end) => {
    const [[d]] = await c.query(
      "SELECT DATE_FORMAT(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+05:30'), '%Y-%m-%d') AS d");
    const r = await fetch(`${BASE}/api/permissions`, {
      method: 'POST', headers: empHdrs,
      body: JSON.stringify({ permission_date: d.d, start_time: start, end_time: end, reason: 'permnotify test' }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`file failed ${r.status}: ${j.error}`);
    return j.data?.permission?.id ?? j.data?.id;
  };
  const review = (id, action, notes) => fetch(`${BASE}/api/permissions/${id}`, {
    method: 'PATCH', headers: adminHdrs,
    body: JSON.stringify({ action, review_notes: notes ?? null }) });

  try {
    await wipe();

    console.log('\n1. Filed but not yet reviewed — nothing to announce');
    const id1 = await file('10:00', '11:00');
    check('request filed', Number.isInteger(id1), id1);
    let ups = await todayUpdates();
    check('today carries no update while pending', !ups.some(u => u.id === id1),
      JSON.stringify(ups));

    console.log('\n2. Approved — the verdict rides the poll the phone already makes');
    let r = await review(id1, 'approve', 'Take the time');
    check('approved', r.status === 200, r.status);
    ups = await todayUpdates();
    const mine = ups.find(u => u.id === id1);
    check('the decision is in /today', !!mine, JSON.stringify(ups).slice(0, 120));
    check('as approved', mine?.status === 'approved', mine?.status);
    check('with the note the admin wrote', mine?.review_notes === 'Take the time', mine?.review_notes);
    check('and the window the employee asked for',
      mine?.start_time?.startsWith('10:00') && mine?.end_time?.startsWith('11:00'),
      `${mine?.start_time}-${mine?.end_time}`);

    console.log('\n3. Rejected decisions travel the same way');
    const id2 = await file('15:00', '15:30');
    await review(id2, 'reject', 'Month quota spent');
    ups = await todayUpdates();
    check('rejection present with its reason',
      ups.some(u => u.id === id2 && u.status === 'rejected' && u.review_notes === 'Month quota spent'));

    console.log('\n4. A request the employee cancelled THEMSELVES is not announced');
    const id3 = await file('16:00', '16:30');
    r = await fetch(`${BASE}/api/permissions/${id3}`, {
      method: 'PATCH', headers: empHdrs, body: JSON.stringify({ action: 'cancel' }) });
    check('cancelled by the employee', r.status === 200, r.status);
    ups = await todayUpdates();
    check('no update for their own cancellation', !ups.some(u => u.id === id3));

    console.log('\n5. Old decisions age out of the feed');
    await c.query(
      `UPDATE permission_requests SET reviewed_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 DAY) WHERE id = ?`,
      [id1]);
    ups = await todayUpdates();
    check('a 5-day-old decision is no longer carried', !ups.some(u => u.id === id1));

    console.log('\n6. The phone is wired to announce, both when open and in the background');
    const dash = fs.readFileSync(path.join(ROOT, 'mobile/src/screens/DashboardScreen.tsx'), 'utf8');
    const watch = fs.readFileSync(path.join(ROOT, 'mobile/src/location/locationWatch.ts'), 'utf8');
    const mod = fs.readFileSync(path.join(ROOT, 'mobile/src/notifications/permissionUpdates.ts'), 'utf8');
    check('dashboard announces on refresh', dash.includes('notifyPermissionUpdates(data.permission_updates)'));
    check('background watch announces too', watch.includes('notifyPermissionUpdates(today.permission_updates)'));
    check('each decision is announced once (dedup by id)',
      mod.includes('!seen.includes(u.id)'));
    check('a failed notification is retried, not swallowed',
      /catch[\s\S]{0,200}continue;[\s\S]{0,80}seen\.push/.test(mod));

    console.log('\n7. The heartbeat outlives the shift — closed-app delivery');
    // The background announce used to ride the location watch, which stops
    // when someone is off shift or untracked — exactly the person waiting to
    // hear about tomorrow's permission. The inbox poller is its own task:
    // started at login, stopped ONLY at logout.
    const poller = fs.readFileSync(path.join(ROOT, 'mobile/src/notifications/inboxPoller.ts'), 'utf8');
    check('a dedicated background task polls the inbox',
      poller.includes('defineTask(INBOX_TASK') && poller.includes('notifyPermissionUpdates'));
    check('registered when the dashboard loads', dash.includes('void startInboxPoller();'));
    const logoutStart = dash.indexOf('const handleLogout');
    // Search for the end FROM the start — an earlier onLogout() call (the
    // session-expiry path) otherwise yields an empty slice and a false FAIL.
    const logoutFn = dash.slice(logoutStart, dash.indexOf('onLogout();', logoutStart));
    check('stopped at logout', logoutFn.includes('stopInboxPoller'));
    check('clock-out does NOT stop it — off-shift staff still get verdicts',
      (dash.match(/stopInboxPoller/g) || []).length === 2 /* import + logout only */);
    check('it asks for notification permission itself, not only tracking',
      poller.includes('POST_NOTIFICATIONS'));

  } finally {
    await wipe();
    await c.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });

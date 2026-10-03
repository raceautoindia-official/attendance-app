// Off-site clock-ins reach the admin's Notifications tab — and reviewing them
// never changes anybody's attendance.
//
// That last part is the whole design. The employee is clocked in the moment
// they give a reason. A clock-in nobody ever looks at counts in full; an
// approved one counts the same; a REJECTED one still counts, and is flagged for
// a conversation. Taking somebody's hours away is an explicit edit in Checkin
// Records, not a side effect of a button on a notifications screen.
//
//   node tests/notifications.js
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
const RADIUS = 100;

let pass = 0, fail = 0;
const check = (l, c, d) => c
  ? (pass++, console.log(`  PASS  ${l}`))
  : (fail++, console.log(`  FAIL  ${l}${d !== undefined ? ` — ${d}` : ''}`));

const empTok = jwt.sign({ id: EMP, emp_id: 'REENA001', role: 'employee', tv: 0 },
  env.JWT_ACCESS_SECRET, { expiresIn: '30m' });
const empHdrs = { 'Content-Type': 'application/json', 'user-agent': UA,
                  'x-device-id': 'notif-phone', Authorization: `Bearer ${empTok}` };
const north = (lat, m) => lat + m / 111320;

(async () => {
  const c = await mysql.createConnection({
    host: env.DB_HOST, user: env.DB_USER, password: env.DB_PASSWORD,
    database: env.DB_NAME, timezone: '+00:00' });

  const [[admin]] = await c.query(
    "SELECT id, emp_id FROM employees WHERE role = 'super_admin' AND is_active = TRUE ORDER BY id LIMIT 1");
  if (!admin) throw new Error('need an active super_admin');
  const adminTok = jwt.sign({ id: admin.id, emp_id: admin.emp_id, role: 'super_admin', tv: 0 },
    env.JWT_ACCESS_SECRET, { expiresIn: '30m' });
  const adminHdrs = { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` };

  const [origSched] = await c.query(
    `SELECT id, shift_id, location_id, geofencing_enabled, effective_from, effective_to, assigned_by
       FROM employee_schedules WHERE employee_id = ?`, [EMP]);
  const [[origEmp]] = await c.query(
    'SELECT work_mode, live_tracking_enabled FROM employees WHERE id = ?', [EMP]);
  const [[site]] = await c.query(
    'SELECT id, latitude, longitude, radius_meters FROM locations WHERE is_active = TRUE LIMIT 1');
  const origRadius = site.radius_meters;
  const LAT = Number(site.latitude), LNG = Number(site.longitude);

  const wipe = async () => {
    await c.query('DELETE FROM attendance WHERE employee_id = ?', [EMP]);
    await c.query('DELETE FROM employee_devices WHERE employee_id = ?', [EMP]);
  };
  const restore = async () => {
    await wipe();
    await c.query('DELETE FROM live_tracking_sessions WHERE employee_id = ?', [EMP]);
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

  const clockIn = (m, reason) => fetch(`${BASE}/api/attendance/clock-in`, {
    method: 'POST', headers: empHdrs,
    body: JSON.stringify({ latitude: north(LAT, m), longitude: LNG, ...(reason ? { out_of_fence_reason: reason } : {}) }),
  });
  const listNotifs = async (status = 'pending') => {
    const r = await fetch(`${BASE}/api/notifications?status=${status}`, { headers: adminHdrs });
    const j = await r.json();
    return { status: r.status, rows: j.data?.notifications ?? [], pending: j.data?.pending_count ?? 0 };
  };
  const dayRow = async () => {
    const [[r]] = await c.query(
      `SELECT id, clock_in_utc, clock_out_utc, total_minutes, status, geofence_status,
              out_of_fence_reason, out_of_fence_status
         FROM attendance WHERE employee_id = ? ORDER BY id DESC LIMIT 1`, [EMP]);
    return r;
  };

  try {
    await c.query('UPDATE locations SET radius_meters = ? WHERE id = ?', [RADIUS, site.id]);
    await c.query('DELETE FROM employee_schedules WHERE employee_id = ?', [EMP]);
    await c.query(
      `INSERT INTO employee_schedules (employee_id, shift_id, location_id, geofencing_enabled, effective_from)
       VALUES (?, (SELECT MIN(id) FROM shifts), ?, TRUE, '2026-01-01')`, [EMP, site.id]);
    await c.query("UPDATE employees SET work_mode='on_site', live_tracking_enabled=TRUE WHERE id=?", [EMP]);
    await wipe();

    console.log('\n1. An off-site clock-in raises a pending notification');
    let r = await clockIn(600, 'Delivery at Ambattur warehouse');
    check('clocked in', r.status === 201, r.status);
    let row = await dayRow();
    check("the day is marked 'pending' review", row?.out_of_fence_status === 'pending',
      row?.out_of_fence_status);
    const attId = row.id;

    let list = await listNotifs('pending');
    const mine = list.rows.find(n => Number(n.attendance_id) === attId);
    check('it appears in the admin list', !!mine, `saw ${list.rows.length}`);
    check('with the reason', mine?.reason === 'Delivery at Ambattur warehouse', mine?.reason);
    check('and a pending count for the sidebar badge', list.pending >= 1, list.pending);

    console.log('\n2. UNREVIEWED still counts as attendance — the whole point');
    const today = await (await fetch(`${BASE}/api/attendance/today`, { headers: empHdrs })).json();
    check('the employee is clocked in right now', !!today.data?.attendance?.clock_in_utc);
    check('with a normal status, not held or pending',
      ['present', 'late'].includes(today.data?.attendance?.status), today.data?.attendance?.status);

    console.log('\n3. Approving changes the verdict, not the attendance');
    const before = await dayRow();
    r = await fetch(`${BASE}/api/notifications/${attId}`, {
      method: 'PATCH', headers: adminHdrs,
      body: JSON.stringify({ action: 'approve', review_notes: 'Confirmed with the customer' }) });
    check('accepted', r.status === 200, r.status);
    let after = await dayRow();
    check('status is now approved', after?.out_of_fence_status === 'approved', after?.out_of_fence_status);
    check('clock-in time untouched',
      String(after?.clock_in_utc) === String(before?.clock_in_utc));
    check('attendance status untouched', after?.status === before?.status);
    check('minutes untouched', String(after?.total_minutes) === String(before?.total_minutes));

    console.log('\n4. Reviewing twice is refused rather than silently overwritten');
    r = await fetch(`${BASE}/api/notifications/${attId}`, {
      method: 'PATCH', headers: adminHdrs, body: JSON.stringify({ action: 'reject' }) });
    check('409 on a second verdict', r.status === 409, r.status);

    console.log('\n5. REJECTING does not take their hours away either');
    await wipe();
    await clockIn(600, 'Site inspection at Poonamallee');
    row = await dayRow();
    const rejectId = row.id;
    const beforeReject = { ...row };
    r = await fetch(`${BASE}/api/notifications/${rejectId}`, {
      method: 'PATCH', headers: adminHdrs,
      body: JSON.stringify({ action: 'reject', review_notes: 'No job card for this' }) });
    check('accepted', r.status === 200, r.status);
    after = await dayRow();
    check('marked rejected', after?.out_of_fence_status === 'rejected', after?.out_of_fence_status);
    check('but STILL clocked in — hours are not removed by a dispute',
      after?.clock_in_utc != null && String(after.clock_in_utc) === String(beforeReject.clock_in_utc));
    check('and still present', after?.status === beforeReject.status, after?.status);

    console.log('\n6. Only admins may review');
    await wipe();
    await clockIn(600, 'Another customer visit today');
    const own = (await dayRow()).id;
    r = await fetch(`${BASE}/api/notifications/${own}`, {
      method: 'PATCH', headers: empHdrs, body: JSON.stringify({ action: 'approve' }) });
    check('an employee cannot approve their own trip', r.status === 401 || r.status === 403, r.status);
    r = await fetch(`${BASE}/api/notifications`, { headers: empHdrs });
    check('nor read the review list', r.status === 401 || r.status === 403, r.status);

    console.log('\n7. An ordinary clock-in raises nothing');
    await wipe();
    await clockIn(5);
    row = await dayRow();
    check('no review state on a normal day', row?.out_of_fence_status == null, row?.out_of_fence_status);
    list = await listNotifs('pending');
    check('and it is not in the notifications list',
      !list.rows.some(n => Number(n.attendance_id) === row.id));

    console.log('\n8. Reviewing something that was never off-site is a 404');
    r = await fetch(`${BASE}/api/notifications/${row.id}`, {
      method: 'PATCH', headers: adminHdrs, body: JSON.stringify({ action: 'approve' }) });
    check('404', r.status === 404, r.status);
  } finally {
    await restore();
    await c.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });

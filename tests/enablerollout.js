// Arming auto logout must NEVER arm a phone that is not reporting.
//
// Silence is treated as absence — deliberately, so force-stopping the app does
// not buy you a paid afternoon. That makes arming a dead phone actively harmful:
// it closes the day at the last confirmed presence and the person loses hours
// they really worked. Running the old unfiltered script would have taken about
// seven hours each off six people.
//
// So: the script runs as a dry run by default and changes nothing, and when it
// does run it arms only staff whose phone has been heard from recently.
//
//   node tests/enablerollout.js
//
// Database only — no server needed. Everything it touches is restored.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const mysql = require(path.join(ROOT, 'node_modules', 'mysql2', 'promise'));
const env = {};
for (const l of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2];
}

let pass = 0, fail = 0;
const check = (l, c, d) => c
  ? (pass++, console.log(`  PASS  ${l}`))
  : (fail++, console.log(`  FAIL  ${l}${d !== undefined ? ` — ${d}` : ''}`));

const SCRIPT = path.join(ROOT, 'database', 'enable_auto_logout.sql');

/** The script as written, optionally flipped out of dry-run mode. */
function loadScript({ apply }) {
  const sql = fs.readFileSync(SCRIPT, 'utf8');
  if (!/SET @dry_run := 1;/.test(sql)) {
    throw new Error('enable_auto_logout.sql no longer defaults to a dry run');
  }
  return apply ? sql.replace('SET @dry_run := 1;', 'SET @dry_run := 0;') : sql;
}

(async () => {
  const c = await mysql.createConnection({
    host: env.DB_HOST, user: env.DB_USER, password: env.DB_PASSWORD,
    database: env.DB_NAME, multipleStatements: true, timezone: '+00:00',
  });

  // Three employees, one per case we care about.
  const [staff] = await c.query(
    `SELECT id, emp_id, name FROM employees
      WHERE is_active = TRUE AND role = 'employee' ORDER BY id LIMIT 3`);
  if (staff.length < 3) throw new Error('need at least 3 active employees to test with');
  const [REPORTING, SILENT, FIELD] = staff;
  console.log(`  reporting phone : ${REPORTING.emp_id} ${REPORTING.name}`);
  console.log(`  silent phone    : ${SILENT.emp_id} ${SILENT.name}`);
  console.log(`  field staff     : ${FIELD.emp_id} ${FIELD.name}`);
  const ids = staff.map(s => s.id);

  // Clear any test site left behind by an aborted run BEFORE snapshotting.
  // Otherwise the snapshot records a schedule pointing at it, we delete it, and
  // the restore fails on the foreign key — which is how the first run of this
  // test ended.
  await c.query("DELETE FROM locations WHERE name = 'ZZ Rollout Site'");

  // ---- snapshot everything we are about to touch ---------------------------
  const [origEmp] = await c.query(
    'SELECT id, work_mode, live_tracking_enabled FROM employees WHERE id IN (?)', [ids]);
  const [origSched] = await c.query(
    `SELECT id, employee_id, shift_id, location_id, geofencing_enabled,
            effective_from, effective_to, assigned_by
       FROM employee_schedules WHERE employee_id IN (?)`, [ids]);

  // Points need a session (NOT NULL, foreign key). Ours are created ended, so
  // they cannot collide with the one-active-session-per-employee unique key,
  // and deleting the session cascades the points away.
  const sessions = [];
  const addPoint = async (employeeId, agoSql) => {
    const [s] = await c.query(
      `INSERT INTO live_tracking_sessions (employee_id, started_at_utc, ended_at_utc, is_active)
       VALUES (?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), FALSE)`, [employeeId]);
    sessions.push(s.insertId);
    await c.query(
      `INSERT INTO live_tracking_points (session_id, employee_id, tracked_at_utc, latitude, longitude, accuracy_meters)
       VALUES (?, ?, ${agoSql}, 13.0080078, 80.1970224, 8)`,
      [s.insertId, employeeId]);
  };
  const clearPoints = async () => {
    if (sessions.length) await c.query('DELETE FROM live_tracking_sessions WHERE id IN (?)', [sessions]);
    sessions.length = 0;
  };

  const restore = async () => {
    await clearPoints();
    await c.query('DELETE FROM employee_schedules WHERE employee_id IN (?)', [ids]);
    for (const o of origSched) {
      // A location that has since disappeared would fail the foreign key and
      // abandon the restore half done, losing the rest of the schedules. The
      // real column is ON DELETE SET NULL, so NULL is what the row would hold
      // anyway.
      let locId = o.location_id;
      if (locId != null) {
        const [[still]] = await c.query('SELECT id FROM locations WHERE id = ?', [locId]);
        if (!still) {
          console.log(`  note: location ${locId} no longer exists — restoring that schedule without it`);
          locId = null;
        }
      }
      await c.query(
        `INSERT INTO employee_schedules
           (id, employee_id, shift_id, location_id, geofencing_enabled,
            effective_from, effective_to, assigned_by)
         VALUES (?,?,?,?,?,?,?,?)`,
        [o.id, o.employee_id, o.shift_id, locId, o.geofencing_enabled,
         o.effective_from, o.effective_to, o.assigned_by]);
    }
    for (const o of origEmp) {
      await c.query('UPDATE employees SET work_mode = ?, live_tracking_enabled = ? WHERE id = ?',
        [o.work_mode, o.live_tracking_enabled, o.id]);
    }
    await c.query("DELETE FROM locations WHERE name = 'ZZ Rollout Site'");
  };

  try {
    // ---- plant the situation ------------------------------------------------
    await c.query("DELETE FROM locations WHERE name = 'ZZ Rollout Site'");
    const [loc] = await c.query(
      `INSERT INTO locations (name, address, latitude, longitude, radius_meters, is_active)
       VALUES ('ZZ Rollout Site', 'test', 13.0080078, 80.1970224, 50, TRUE)`);

    await c.query('DELETE FROM employee_schedules WHERE employee_id IN (?)', [ids]);
    for (const s of staff) {
      await c.query(
        `INSERT INTO employee_schedules (employee_id, shift_id, location_id, geofencing_enabled, effective_from)
         VALUES (?, (SELECT MIN(id) FROM shifts), ?, FALSE, '2026-01-01')`,
        [s.id, loc.insertId]);
    }
    // Everyone starts on_site and unarmed; the field employee is marked off-site.
    await c.query("UPDATE employees SET work_mode='on_site', live_tracking_enabled=FALSE WHERE id IN (?)", [ids]);
    await c.query("UPDATE employees SET work_mode='off_site' WHERE id = ?", [FIELD.id]);

    // Only ONE phone has reported. The field employee also reports, to prove it
    // is the off-site flag and not silence that keeps them out.
    await clearPoints();
    for (const id of [REPORTING.id, FIELD.id]) {
      await addPoint(id, 'DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 MINUTE)');
    }

    const armed = async id => {
      const [[r]] = await c.query(
        `SELECT e.live_tracking_enabled AS lt, es.geofencing_enabled AS gf, e.work_mode
           FROM employees e
           JOIN employee_schedules es ON es.employee_id = e.id
          WHERE e.id = ?`, [id]);
      return r.lt === 1 && r.gf === 1 && r.work_mode === 'on_site';
    };

    console.log('\n1. The script defaults to a dry run');
    check('enable_auto_logout.sql ships with @dry_run := 1',
      /SET @dry_run := 1;/.test(fs.readFileSync(SCRIPT, 'utf8')));

    console.log('\n2. A dry run changes nothing at all');
    await c.query(loadScript({ apply: false }));
    check('the reporting phone is NOT armed by a dry run', !(await armed(REPORTING.id)));
    check('the silent phone is NOT armed by a dry run', !(await armed(SILENT.id)));

    console.log('\n3. Applying arms only the phone that is reporting');
    await c.query(loadScript({ apply: true }));
    check('reporting phone IS armed', await armed(REPORTING.id));
    check('SILENT phone is left alone — this is the one that costs people hours',
      !(await armed(SILENT.id)));
    check('off-site field staff are left alone', !(await armed(FIELD.id)));

    const [[fieldRow]] = await c.query('SELECT work_mode FROM employees WHERE id = ?', [FIELD.id]);
    check('field staff are not silently converted to on_site',
      fieldRow.work_mode === 'off_site', fieldRow.work_mode);

    console.log('\n4. A phone that went quiet days ago does not count as reporting');
    await clearPoints();
    await addPoint(SILENT.id, 'DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 DAY)');
    await c.query('UPDATE employee_schedules SET geofencing_enabled = FALSE WHERE employee_id IN (?)', [ids]);
    await c.query('UPDATE employees SET live_tracking_enabled = FALSE WHERE id IN (?)', [ids]);
    await c.query(loadScript({ apply: true }));
    check('a fix from 5 days ago does not arm anyone (window is 48h)',
      !(await armed(SILENT.id)));

    console.log('\n5. Re-running is safe');
    await c.query(loadScript({ apply: true }));
    check('still armed, nothing broken', await armed(REPORTING.id));
  } finally {
    await restore();
    await c.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });

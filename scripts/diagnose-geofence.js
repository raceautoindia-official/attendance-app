#!/usr/bin/env node
/**
 * Why did nobody get clocked out when they left the site?
 *
 *   node scripts/diagnose-geofence.js
 *
 * Reads the database on its own (.env.local, then .env) and only ever SELECTs.
 * Nothing is changed by running it, at any hour, as often as you like.
 *
 * WHAT IT IS CHECKING, AND WHY THE ANSWER IS USUALLY THE SAME ONE
 *
 * The watchdog does NOT end a day because a phone went quiet. It ends a day
 * only on positive evidence: at least GEOFENCE_MIN_OUTSIDE_FIXES separate
 * location readings that put the person outside the fence, each one forgiven
 * its own reported accuracy first.
 *
 * That rule was bought expensively. When silence counted as leaving, four
 * people lost an entire day in one morning - "clocked in 09:58, clocked out
 * 09:58, 0h 0m" - because their phones were not reporting at all. A phone
 * killed by battery optimisation at 2pm looks exactly like a phone walking out
 * of the gate at 2pm. Only one of those is the employee's doing.
 *
 * So "auto clock-out is not working" nearly always means the phones stopped
 * sending their location, not that the rule is broken. The sections below are
 * ordered to find out which, and the verdict at the end says it in one line.
 *
 * database/diagnose_geofence.sql asks the same questions in raw SQL, for
 * anyone who would rather read the query than the prose.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Deployments differ: a local checkout uses .env.local, the production server
// uses .env. First file wins per key, so .env.local still overrides .env.
for (const envName of ['.env.local', '.env']) {
  const p = path.join(ROOT, envName);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["'](.*)["']$/, '$1');
  }
}

const mysql = require(path.join(ROOT, 'node_modules/mysql2/promise'));

const GRACE_MIN = Number(process.env.GEOFENCE_PRESENCE_GRACE_MIN) || 30;
const MIN_OUTSIDE = Math.max(1, Number(process.env.GEOFENCE_MIN_OUTSIDE_FIXES) || 3);
const MONITOR_MIN = Math.max(1, Number(process.env.LIVE_MONITOR_INTERVAL_MIN) || 3);

function head(title) {
  console.log('');
  console.log(title);
  console.log('-'.repeat(title.length));
}

/** Pad a grid of strings into aligned columns. */
function grid(rows) {
  if (!rows.length) return;
  const width = rows[0].map(
    (_, i) => Math.max(...rows.map(r => String(r[i] === undefined || r[i] === null ? '' : r[i]).length)),
  );
  for (const r of rows) {
    const line = r
      .map((cell, i) => String(cell === undefined || cell === null ? '' : cell).padEnd(width[i]))
      .join('  ');
    console.log(line.replace(/\s+$/, ''));
  }
}

async function one(c, sql, params) {
  const [rows] = await c.query(sql, params || []);
  return rows[0] || {};
}

async function all(c, sql, params) {
  const [rows] = await c.query(sql, params || []);
  return rows;
}

async function hasColumn(c, tableName, column) {
  const r = await one(
    c,
    'SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS ' +
      'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [tableName, column],
  );
  return Number(r.n) > 0;
}

async function hasTable(c, tableName) {
  const r = await one(
    c,
    'SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES ' +
      'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [tableName],
  );
  return Number(r.n) > 0;
}

async function main() {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  console.log('Geofence auto clock-out - why it did or did not fire');
  console.log('database: ' + process.env.DB_NAME);
  console.log(
    'the rule: somebody must be outside the fence for ' + GRACE_MIN +
      ' minutes, proved by at least ' + MIN_OUTSIDE +
      ' location readings. The check runs every ' + MONITOR_MIN + ' minutes.',
  );

  // -- 1. can it run at all -------------------------------------------------
  head('1. Can the watchdog run at all?');
  const checks = [
    ['employees.work_mode', await hasColumn(c, 'employees', 'work_mode')],
    ['employees.live_tracking_enabled', await hasColumn(c, 'employees', 'live_tracking_enabled')],
    ['employee_schedules.geofencing_enabled', await hasColumn(c, 'employee_schedules', 'geofencing_enabled')],
    ['live_tracking_sessions table', await hasTable(c, 'live_tracking_sessions')],
    ['live_tracking_points table', await hasTable(c, 'live_tracking_points')],
  ];
  for (const row of checks) console.log((row[1] ? '  present  ' : '  MISSING  ') + row[0]);

  const canRun = checks.every(row => row[1]);
  if (!canRun) {
    console.log('');
    console.log('  The watchdog switches itself OFF when these are missing and returns');
    console.log('  without looking at anybody. Nothing below matters until the database');
    console.log('  migration that adds them has been applied.');
    await c.end();
    return;
  }

  // -- 2. who is being watched ----------------------------------------------
  head('2. Who the watchdog is watching');
  const roster = await all(
    c,
    "SELECT e.emp_id, e.name," +
      " COALESCE(e.work_mode, 'unset') AS work_mode," +
      " IF(e.live_tracking_enabled = 1, 'on', 'OFF') AS tracking," +
      " IF(es.geofencing_enabled = 1, 'on', 'OFF') AS fence," +
      " COALESCE(l.name, 'NO SITE SET') AS site," +
      " IF(l.id IS NULL, '-', IF(l.is_active = 1, 'active', 'DEACTIVATED')) AS site_state," +
      ' COALESCE(l.radius_meters, 0) AS radius_m,' +
      " IF(e.work_mode = 'on_site' AND e.live_tracking_enabled = 1" +
      "    AND es.geofencing_enabled = 1 AND l.is_active = 1, 'WATCHED', 'not watched') AS verdict" +
      ' FROM employees e' +
      ' LEFT JOIN employee_schedules es ON es.id = (' +
      '   SELECT id FROM employee_schedules' +
      '    WHERE employee_id = e.id AND effective_from <= CURDATE()' +
      '      AND (effective_to IS NULL OR effective_to >= CURDATE())' +
      '    ORDER BY effective_from DESC, id DESC LIMIT 1)' +
      ' LEFT JOIN locations l ON l.id = es.location_id' +
      ' WHERE e.is_active = TRUE' +
      ' ORDER BY verdict DESC, e.emp_id',
  );

  grid(
    [['ID', 'Name', 'Works', 'Tracking', 'Fence', 'Site', 'Site state', 'Radius', '']].concat(
      roster.map(r => [
        r.emp_id, r.name, r.work_mode, r.tracking, r.fence, r.site, r.site_state,
        r.radius_m + 'm', r.verdict === 'WATCHED' ? '>>> WATCHED' : '',
      ]),
    ),
  );

  const watched = roster.filter(r => r.verdict === 'WATCHED');
  console.log('');
  console.log('  ' + watched.length + ' of ' + roster.length + ' active staff are watched.');
  console.log('  Anyone not watched can never be auto clocked out, whatever their phone does.');

  // -- 3. are the phones reporting ------------------------------------------
  head('3. Are the phones sending their location?');
  const windows = [['last hour', 1], ['last 24 hours', 24], ['last 7 days', 168]];
  for (const w of windows) {
    const r = await one(
      c,
      'SELECT COUNT(*) AS points, COUNT(DISTINCT employee_id) AS phones,' +
        " DATE_FORMAT(CONVERT_TZ(MAX(tracked_at_utc), '+00:00', '+05:30'), '%Y-%m-%d %H:%i') AS last_seen" +
        ' FROM live_tracking_points' +
        ' WHERE tracked_at_utc >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR)',
      [w[1]],
    );
    console.log(
      '  ' + String(w[0]).padEnd(14) + String(r.points).padStart(8) + ' readings from ' +
        String(r.phones).padStart(3) + ' phone(s)' +
        (r.last_seen ? '   last at ' + r.last_seen : ''),
    );
  }

  const recent = await one(
    c,
    'SELECT COUNT(*) AS n FROM live_tracking_points' +
      ' WHERE tracked_at_utc >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)',
  );
  const reporting = Number(recent.n) > 0;
  if (!reporting) {
    console.log('');
    console.log('  No phone has sent a single location in 24 hours.');
    console.log('  With no readings there can be no reading OUTSIDE the fence, so the');
    console.log('  watchdog has nothing to act on and leaves every day open.');
  }

  // -- 4. who is open right now ---------------------------------------------
  head('4. Clocked in right now, and when their phone last spoke');
  const open = await all(
    c,
    'SELECT e.emp_id, e.name,' +
      " DATE_FORMAT(CONVERT_TZ(a.clock_in_utc, '+00:00', '+05:30'), '%H:%i') AS in_ist," +
      ' (SELECT TIMESTAMPDIFF(MINUTE, MAX(p.tracked_at_utc), UTC_TIMESTAMP())' +
      '    FROM live_tracking_points p' +
      '   WHERE p.employee_id = e.id AND p.tracked_at_utc >= a.clock_in_utc) AS silent_min' +
      ' FROM attendance a' +
      ' JOIN employees e ON e.id = a.employee_id' +
      ' WHERE a.clock_out_utc IS NULL AND a.clock_in_utc IS NOT NULL' +
      ' ORDER BY silent_min IS NULL DESC, silent_min DESC',
  );
  if (!open.length) {
    console.log('  Nobody is clocked in.');
  } else {
    grid(
      [['ID', 'Name', 'In at', 'Phone last reported']].concat(
        open.map(r => [
          r.emp_id, r.name, r.in_ist,
          r.silent_min === null ? 'NEVER since clocking in' : r.silent_min + ' min ago',
        ]),
      ),
    );
  }

  // -- 5. what it has actually decided ---------------------------------------
  head('5. What the watchdog has decided, ever');
  const fired = await one(
    c,
    "SELECT COUNT(*) AS n, DATE_FORMAT(CONVERT_TZ(MAX(created_at), '+00:00', '+05:30'), '%Y-%m-%d %H:%i') AS last_at" +
      " FROM audit_log WHERE action = 'geofence_auto_clockout'",
  );
  const quiet = await one(
    c,
    "SELECT COUNT(*) AS n, DATE_FORMAT(CONVERT_TZ(MAX(created_at), '+00:00', '+05:30'), '%Y-%m-%d %H:%i') AS last_at" +
      " FROM audit_log WHERE action = 'geofence_presence_unverifiable'",
  );
  console.log(
    '  ended a day because they left the site    ' + String(fired.n).padStart(5) +
      (fired.last_at ? '   last on ' + fired.last_at : ''),
  );
  console.log(
    '  left a day open because a phone went quiet' + String(quiet.n).padStart(5) +
      (quiet.last_at ? '   last on ' + quiet.last_at : ''),
  );

  if (Number(quiet.n) > 0) {
    const examples = await all(
      c,
      "SELECT DATE_FORMAT(CONVERT_TZ(created_at, '+00:00', '+05:30'), '%Y-%m-%d %H:%i') AS at_ist," +
        " JSON_UNQUOTE(JSON_EXTRACT(details, '$.emp_id')) AS emp_id," +
        " JSON_UNQUOTE(JSON_EXTRACT(details, '$.employee_name')) AS name," +
        " JSON_EXTRACT(details, '$.tracked_minutes') AS tracked_min," +
        " JSON_EXTRACT(details, '$.minutes_unconfirmed') AS silent_min," +
        " JSON_EXTRACT(details, '$.outside_fixes') AS outside" +
        " FROM audit_log WHERE action = 'geofence_presence_unverifiable'" +
        ' ORDER BY created_at DESC LIMIT 10',
    );
    console.log('');
    console.log('  The ten most recent:');
    grid(
      [['  When', 'ID', 'Name', 'Tracked for', 'Then silent', 'Readings outside']].concat(
        examples.map(r => [
          '  ' + r.at_ist, r.emp_id, r.name,
          r.tracked_min + ' min', r.silent_min + ' min',
          r.outside + ' of ' + MIN_OUTSIDE + ' needed',
        ]),
      ),
    );
  }

  // -- the verdict ------------------------------------------------------------
  head('In one line');
  if (!watched.length) {
    console.log('  Nobody is being watched. Look at section 2: a column reading OFF,');
    console.log('  "NO SITE SET", or a work mode that is not on_site is the reason.');
    console.log('  Those are all settings in the app, not faults in the code.');
  } else if (!reporting) {
    console.log('  The phones are not reporting their location, so nothing can be proved');
    console.log('  and no day is ended. The phones need fixing, not the rule:');
    console.log('    - the app must be version 1.4.33 or later');
    console.log('    - location permission must be "Allow all the time", not "while using"');
    console.log('    - battery optimisation must be off for the app');
  } else if (Number(quiet.n) > 0 && Number(fired.n) === 0) {
    console.log('  The watchdog IS running, and is deliberately refusing to end days.');
    console.log('  Section 5 shows why: the phones go silent instead of reporting from');
    console.log('  outside the fence, and silence is not evidence that anybody left.');
    console.log('  Same three phone settings as above.');
  } else if (Number(fired.n) > 0) {
    console.log('  It has worked ' + fired.n + ' time(s), most recently ' + fired.last_at + '.');
    console.log('  If one particular person was missed, read their row in sections 2 and 4.');
  } else {
    console.log('  Everything is configured and the phones are reporting, but the watchdog');
    console.log('  has never had cause to act: nobody has been seen outside their fence for');
    console.log('  ' + GRACE_MIN + ' minutes while still clocked in.');
  }
  console.log('');

  await c.end();
}

main().catch(err => {
  console.error('Could not run the check: ' + (err && err.message ? err.message : err));
  process.exit(1);
});

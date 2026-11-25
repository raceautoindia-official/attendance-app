#!/usr/bin/env node
/**
 * Who ended this person's day, and on what evidence?
 *
 *   node scripts/why-clocked-out.js --emp=RACE013
 *   node scripts/why-clocked-out.js --emp=RACE013 --date=2026-11-25
 *   node scripts/why-clocked-out.js --emp="Reena"
 *
 * Reads the database on its own (.env.local, then .env) and only ever SELECTs.
 * Nothing is changed by running it.
 *
 * WHY THIS NEEDS A SCRIPT AT ALL
 *
 * Five different things can write a clock-out, and the attendance screen shows
 * the same thing for all five - a time, and some hours. It cannot tell you
 * which of these happened:
 *
 *   1. somebody pressed Clock out (phone or web)
 *   2. THE PHONE's own fence rule: it decided its owner had left the site and
 *      ended the day itself, after four warnings about four minutes apart
 *   3. THE PHONE's location-off rule: it could not get a fix at all. The server
 *      refuses this one unless AUTO_CLOCK_OUT_ON_LOCATION_OFF=true
 *   4. THE SERVER's geofence watchdog: location readings placed them outside
 *      the fence, so the day was ended and credited only up to the last moment
 *      their presence inside was confirmed
 *   5. THE NIGHTLY SETTLER: the day was never closed, so it was settled at the
 *      work-day boundary or at the phone's last reading
 *
 * Only 2, 4 and 5 produce the complaint "I did not clock out, and the hours are
 * short". They are told apart by what is in audit_log, which this prints in
 * English, with the location readings around the clock-out so you can see for
 * yourself whether the person was really outside the fence.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

for (const envName of ['.env.local', '.env']) {
  const p = path.join(ROOT, envName);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["'](.*)["']$/, '$1');
  }
}

const mysql = require(path.join(ROOT, 'node_modules/mysql2/promise'));

function arg(name) {
  const hit = process.argv.slice(2).find(a => a === '--' + name || a.startsWith('--' + name + '='));
  if (!hit) return null;
  const eq = hit.indexOf('=');
  return eq === -1 ? '' : hit.slice(eq + 1);
}

const EMP = arg('emp');
const DATE = arg('date');

function head(title) {
  console.log('');
  console.log(title);
  console.log('-'.repeat(title.length));
}

function grid(rows) {
  if (!rows.length) return;
  const w = rows[0].map((_, i) =>
    Math.max(...rows.map(r => String(r[i] === undefined || r[i] === null ? '' : r[i]).length)));
  for (const r of rows) {
    console.log(
      r.map((cell, i) => String(cell === undefined || cell === null ? '' : cell).padEnd(w[i]))
        .join('  ').replace(/\s+$/, ''),
    );
  }
}

function hm(min) {
  if (min === null || min === undefined) return '-';
  const n = Math.round(Number(min));
  return Math.floor(n / 60) + 'h ' + String(n % 60).padStart(2, '0') + 'm';
}

/**
 * An ISO instant from audit_log, as the wall clock in Chennai.
 *
 * Done by arithmetic on the epoch rather than by toLocaleString, so the
 * answer does not depend on the server's own timezone - this runs on a box
 * set to UTC and is read by people in IST.
 */
function istOf(iso) {
  if (!iso) return '?';
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return String(iso);
  const d = new Date(ms + 5.5 * 3600 * 1000);
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}

async function one(c, sql, params) {
  const [rows] = await c.query(sql, params || []);
  return rows[0] || null;
}
async function all(c, sql, params) {
  const [rows] = await c.query(sql, params || []);
  return rows;
}
async function hasColumn(c, t, col) {
  const r = await one(
    c,
    'SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS' +
      ' WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [t, col],
  );
  return Number(r && r.n) > 0;
}

/** details is JSON in MySQL; the driver may hand it back parsed or as text. */
function detailsOf(row) {
  const d = row.details;
  if (!d) return {};
  if (typeof d === 'object') return d;
  try { return JSON.parse(d); } catch (e) { return {}; }
}

/** One audit action, said in words an administrator can act on. */
function explain(action, d, who) {
  switch (action) {
    case 'clock_in':
      return 'Clocked in.';
    case 'clock_out':
      if (d.auto === true && d.reason === 'geofence_exit') {
        return 'THE PHONE ended the day by itself - it decided its owner had left the work site.';
      }
      if (d.auto === true && d.reason === 'location_off') {
        return 'THE PHONE ended the day by itself - it could not get a location fix at all.';
      }
      if (d.auto === true) return 'THE PHONE ended the day by itself (no reason recorded).';
      return 'Somebody pressed Clock out' + (who ? ' - ' + who : '') + '.';
    case 'auto_clock_out_refused':
      return 'The phone TRIED to end the day (' + (d.requested_reason || '?') +
        ') and the server refused it: ' + (d.refused_because || '?') + '. Day left open.';
    case 'geofence_auto_clockout':
      return 'THE SERVER WATCHDOG ended the day: ' +
        (d.reason === 'left_the_fence'
          ? 'location readings placed them outside the fence'
          : 'their presence inside the fence was never confirmed') +
        '. Credited only up to the last confirmed moment inside.';
    case 'geofence_presence_unverifiable':
      return 'The watchdog looked and DECLINED to end the day: the phone went quiet ' +
        'for ' + (d.minutes_unconfirmed ?? '?') + ' min with only ' + (d.outside_fixes ?? 0) +
        ' reading(s) outside. Silence is not evidence of leaving.';
    case 'session_auto_closed':
      return 'THE NIGHTLY SETTLER closed a day nobody had closed' +
        (d.basis ? ' (settled on: ' + d.basis + ')' : '') + '.';
    case 'sessions_auto_closed':
      return 'The nightly settler ran over several people at once.';
    case 'session_continued_across_day':
      return 'Still on site at the work-day boundary, so a fresh day was opened.';
    case 'attendance_edited':
    case 'attendance_updated':
      return 'AN ADMIN EDITED this record' + (who ? ' - ' + who : '') + '.';
    case 'attendance_marked_manually':
      return 'This day was written in by hand' + (who ? ' - ' + who : '') + '.';
    case 'regularisation_approved':
      return 'A correction request was approved' + (who ? ' - ' + who : '') + '.';
    default:
      return action.replace(/_/g, ' ') + (who ? ' - ' + who : '');
  }
}

async function main() {
  if (!EMP) {
    console.error('Which employee? e.g.  node scripts/why-clocked-out.js --emp=RACE013');
    process.exit(1);
  }

  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  const emp = await one(
    c,
    'SELECT id, emp_id, name FROM employees WHERE emp_id = ? OR name LIKE ? ORDER BY (emp_id = ?) DESC LIMIT 1',
    [EMP, '%' + EMP + '%', EMP],
  );
  if (!emp) {
    console.error('No employee matches "' + EMP + '".');
    await c.end();
    process.exit(1);
  }

  const todayRow = await one(
    c,
    "SELECT DATE_FORMAT(DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30')), '%Y-%m-%d') AS d",
  );
  const date = DATE || todayRow.d;

  const hasFirstIn = await hasColumn(c, 'attendance', 'first_clock_in_utc');
  const hasBanked = await hasColumn(c, 'attendance', 'banked_minutes');
  const hasSessions = await hasColumn(c, 'attendance', 'session_count');

  console.log(emp.name + '  (' + emp.emp_id + ')   work date ' + date);
  console.log('database: ' + process.env.DB_NAME + '   all times IST');

  // -- 1. the day as recorded ------------------------------------------------
  head('1. What the record says');
  const att = await one(
    c,
    'SELECT a.id, a.status, a.total_minutes, a.notes,' +
      (hasBanked ? ' a.banked_minutes,' : ' NULL AS banked_minutes,') +
      (hasSessions ? ' a.session_count,' : ' NULL AS session_count,') +
      (hasFirstIn
        ? " DATE_FORMAT(CONVERT_TZ(COALESCE(a.first_clock_in_utc, a.clock_in_utc), '+00:00', '+05:30'), '%H:%i') AS first_in,"
        : " DATE_FORMAT(CONVERT_TZ(a.clock_in_utc, '+00:00', '+05:30'), '%H:%i') AS first_in,") +
      " DATE_FORMAT(CONVERT_TZ(a.clock_in_utc, '+00:00', '+05:30'), '%H:%i') AS last_in," +
      " DATE_FORMAT(CONVERT_TZ(a.clock_out_utc, '+00:00', '+05:30'), '%H:%i') AS out_ist," +
      " DATE_FORMAT(a.clock_out_utc, '%Y-%m-%d %H:%i:%s') AS clock_out_sql" +
      ' FROM attendance a WHERE a.employee_id = ? AND a.work_date = ?',
    [emp.id, date],
  );

  if (!att) {
    console.log('  There is no attendance record for that day at all.');
    await c.end();
    return;
  }

  grid([
    ['  First clock-in', att.first_in || '-'],
    ['  Clock-out', att.out_ist || 'still open'],
    ['  Credited so far', att.total_minutes === null
      ? (Number(att.banked_minutes) > 0
          ? hm(att.banked_minutes) + ' banked, current session still running'
          : 'still running')
      : hm(att.total_minutes)],
    ['  Status', att.status || '-'],
    ['  Sessions that day', att.session_count === null ? 'not recorded' : String(att.session_count)],
    ['  Banked from earlier sessions', att.banked_minutes === null ? 'not recorded' : hm(att.banked_minutes)],
    ['  Note on the record', att.notes || '-'],
  ]);

  if (att.last_in && att.first_in && att.last_in !== att.first_in) {
    console.log('');
    console.log('  Note: they clocked in more than once. The LAST clock-in was ' + att.last_in + ',');
    console.log('  so the credited total is the earlier sessions banked plus the last stretch,');
    console.log('  not simply clock-out minus first clock-in.');
  }

  // -- 2. what touched it ----------------------------------------------------
  head('2. Everything that touched this day, in order');
  const events = await all(
    c,
    "SELECT DATE_FORMAT(CONVERT_TZ(al.created_at, '+00:00', '+05:30'), '%H:%i:%s') AS at_ist," +
      ' al.action, al.details, e.name AS by_name, e.emp_id AS by_emp' +
      ' FROM audit_log al' +
      ' LEFT JOIN employees e ON e.id = al.performed_by' +
      " WHERE (al.entity = 'attendance' AND al.entity_id = ?)" +
      "    OR (al.entity = 'employee' AND al.entity_id = ?" +
      "        AND DATE(CONVERT_TZ(al.created_at, '+00:00', '+05:30')) = ?)" +
      ' ORDER BY al.created_at ASC, al.id ASC',
    [att.id, emp.id, date],
  );

  if (!events.length) {
    console.log('  Nothing is recorded. The clock-out was written without an audit entry,');
    console.log('  which points at a direct change in the database rather than the app.');
  } else {
    for (const ev of events) {
      const d = detailsOf(ev);
      const who = ev.by_name ? ev.by_name + ' (' + ev.by_emp + ')' : null;
      console.log('  ' + ev.at_ist + '  ' + explain(ev.action, d, who));
      if (ev.action === 'geofence_auto_clockout') {
        // The figures the decision was made on. Without them the entry says
        // what happened and leaves every question about whether it should
        // have happened unanswered.
        console.log('            credited up to ' + istOf(d.last_confirmed_inside) +
          ', after ' + (d.minutes_unconfirmed === undefined ? '?' : d.minutes_unconfirmed) +
          ' min with no reading inside; fence ' + (d.fence_radius_m === undefined ? '?' : d.fence_radius_m) +
          'm, grace ' + (d.presence_grace_min === undefined ? '?' : d.presence_grace_min) + ' min');
      }
    }
  }

  // -- 3. where the phone said they were -------------------------------------
  // A day that was auto-closed and then clocked into again has NO clock-out
  // left to look around - the second session overwrote it, which is exactly
  // the case this script was written for and exactly the case it first could
  // not show. The watchdog's own audit entry still carries the instant it
  // stopped crediting, and that is the moment worth looking at.
  const geoEvent = events.filter(e => e.action === 'geofence_auto_clockout').pop();
  const geoDetails = geoEvent ? detailsOf(geoEvent) : {};
  let anchorSql = att.clock_out_sql;
  let anchorLabel = 'the clock-out';
  if (geoDetails.last_confirmed_inside) {
    const iso = String(geoDetails.last_confirmed_inside);
    anchorSql = iso.slice(0, 10) + ' ' + iso.slice(11, 19);
    anchorLabel = 'the moment the watchdog stopped crediting, ' + istOf(iso);
  }

  head('3. Where the phone said they were, around ' + anchorLabel);
  const site = await one(
    c,
    'SELECT l.name, l.latitude, l.longitude, l.radius_meters, es.geofencing_enabled' +
      ' FROM employee_schedules es' +
      ' JOIN locations l ON l.id = es.location_id' +
      ' WHERE es.employee_id = ? AND es.effective_from <= ?' +
      '   AND (es.effective_to IS NULL OR es.effective_to >= ?)' +
      ' ORDER BY es.effective_from DESC, es.id DESC LIMIT 1',
    [emp.id, date, date],
  );

  if (!site) {
    console.log('  No work site is set for them, so no fence could have been applied.');
  } else {
    console.log('  Site: ' + site.name + ', fence ' + site.radius_meters + 'm, geofencing ' +
      (site.geofencing_enabled ? 'ON' : 'OFF'));

    const dayCount = await one(
      c,
      'SELECT COUNT(*) AS n FROM live_tracking_points' +
        " WHERE employee_id = ? AND DATE(CONVERT_TZ(tracked_at_utc, '+00:00', '+05:30')) = ?",
      [emp.id, date],
    );
    console.log('  Location readings that day: ' + Number(dayCount.n));

    if (!anchorSql) {
      console.log('  (Still clocked in, and nothing has ended this day, so there is');
      console.log('  no moment to look around.)');
    } else if (Number(dayCount.n) === 0) {
      console.log('');
      console.log('  NOT ONE READING ALL DAY. Nothing could have proved they left the site,');
      console.log('  so the fence rules on the server cannot be what ended this day.');
    } else {
      const dist =
        '6371000 * 2 * ASIN(SQRT(' +
        'POWER(SIN(RADIANS(latitude - ?) / 2), 2) + ' +
        'COS(RADIANS(?)) * COS(RADIANS(latitude)) * ' +
        'POWER(SIN(RADIANS(longitude - ?) / 2), 2)))';
      const near = await all(
        c,
        "SELECT DATE_FORMAT(CONVERT_TZ(tracked_at_utc, '+00:00', '+05:30'), '%H:%i:%s') AS at_ist," +
          ' ROUND(' + dist + ') AS metres,' +
          ' ROUND(COALESCE(accuracy_meters, 0)) AS accuracy,' +
          ' ABS(TIMESTAMPDIFF(SECOND, tracked_at_utc, ?)) AS secs_from_out' +
          ' FROM live_tracking_points' +
          ' WHERE employee_id = ?' +
          '   AND tracked_at_utc BETWEEN DATE_SUB(?, INTERVAL 30 MINUTE)' +
          '                          AND DATE_ADD(?, INTERVAL 30 MINUTE)' +
          ' ORDER BY tracked_at_utc ASC',
        [site.latitude, site.latitude, site.longitude, anchorSql,
         emp.id, anchorSql, anchorSql],
      );

      if (!near.length) {
        console.log('');
        console.log('  No readings at all in the hour around that moment, though there were');
        console.log('  readings earlier. The phone had stopped reporting by then.');
      } else {
        const fence = Number(site.radius_meters) || 0;
        grid(
          [['  Time', 'Distance from site', 'Accuracy', 'Verdict', '']].concat(
            near.map(r => {
              const m = Number(r.metres);
              const acc = Number(r.accuracy);
              // A reading only counts as OUTSIDE when its whole circle of
              // uncertainty is beyond the fence - the same forgiveness the
              // watchdog applies before it will end anybody's day.
              const verdict = m > fence + acc ? 'OUTSIDE' : (m <= fence ? 'inside' : 'unclear');
              return [
                '  ' + r.at_ist, m + ' m', acc + ' m', verdict,
                Number(r.secs_from_out) < 60 ? '<-- here' : '',
              ];
            }),
          ),
        );
        const outside = near.filter(r => Number(r.metres) > fence + Number(r.accuracy)).length;
        console.log('');
        console.log('  ' + outside + ' of ' + near.length +
          ' readings in that hour put them definitely outside the ' + fence + 'm fence.');
      }
    }
  }

  // -- the verdict -----------------------------------------------------------
  head('In one line');
  const actions = events.map(e => e.action);
  const clockOutEvent = events.filter(e => e.action === 'clock_out').pop();
  const coDetails = clockOutEvent ? detailsOf(clockOutEvent) : {};

  if (actions.includes('geofence_auto_clockout')) {
    console.log('  The SERVER watchdog ended the day, because location readings placed them');
    console.log('  outside the fence. It credits only up to the last moment they were');
    console.log('  confirmed inside, which is why the hours are short.');
  } else if (clockOutEvent && coDetails.auto === true && coDetails.reason === 'geofence_exit') {
    console.log('  THEIR OWN PHONE ended the day. The app watches the fence itself and clocks');
    console.log('  out about four minutes after it thinks you have left, following four');
    console.log('  warning notifications. Section 3 shows whether it was right.');
    console.log('  This rule lives on the phone. Turning geofencing off for this employee');
    console.log('  makes the server refuse it, which stops it on every phone at once.');
  } else if (clockOutEvent && coDetails.auto === true && coDetails.reason === 'location_off') {
    console.log('  Their own phone ended the day because it could not get a location fix.');
    console.log('  That says nothing about where its owner was. Set');
    console.log('  AUTO_CLOCK_OUT_ON_LOCATION_OFF=false (or remove it) to stop this.');
  } else if (actions.includes('session_auto_closed')) {
    console.log('  Nobody clocked out, so the nightly settler closed the day - at the');
    console.log("  work-day boundary, or at the phone's last location reading if that was");
    console.log('  earlier. That is where the short hours come from.');
  } else if (clockOutEvent) {
    const who = clockOutEvent.by_name
      ? clockOutEvent.by_name + ' (' + clockOutEvent.by_emp + ')'
      : 'the signed-in account';
    console.log('  The day was ended by pressing Clock out, as ' + who + ', at ' +
      clockOutEvent.at_ist + '.');
    console.log('  No automatic rule was involved.');
  } else if (att.clock_out_sql) {
    console.log('  There is a clock-out time but nothing recorded that wrote it. That means');
    console.log('  the database was changed outside the app.');
  } else {
    console.log('  Still clocked in - nothing has ended this day.');
  }
  console.log('');

  await c.end();
}

main().catch(err => {
  console.error('Could not run the check: ' + (err && err.message ? err.message : err));
  process.exit(1);
});

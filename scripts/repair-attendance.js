#!/usr/bin/env node
/**
 * Restate the days the SYSTEM settled, on the rule that is correct.
 *
 * WHY THIS EXISTS
 *
 * Two rules wrote wrong numbers into the attendance table, and fixing the code
 * only stops new ones. The rows already written stay wrong until something
 * restates them, and those rows are the payroll record.
 *
 *   ZERO-MINUTE DAYS. The geofence watchdog credits a day up to the last moment
 *   a fix placed the employee inside their fence. When the phone never reported
 *   — permission not granted, battery optimisation, no route to the server —
 *   that moment is the clock-in itself, so the day closed at the second it
 *   opened. "Present, 0h 0m", and because the row now had a clock-out the day
 *   read as COMPLETE, so they could not clock in again either.
 *
 *   TWENTY-HOUR DAYS. The settling sweep credited elapsed time to the work
 *   day's 07:00 boundary, so somebody who worked their day and forgot to tap
 *   the button was recorded as working until seven the next morning.
 *
 * Both are restated here on the same rule the sweep now uses (lib/settlement.ts
 * — one implementation, so history and tonight agree):
 *
 *   1. their last live-tracking fix — an observation;
 *   2. failing that, a normal day's length for them;
 *   3. failing even a roster, the work day's boundary.
 *
 * WHAT IT WILL NOT TOUCH
 *
 *   • A day somebody really clocked out of. Only rows the system itself closed
 *     — those carrying a 'session_auto_closed' or 'geofence_auto_clockout'
 *     audit entry — are candidates.
 *   • A day an admin has corrected by hand since. A human decision outranks
 *     any rule here.
 *   • TODAY. The day is not over, so there is nothing to settle: use
 *     --reopen-today, which clears the clock-out and lets people carry on.
 *
 * Every change writes an 'attendance_recomputed' audit entry carrying the old
 * figure, the new one and the evidence behind it. A correction that leaves no
 * record is just a different kind of wrong number.
 *
 *   node scripts/repair-attendance.js --dry-run
 *   node scripts/repair-attendance.js --dry-run --from=2026-08-01
 *   node scripts/repair-attendance.js --confirm
 *   node scripts/repair-attendance.js --reopen-today --confirm
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const envPath = path.join(ROOT, '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const mysql = require(path.join(ROOT, 'node_modules/mysql2/promise'));

// The real settlement rule and the real work-day arithmetic, loaded from the
// application itself. Re-implementing either here is how a repair script drifts
// away from the thing it is repairing.
const jitiMod = require(path.join(ROOT, 'node_modules/jiti'));
const jiti = (jitiMod.createJiti || jitiMod)(__filename, {
  interopDefault: true,
  alias: { '@/lib/constants': path.join(ROOT, 'lib', 'constants.ts') },
});
const { settleSession } = jiti(path.join(ROOT, 'lib', 'settlement.ts'));
const { workDayEndUtc, getWorkDateIST, toMySQLDatetime } = jiti(path.join(ROOT, 'lib', 'attendance.ts'));
const { AUTO_CLOSE_MAX_MINUTES } = jiti(path.join(ROOT, 'lib', 'constants.ts'));

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (name, fallback) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const dryRun = has('--dry-run');
const confirmed = has('--confirm');
const reopenToday = has('--reopen-today');

if (!dryRun && !confirmed) {
  console.error(
    'Refusing to guess.\n\n' +
    '  node scripts/repair-attendance.js --dry-run        what would change, changes nothing\n' +
    '  node scripts/repair-attendance.js --confirm        restate the days\n' +
    '  node scripts/repair-attendance.js --reopen-today --confirm\n' +
    '                                                     give back a day closed at zero today\n\n' +
    'Options: --from=YYYY-MM-DD  --to=YYYY-MM-DD  (default: the last 60 days)\n',
  );
  process.exit(2);
}

const today = getWorkDateIST();
const defaultFrom = (() => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 60);
  return d.toISOString().slice(0, 10);
})();
const fromDate = valueOf('from', defaultFrom);
const toDate = valueOf('to', today);

const hhmm = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : '—');
const hm = (m) => (m == null ? '—' : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`);

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    timezone: '+00:00',
  });

  const [[cols]] = await c.query(
    `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance'
        AND COLUMN_NAME = 'banked_minutes'`);
  const sessionCols = Number(cols.c) > 0;

  // -------------------------------------------------------------------------
  // --reopen-today: the locked-out case.
  //
  // A day closed at zero this morning is not a day to re-credit — it has not
  // finished. Clearing the clock-out puts the person back where they were:
  // still clocked in, hours counting from their real arrival.
  // -------------------------------------------------------------------------
  if (reopenToday) {
    const [rows] = await c.query(
      `SELECT a.id, e.emp_id, e.name,
              a.clock_in_utc, a.clock_out_utc, a.total_minutes
         FROM attendance a
         JOIN employees e ON e.id = a.employee_id
         JOIN audit_log al ON al.entity = 'attendance' AND al.entity_id = a.id
          AND al.action IN ('geofence_auto_clockout', 'session_auto_closed')
        WHERE a.work_date = ?
          AND a.clock_out_utc IS NOT NULL
          AND COALESCE(a.total_minutes, 0) = 0
        GROUP BY a.id, e.emp_id, e.name, a.clock_in_utc, a.clock_out_utc, a.total_minutes`,
      [today],
    );

    if (!rows.length) {
      console.log(`No zero-minute days closed by the system today (${today}).`);
      await c.end();
      process.exit(0);
    }

    console.log(`\n${rows.length} zero-minute day(s) today (${today}):\n`);
    for (const r of rows) {
      console.log(`  ${String(r.emp_id).padEnd(10)} ${String(r.name).padEnd(24)} ` +
                  `clocked in ${hhmm(r.clock_in_utc)}  →  closed at ${hhmm(r.clock_out_utc)}  (0m)`);
    }
    console.log('\nReopening clears the clock-out. They stay clocked in and their hours\n' +
                'count from their real arrival.\n');

    if (dryRun) {
      console.log('Dry run — nothing was changed.');
      await c.end();
      process.exit(0);
    }

    // The watchdog closed them once and will close them again within the grace
    // period unless the fences are disarmed first. Say so rather than letting
    // the repair quietly undo itself.
    const [[armed]] = await c.query(
      `SELECT COUNT(*) AS n FROM employee_schedules WHERE geofencing_enabled = TRUE`);
    if (Number(armed.n) > 0) {
      console.log(
        `WARNING: ${armed.n} schedule(s) still have geofencing enabled. If the phones\n` +
        'are still not reporting, the watchdog will close these again within\n' +
        'GEOFENCE_PRESENCE_GRACE_MIN (default 30 minutes). See section 4 of\n' +
        'database/zero_hour_clockouts.sql to disarm the fences first.\n');
    }

    for (const r of rows) {
      await c.query(
        `UPDATE attendance
            SET clock_out_utc = NULL, clock_out_lat = NULL, clock_out_lng = NULL,
                total_minutes = NULL
          WHERE id = ? AND clock_out_utc IS NOT NULL`,
        [r.id]);
      await c.query(
        `INSERT INTO audit_log (action, entity, entity_id, performed_by, details, created_at)
         VALUES ('attendance_reopened', 'attendance', ?, NULL, ?, UTC_TIMESTAMP())`,
        [r.id, JSON.stringify({
          emp_id: r.emp_id,
          work_date: today,
          reason: 'closed_at_zero_minutes_by_system',
          previous_clock_out_utc: r.clock_out_utc,
          previous_total_minutes: r.total_minutes,
          repaired_by: 'scripts/repair-attendance.js',
        })]);
    }
    console.log(`Reopened ${rows.length} day(s).`);
    await c.end();
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // The history pass.
  // -------------------------------------------------------------------------
  const [rows] = await c.query(
    `SELECT a.id,
            a.employee_id,
            e.emp_id,
            e.name,
            DATE_FORMAT(a.work_date, '%Y-%m-%d') AS work_date,
            a.clock_in_utc,
            a.clock_out_utc,
            a.total_minutes,
            ${sessionCols ? 'a.banked_minutes' : '0 AS banked_minutes'},
            MAX(al.action)     AS closed_by,
            MAX(al.created_at) AS closed_at
       FROM attendance a
       JOIN employees e ON e.id = a.employee_id
       JOIN audit_log al ON al.entity = 'attendance' AND al.entity_id = a.id
        AND al.action IN ('geofence_auto_clockout', 'session_auto_closed')
      WHERE a.work_date BETWEEN ? AND ?
        AND a.work_date < ?
        AND a.clock_in_utc IS NOT NULL
        AND a.clock_out_utc IS NOT NULL
        -- An admin who corrected this by hand outranks any rule here.
        AND NOT EXISTS (
          SELECT 1 FROM audit_log ae
           WHERE ae.entity = 'attendance' AND ae.entity_id = a.id
             AND ae.action IN ('attendance_updated', 'attendance_edited')
             AND ae.created_at > al.created_at)
      GROUP BY a.id, a.employee_id, e.emp_id, e.name, a.work_date,
               a.clock_in_utc, a.clock_out_utc, a.total_minutes, a.banked_minutes
      ORDER BY a.work_date ASC, e.name ASC`,
    [fromDate, toDate, today],
  );

  if (!rows.length) {
    console.log(`No system-settled days between ${fromDate} and ${toDate}. Nothing to restate.`);
    await c.end();
    process.exit(0);
  }

  // What each day SHOULD say, on the one rule.
  const changes = [];
  for (const r of rows) {
    const clockIn = new Date(r.clock_in_utc);
    const boundary = workDayEndUtc(r.work_date);

    const [[fix]] = await c.query(
      `SELECT MAX(tracked_at_utc) AS at
         FROM live_tracking_points
        WHERE employee_id = ? AND tracked_at_utc >= ? AND tracked_at_utc <= ?`,
      [r.employee_id, toMySQLDatetime(clockIn), toMySQLDatetime(boundary)],
    ).catch(() => [[{ at: null }]]);

    // A normal day for this employee, from the shift in force on that date.
    const [[req]] = await c.query(
      `SELECT COALESCE(SUM(
                CASE WHEN s.start_time IS NULL OR s.end_time IS NULL THEN 540
                     ELSE (TIME_TO_SEC(s.end_time) - TIME_TO_SEC(s.start_time)) / 60
                          + IF(TIME_TO_SEC(s.end_time) < TIME_TO_SEC(s.start_time), 1440, 0)
                END), 0) AS required
         FROM employee_schedules es
         JOIN shifts s ON s.id = es.shift_id
        WHERE es.employee_id = ?
          AND es.effective_from <= ?
          AND (es.effective_to IS NULL OR es.effective_to >= ?)`,
      [r.employee_id, r.work_date, r.work_date],
    ).catch(() => [[{ required: 0 }]]);

    const settled = settleSession({
      clockIn,
      boundary,
      lastFix: fix && fix.at ? new Date(fix.at) : null,
      requiredMinutes: Number(req?.required ?? 0),
      capMinutes: AUTO_CLOSE_MAX_MINUTES,
    });

    const banked = Number(r.banked_minutes ?? 0);
    const newTotal = banked + settled.minutes;
    const oldTotal = r.total_minutes == null ? null : Number(r.total_minutes);
    // A minute either way is rounding, not a correction worth an audit entry.
    if (oldTotal != null && Math.abs(newTotal - oldTotal) <= 1) continue;

    changes.push({ row: r, settled, newTotal, oldTotal });
  }

  if (!changes.length) {
    console.log(`Checked ${rows.length} system-settled day(s) — every one already agrees ` +
                'with the current rule. Nothing to restate.');
    await c.end();
    process.exit(0);
  }

  console.log(`\n${changes.length} of ${rows.length} system-settled day(s) need restating ` +
              `(${fromDate} → ${toDate}):\n`);
  console.log('  EMP        NAME                     DATE        WAS        BECOMES    ON WHAT EVIDENCE');
  console.log('  ' + '-'.repeat(96));
  let gained = 0, lost = 0;
  for (const ch of changes) {
    const delta = ch.newTotal - (ch.oldTotal ?? 0);
    if (delta > 0) gained += delta; else lost -= delta;
    console.log(
      `  ${String(ch.row.emp_id).padEnd(10)} ${String(ch.row.name).slice(0, 24).padEnd(24)} ` +
      `${ch.row.work_date}  ${hm(ch.oldTotal).padEnd(10)} ${hm(ch.newTotal).padEnd(10)} ${ch.settled.basis}`);
  }
  console.log(
    `\n  ${hm(gained)} restored to employees, ${hm(lost)} removed from days that were over-credited.\n`);

  if (dryRun) {
    console.log('Dry run — nothing was changed.');
    await c.end();
    process.exit(0);
  }

  for (const ch of changes) {
    const { row: r, settled, newTotal, oldTotal } = ch;
    await c.query(
      `UPDATE attendance SET clock_out_utc = ?, total_minutes = ? WHERE id = ?`,
      [toMySQLDatetime(settled.endAt), newTotal, r.id]);
    await c.query(
      `INSERT INTO audit_log (action, entity, entity_id, performed_by, details, created_at)
       VALUES ('attendance_recomputed', 'attendance', ?, NULL, ?, UTC_TIMESTAMP())`,
      [r.id, JSON.stringify({
        employee_id: r.employee_id,
        emp_id: r.emp_id,
        work_date: r.work_date,
        closed_originally_by: r.closed_by,
        previous_clock_out_utc: r.clock_out_utc,
        previous_total_minutes: oldTotal,
        clock_out_utc: settled.endAt.toISOString(),
        total_minutes: newTotal,
        basis: settled.basis,
        repaired_by: 'scripts/repair-attendance.js',
      })]);
  }

  console.log(`Restated ${changes.length} day(s). Each carries an 'attendance_recomputed' ` +
              'audit entry with the old figure, the new one and the evidence.');
  await c.end();
  process.exit(0);
})().catch(e => {
  console.error('Failed:', e.message);
  process.exit(1);
});

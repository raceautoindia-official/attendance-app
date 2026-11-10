#!/usr/bin/env node
/**
 * Mark a day the APP refused to mark.
 *
 * WHY THIS EXISTS
 *
 * On 2026-11-10 Nalini tapped Clock In at 9:13 am and was told "That took too
 * long, so it was stopped", then again at 2:18 pm and was told "The location
 * permission request went unanswered". She had granted location weeks before.
 * Both refusals were the app's fault (see 1.4.32 and 1.4.33), and the day went
 * into the payroll record as an absence.
 *
 * Nothing could put it right. The admin screen edits rows that EXIST — there
 * is no "add record" anywhere in the product — and a day the app refused never
 * got a row at all. repair-attendance.js restates days the SYSTEM closed
 * wrongly; it cannot invent a day that was never opened. So the only route was
 * raw SQL against production, by hand, with no audit entry and nothing
 * stopping a typo from landing on the wrong employee or the wrong date.
 *
 * WHAT THIS WILL NOT DO
 *
 *   • Overwrite a day that already has a row. If one exists, this stops and
 *     tells you to use the admin screen's Edit, which is the right tool and
 *     keeps the existing audit trail.
 *   • Write anything without --confirm. Dry run is the default.
 *   • Guess the hour. --in is required: somebody has to say when they started,
 *     and it should be a person, not a script.
 *
 * Every row it writes carries an 'attendance_marked_manually' audit entry
 * naming who asked for it and why, because a payroll correction nobody can
 * trace is just a different kind of wrong number.
 *
 *   node scripts/mark-attendance.js --emp=RACE013 --in=09:13
 *   node scripts/mark-attendance.js --emp=RACE013 --in=09:13 --confirm
 *   node scripts/mark-attendance.js --emp=RACE013 --date=2026-11-10 \
 *        --in=09:13 --out=18:00 --by=RACE001 --reason="app refused clock-in" --confirm
 */

const path = require('path');

const ROOT = path.join(__dirname, '..');
require('./lib/env').loadEnv(ROOT);

const mysql = require(path.join(ROOT, 'node_modules/mysql2/promise'));

const TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const confirmed = has('--confirm');
const emp = valueOf('emp', '');
const inAt = valueOf('in', '');
const outAt = valueOf('out', '');
const statusArg = valueOf('status', '');
const byArg = valueOf('by', '');
const reason = valueOf('reason', 'app_refused_clock_in');

if (!emp || !inAt || has('--help') || has('-h')) {
  console.log(
    'Mark a day the app refused to mark.\n\n' +
    '  node scripts/mark-attendance.js --emp=RACE013 --in=09:13            dry run\n' +
    '  node scripts/mark-attendance.js --emp=RACE013 --in=09:13 --confirm  write it\n\n' +
    'Options:\n' +
    '  --emp=RACE013          employee code (required)\n' +
    '  --in=HH:MM             clock-in, local time (required)\n' +
    '  --out=HH:MM            clock-out, local time (omit to leave the day open)\n' +
    `  --date=YYYY-MM-DD      work date (default: today in ${TZ})\n` +
    '  --status=present|late  override; by default it is computed from their shift\n' +
    '  --by=RACE001           the admin authorising this, recorded in the audit entry\n' +
    '  --reason="..."         why, recorded in the audit entry\n' +
    '  --confirm              actually write\n',
  );
  process.exit(emp && inAt ? 0 : 1);
}

/** The calendar date in TZ right now. */
function todayLocal() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/**
 * "2026-11-10" + "09:13" in TZ -> the UTC instant.
 *
 * Done with Intl rather than a hardcoded +05:30 so that an APP_TIMEZONE set to
 * somewhere with daylight saving still lands on the right instant.
 */
function localToUtc(dateStr, timeStr) {
  const naive = new Date(`${dateStr}T${timeStr.length === 5 ? timeStr : timeStr.slice(0, 5)}:00Z`);
  if (isNaN(naive.getTime())) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(naive)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  );
  const asZone = Date.UTC(
    +parts.year, +parts.month - 1, +parts.day,
    +parts.hour % 24, +parts.minute, +parts.second,
  );
  return new Date(naive.getTime() - (asZone - naive.getTime()));
}

const toMySQL = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const hhmm = (d) => new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit',
}).format(d);

async function main() {
  const workDate = valueOf('date', todayLocal());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
    throw new Error(`--date must be YYYY-MM-DD, got "${workDate}"`);
  }
  const clockIn = localToUtc(workDate, inAt);
  if (!clockIn) throw new Error(`--in must be HH:MM, got "${inAt}"`);
  const clockOut = outAt ? localToUtc(workDate, outAt) : null;
  if (outAt && !clockOut) throw new Error(`--out must be HH:MM, got "${outAt}"`);
  if (clockOut && clockOut <= clockIn) {
    throw new Error('--out is not after --in. A day cannot end before it starts.');
  }

  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    timezone: '+00:00',
  });

  try {
    const [[who]] = await c.query(
      'SELECT id, emp_id, name FROM employees WHERE emp_id = ? LIMIT 1', [emp]);
    if (!who) throw new Error(`No employee with emp_id "${emp}".`);

    const [[existing]] = await c.query(
      `SELECT id, clock_in_utc, clock_out_utc, total_minutes, status
         FROM attendance WHERE employee_id = ? AND work_date = ? LIMIT 1`,
      [who.id, workDate]);
    if (existing) {
      console.log(
        `${who.emp_id} ${who.name} ALREADY has a row for ${workDate} ` +
        `(id ${existing.id}, ${existing.status}, in ${existing.clock_in_utc ?? '-'} UTC, ` +
        `out ${existing.clock_out_utc ?? '-'} UTC).\n\n` +
        'Nothing written. This script only fills a day that has NO row; changing one ' +
        'that exists belongs in the admin screen\'s Edit, which keeps its audit trail.');
      return;
    }

    // Their shift for that date, chosen the way the clock-in route chooses it:
    // earliest start first, so a morning arrival is judged against the morning
    // shift and not against an evening one that happens to sort first by id.
    const [schedules] = await c.query(
      `SELECT s.name, s.start_time, s.grace_minutes
         FROM employee_schedules es
         JOIN shifts s ON es.shift_id = s.id
        WHERE es.employee_id = ?
          AND es.effective_from <= ?
          AND (es.effective_to IS NULL OR es.effective_to >= ?)
        ORDER BY COALESCE(s.start_time, '00:00:00') ASC, es.id ASC`,
      [who.id, workDate, workDate]);
    const shift = schedules[0] ?? null;

    let status = statusArg;
    if (!status) {
      if (!shift || !shift.start_time) {
        status = 'present';
      } else {
        const deadline = localToUtc(workDate, String(shift.start_time).slice(0, 5));
        const graceMs = Number(shift.grace_minutes ?? 0) * 60_000;
        status = clockIn.getTime() > deadline.getTime() + graceMs ? 'late' : 'present';
      }
    }
    if (!['present', 'late'].includes(status)) {
      throw new Error(`--status must be present or late, got "${status}"`);
    }

    const totalMinutes = clockOut
      ? Math.round((clockOut.getTime() - clockIn.getTime()) / 60_000)
      : null;

    // first_clock_in_utc arrived in a later migration and is not on every
    // deployment. Ask rather than assume — a column that is not there turns the
    // whole INSERT into a syntax error and marks nobody.
    const [[fc]] = await c.query(
      `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance'
          AND COLUMN_NAME = 'first_clock_in_utc'`);
    const hasFirstIn = Number(fc.n) > 0;

    let byId = null;
    if (byArg) {
      const [[admin]] = await c.query(
        'SELECT id FROM employees WHERE emp_id = ? LIMIT 1', [byArg]);
      if (!admin) throw new Error(`No employee with emp_id "${byArg}" for --by.`);
      byId = admin.id;
    }

    console.log(
      `${who.emp_id}  ${who.name}\n` +
      `  work date   ${workDate}\n` +
      `  shift       ${shift ? `${shift.name} from ${String(shift.start_time).slice(0, 5)} ` +
        `(+${shift.grace_minutes ?? 0}m grace)` : 'no schedule on file'}\n` +
      `  clock in    ${hhmm(clockIn)} local  =  ${toMySQL(clockIn)} UTC\n` +
      `  clock out   ${clockOut ? `${hhmm(clockOut)} local  =  ${toMySQL(clockOut)} UTC` : '— left open, they can tap Clock Out as normal'}\n` +
      `  hours       ${totalMinutes === null ? '—' : `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`}\n` +
      `  status      ${status}${statusArg ? ' (forced by --status)' : ' (computed)'}\n` +
      `  geofence    not_required — there is no position to judge; it was never captured\n` +
      `  reason      ${reason}\n` +
      `  authorised  ${byArg || '— none given, pass --by=RACE001 to record who asked'}\n`);

    if (!confirmed) {
      console.log('DRY RUN — nothing written. Add --confirm to write it.');
      return;
    }

    const cols = ['employee_id', 'work_date', 'clock_in_utc', 'clock_out_utc',
      'geofence_status', 'total_minutes', 'status', 'notes', 'edited_by', 'edited_at'];
    const vals = [who.id, workDate, toMySQL(clockIn), clockOut ? toMySQL(clockOut) : null,
      'not_required', totalMinutes, status,
      `Marked by hand: ${reason}`, byId, toMySQL(new Date())];
    if (hasFirstIn) { cols.push('first_clock_in_utc'); vals.push(toMySQL(clockIn)); }

    const [res] = await c.query(
      `INSERT INTO attendance (${cols.join(', ')})
       VALUES (${cols.map(() => '?').join(', ')})`, vals);
    const id = res.insertId;

    await c.query(
      `INSERT INTO audit_log (action, entity, entity_id, performed_by, details, created_at)
       VALUES ('attendance_marked_manually', 'attendance', ?, ?, ?, UTC_TIMESTAMP())`,
      [id, byId, JSON.stringify({
        emp_id: who.emp_id,
        work_date: workDate,
        clock_in_utc: toMySQL(clockIn),
        clock_out_utc: clockOut ? toMySQL(clockOut) : null,
        total_minutes: totalMinutes,
        status,
        reason,
        authorised_by: byArg || null,
        marked_by: 'scripts/mark-attendance.js',
      })]);

    console.log(`Written. attendance id ${id}, audited.`);
    if (!clockOut) {
      console.log('The day is open — they tap Clock Out at the end as usual.');
    }
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(`\n${e.message}\n`);
  process.exit(1);
});

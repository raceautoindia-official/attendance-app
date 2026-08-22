#!/usr/bin/env node
/**
 * Move a week of location history out of the database and into a file.
 *
 * WHY
 *
 * live_tracking_points grows by roughly one row per employee per 30 seconds of
 * every shift — a few hundred thousand rows a week — and it never stops. It is
 * the single largest thing in the database, and because a full dump goes to
 * Drive every two hours, every one of those dumps carries the whole history
 * again. Pruning the table shrinks the database AND twelve backups a day.
 *
 * WHAT IS LOST, SAID PLAINLY
 *
 * These rows are the map. Once a week is archived, Live Tracking's "review a
 * finished day" draws nothing for it, and the day timeline shows events without
 * their trail. The attendance figures themselves are unaffected — hours live in
 * `attendance`, and a settled day keeps its clock-out and total whatever
 * happens here.
 *
 * That is why only weeks that ENDED more than --keep-days ago are touched. The
 * settlement rule reads a day's last tracked position when it settles it, so
 * the recent past must stay in the database or days would start settling from a
 * roster instead of from evidence.
 *
 * SAFETY
 *
 * Nothing is deleted until the archive has been written, re-read, counted and
 * checksummed. If the verification does not match the database exactly, the
 * week is skipped with its rows intact. Deleting location history cannot be
 * undone from here — only from one of the Drive dumps.
 *
 *   node scripts/archive-tracking.js --dry-run
 *   node scripts/archive-tracking.js --dry-run --keep-days=30
 *   node scripts/archive-tracking.js --confirm
 *   node scripts/archive-tracking.js --confirm --week=2026-W33
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const envPath = path.join(ROOT, '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const mysql = require(path.join(ROOT, 'node_modules/mysql2/promise'));

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (name, fallback) => {
  const hit = args.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const dryRun = has('--dry-run');
const confirmed = has('--confirm');

if (!dryRun && !confirmed) {
  console.error(
    'Refusing to guess.\n\n' +
    '  node scripts/archive-tracking.js --dry-run    what would be archived, changes nothing\n' +
    '  node scripts/archive-tracking.js --confirm    write the archives, then delete\n\n' +
    'Options:\n' +
    '  --keep-days=N      leave the last N days in the database (default 21)\n' +
    '  --week=2026-W33    just this one ISO week\n' +
    '  --out-dir=PATH     where archives are written (default ./backups/tracking,\n' +
    '                     or TRACKING_ARCHIVE_DIR)\n',
  );
  process.exit(2);
}

const KEEP_DAYS = Number(valueOf('keep-days', '21')) || 21;
const ONLY_WEEK = valueOf('week', '');
const OUT_DIR = path.resolve(
  valueOf('out-dir', process.env.TRACKING_ARCHIVE_DIR || path.join(ROOT, 'backups', 'tracking')),
);

const DAY_MS = 86400000;
const COLUMNS = ['id', 'session_id', 'employee_id', 'tracked_at_utc', 'latitude', 'longitude', 'accuracy_meters'];
const PAGE = 20000;      // rows read per round trip
const DELETE_BATCH = 5000; // rows per DELETE, so no single statement holds a long lock
const NEWLINE = String.fromCharCode(10);

/** Monday 00:00 UTC of the ISO week containing d. */
function weekStart(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (t.getUTCDay() + 6) % 7; // Monday = 0
  t.setUTCDate(t.getUTCDate() - dow);
  return t;
}

/** ISO year and week number, as "2026-W33". */
function isoWeekName(monday) {
  const t = new Date(monday.getTime());
  t.setUTCDate(t.getUTCDate() + 3);           // the Thursday decides the year
  const year = t.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round((t.getTime() - weekStart(jan4).getTime()) / (7 * DAY_MS));
  return year + '-W' + String(week).padStart(2, '0');
}

const ymd = (d) => d.toISOString().slice(0, 10);
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    timezone: '+00:00',
    dateStrings: true,   // write the archive exactly as MySQL stores it
  });

  const [[span]] = await c.query(
    'SELECT COUNT(*) AS rows_total, MIN(tracked_at_utc) AS oldest, MAX(tracked_at_utc) AS newest ' +
    'FROM live_tracking_points',
  );
  if (!Number(span.rows_total)) {
    console.log('live_tracking_points is empty. Nothing to archive.');
    await c.end();
    process.exit(0);
  }

  const [[size]] = await c.query(
    'SELECT ROUND((data_length + index_length) / 1048576) AS mb ' +
    'FROM INFORMATION_SCHEMA.TABLES ' +
    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_tracking_points'",
  );

  console.log('live_tracking_points: ' + Number(span.rows_total).toLocaleString() +
              ' rows, about ' + (size ? size.mb : '?') + ' MB');
  console.log('  oldest: ' + span.oldest);
  console.log('  newest: ' + span.newest);

  // Weeks that have ENDED more than KEEP_DAYS ago. A week still inside the
  // window is left alone: the settlement rule reads a day's last tracked
  // position when it settles that day, so recent history has to stay put.
  const cutoff = new Date(Date.now() - KEEP_DAYS * DAY_MS);
  const weeks = [];
  let cursor = weekStart(new Date(span.oldest.replace(' ', 'T') + 'Z'));
  const lastPoint = new Date(span.newest.replace(' ', 'T') + 'Z');

  while (cursor.getTime() <= lastPoint.getTime()) {
    const end = new Date(cursor.getTime() + 7 * DAY_MS);
    const name = isoWeekName(cursor);
    if (end.getTime() <= cutoff.getTime() && (!ONLY_WEEK || ONLY_WEEK === name)) {
      weeks.push({ name, from: new Date(cursor.getTime()), to: end });
    }
    cursor = end;
  }

  if (!weeks.length) {
    console.log('\nNo complete week has finished more than ' + KEEP_DAYS + ' days ago' +
                (ONLY_WEEK ? ' matching ' + ONLY_WEEK : '') + '. Nothing to archive.');
    await c.end();
    process.exit(0);
  }

  console.log('\nKeeping the last ' + KEEP_DAYS + ' days in the database.');
  console.log(weeks.length + ' week(s) eligible:\n');

  let grandTotal = 0;
  const plan = [];
  for (const w of weeks) {
    const [[n]] = await c.query(
      'SELECT COUNT(*) AS n FROM live_tracking_points WHERE tracked_at_utc >= ? AND tracked_at_utc < ?',
      [sqlTime(w.from), sqlTime(w.to)],
    );
    const rows = Number(n.n);
    if (!rows) continue;
    grandTotal += rows;
    plan.push({ ...w, rows });
    console.log('  ' + w.name + '  ' + ymd(w.from) + ' to ' + ymd(new Date(w.to.getTime() - DAY_MS)) +
                '  ' + rows.toLocaleString().padStart(10) + ' rows');
  }

  if (!plan.length) {
    console.log('  (all eligible weeks are already empty)');
    await c.end();
    process.exit(0);
  }

  console.log('\n  ' + grandTotal.toLocaleString() + ' rows total would leave the database.');
  console.log('  Archives are written to: ' + OUT_DIR);
  console.log('\n  What this costs: Live Tracking cannot draw a map for an archived week,');
  console.log('  and day timelines lose their trail. Hours, clock-ins and clock-outs are');
  console.log('  untouched — those live in `attendance`, not here.');

  if (dryRun) {
    console.log('\nDry run — nothing was written and nothing was deleted.');
    await c.end();
    process.exit(0);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const w of plan) {
    const base = 'tracking_' + w.name + '_' + ymd(w.from) + '_to_' +
                 ymd(new Date(w.to.getTime() - DAY_MS)) + '.csv.gz';
    const file = path.join(OUT_DIR, base);
    console.log('\n' + w.name + ' -> ' + base);

    // ---- write ------------------------------------------------------------
    const gzip = zlib.createGzip({ level: 9 });
    const out = fs.createWriteStream(file);
    const done = new Promise((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
      gzip.on('error', reject);
    });
    gzip.pipe(out);

    const write = (chunk) => new Promise((resolve) => {
      if (!gzip.write(chunk)) gzip.once('drain', resolve); else resolve();
    });

    await write(COLUMNS.join(',') + NEWLINE);

    let lastId = 0;
    let written = 0;
    for (;;) {
      const [batch] = await c.query(
        'SELECT ' + COLUMNS.join(', ') + ' FROM live_tracking_points ' +
        'WHERE tracked_at_utc >= ? AND tracked_at_utc < ? AND id > ? ' +
        'ORDER BY id LIMIT ' + PAGE,
        [sqlTime(w.from), sqlTime(w.to), lastId],
      );
      if (!batch.length) break;
      let buf = '';
      for (const r of batch) {
        buf += [
          r.id, r.session_id, r.employee_id, r.tracked_at_utc,
          r.latitude, r.longitude, r.accuracy_meters == null ? '' : r.accuracy_meters,
        ].join(',') + NEWLINE;
        lastId = r.id;
      }
      await write(buf);
      written += batch.length;
      process.stdout.write('  written ' + written.toLocaleString() + ' / ' +
                           w.rows.toLocaleString() + '\r');
    }
    gzip.end();
    await done;
    console.log('  written ' + written.toLocaleString() + ' / ' + w.rows.toLocaleString());

    // ---- verify, before anything is destroyed -----------------------------
    const raw = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
    const lines = raw.split(NEWLINE).filter(l => l.length > 0);
    const dataRows = lines.length - 1;               // minus the header
    const sha = crypto.createHash('sha256')
      .update(fs.readFileSync(file)).digest('hex');
    const bytes = fs.statSync(file).size;

    // Re-count from the DATABASE, not from the loop, so a row inserted while
    // the archive was being written is caught rather than silently deleted.
    const [[recount]] = await c.query(
      'SELECT COUNT(*) AS n FROM live_tracking_points WHERE tracked_at_utc >= ? AND tracked_at_utc < ?',
      [sqlTime(w.from), sqlTime(w.to)],
    );

    console.log('  archive: ' + dataRows.toLocaleString() + ' rows, ' +
                (bytes / 1048576).toFixed(1) + ' MB, sha256 ' + sha.slice(0, 16));

    if (dataRows !== Number(recount.n)) {
      console.log('  MISMATCH: database now holds ' + Number(recount.n).toLocaleString() +
                  ' rows for this week, the archive holds ' + dataRows.toLocaleString() + '.');
      console.log('  SKIPPED — nothing deleted. Re-run when the week is quiet.');
      continue;
    }

    // ---- delete, in batches ----------------------------------------------
    let deleted = 0;
    for (;;) {
      const [res] = await c.query(
        'DELETE FROM live_tracking_points WHERE tracked_at_utc >= ? AND tracked_at_utc < ? LIMIT ' + DELETE_BATCH,
        [sqlTime(w.from), sqlTime(w.to)],
      );
      const n = res.affectedRows || 0;
      deleted += n;
      process.stdout.write('  deleted ' + deleted.toLocaleString() + '\r');
      if (n < DELETE_BATCH) break;
    }
    console.log('  deleted ' + deleted.toLocaleString() + ' rows');

    await c.query(
      'INSERT INTO audit_log (action, entity, entity_id, performed_by, details, created_at) ' +
      "VALUES ('tracking_points_archived', 'live_tracking_points', NULL, NULL, ?, UTC_TIMESTAMP())",
      [JSON.stringify({
        week: w.name,
        from_utc: sqlTime(w.from),
        to_utc: sqlTime(w.to),
        rows_archived: dataRows,
        rows_deleted: deleted,
        file: base,
        bytes,
        sha256: sha,
        keep_days: KEEP_DAYS,
        note: 'Location history for this week now exists ONLY in this file.',
      })],
    );
  }

  console.log('\nDone. Upload ' + OUT_DIR + ' to Drive alongside the database dumps,');
  console.log('and check the file is there before the next run removes another week.');
  await c.end();
  process.exit(0);
})().catch(e => {
  console.error('Failed:', e.message);
  process.exit(1);
});

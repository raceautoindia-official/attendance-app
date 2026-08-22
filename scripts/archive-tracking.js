#!/usr/bin/env node
/**
 * Move a week of location history to Drive, then remove it from the database.
 *
 * WHY
 *
 * live_tracking_points grows by roughly one row per employee per 30 seconds of
 * every shift, and never stops. It is the largest thing in the database and it
 * only ever gets larger.
 *
 * WHAT IS LOST, SAID PLAINLY
 *
 * These rows are the map. Once a week has moved, Live Tracking's "review a
 * finished day" draws nothing for it and day timelines lose their trail. The
 * attendance figures are untouched — hours, clock-ins and clock-outs live in
 * `attendance`, not here — but if anyone is ever asked to prove where somebody
 * was during an archived week, the answer is in the CSV, not in the app.
 *
 * That is why only weeks that ENDED more than --keep-days ago are touched. The
 * settlement rule reads a day's last tracked position when it settles that day,
 * so the recent past has to stay in the database, or days would begin settling
 * from a roster instead of from evidence.
 *
 * MOVE, NOT COPY-AND-HOPE
 *
 * A week is deleted only after ALL of:
 *   1. the archive is written and gunzipped back;
 *   2. its row count matches a fresh count from the database — so a row that
 *      arrived mid-archive skips the week rather than vanishing with it;
 *   3. Drive has accepted the upload;
 *   4. Drive's OWN md5, computed from what actually arrived, matches the local
 *      file. A 200 is not evidence that a file is intact.
 *
 * Any one of those failing leaves the week in the database, untouched, to be
 * retried next Sunday.
 *
 *   node scripts/archive-tracking.js --dry-run
 *   node scripts/archive-tracking.js --confirm
 *   node scripts/archive-tracking.js --confirm --week=2026-W33
 *
 * Configure the upload with GDRIVE_SERVICE_ACCOUNT_JSON and
 * GDRIVE_TRACKING_FOLDER_ID (see .env.example).
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
const drive = require('./lib/drive');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (name, fallback) => {
  const hit = args.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const dryRun = has('--dry-run');
const confirmed = has('--confirm');
// Deliberately awkward to type. Deleting a week whose only other copy is a
// database dump somebody has to go and find is not a routine operation.
const skipUpload = has('--delete-without-uploading');

if (!dryRun && !confirmed) {
  console.error(
    'Refusing to guess.\n\n' +
    '  node scripts/archive-tracking.js --dry-run    what would move, changes nothing\n' +
    '  node scripts/archive-tracking.js --confirm    upload to Drive, verify, then delete\n\n' +
    'Options:\n' +
    '  --keep-days=N      leave the last N days in the database (default 21)\n' +
    '  --week=2026-W33    just this one ISO week\n' +
    '  --out-dir=PATH     local copies (default ./backups/tracking, or TRACKING_ARCHIVE_DIR)\n' +
    '  --delete-without-uploading   archive locally only. The week then exists in ONE\n' +
    '                               place, on this server. Not for the weekly run.\n',
  );
  process.exit(2);
}

const KEEP_DAYS = Number(valueOf('keep-days', '21')) || 21;
const ONLY_WEEK = valueOf('week', '');
const OUT_DIR = path.resolve(
  valueOf('out-dir', process.env.TRACKING_ARCHIVE_DIR || path.join(ROOT, 'backups', 'tracking')),
);
const FOLDER_ID = process.env.GDRIVE_TRACKING_FOLDER_ID || '';
const KEY_PATH = process.env.GDRIVE_SERVICE_ACCOUNT_JSON || '';

const DAY_MS = 86400000;
const COLUMNS = ['id', 'session_id', 'employee_id', 'tracked_at_utc', 'latitude', 'longitude', 'accuracy_meters'];
const PAGE = 20000;
const DELETE_BATCH = 5000;
const NEWLINE = String.fromCharCode(10);

/** Monday 00:00 UTC of the ISO week containing d. */
function weekStart(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dow);
  return t;
}

/** ISO year and week number, as "2026-W33". */
function isoWeekName(monday) {
  const t = new Date(monday.getTime());
  t.setUTCDate(t.getUTCDate() + 3);
  const year = t.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round((t.getTime() - weekStart(jan4).getTime()) / (7 * DAY_MS));
  return year + '-W' + String(week).padStart(2, '0');
}

const ymd = (d) => d.toISOString().slice(0, 10);
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    timezone: '+00:00',
    dateStrings: true,
  });

  const [[span]] = await c.query(
    'SELECT COUNT(*) AS rows_total, MIN(tracked_at_utc) AS oldest, MAX(tracked_at_utc) AS newest ' +
    'FROM live_tracking_points',
  );
  if (!Number(span.rows_total)) {
    console.log('live_tracking_points is empty. Nothing to move.');
    await c.end();
    process.exit(0);
  }

  const [[size]] = await c.query(
    'SELECT ROUND((data_length + index_length) / 1048576) AS mb FROM INFORMATION_SCHEMA.TABLES ' +
    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_tracking_points'",
  );

  console.log('live_tracking_points: ' + Number(span.rows_total).toLocaleString() +
              ' rows, about ' + (size ? size.mb : '?') + ' MB');
  console.log('  oldest: ' + span.oldest);
  console.log('  newest: ' + span.newest);

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
                (ONLY_WEEK ? ' matching ' + ONLY_WEEK : '') + '. Nothing to move.');
    await c.end();
    process.exit(0);
  }

  console.log('\nKeeping the last ' + KEEP_DAYS + ' days in the database.');

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
  }

  if (!plan.length) {
    console.log('All eligible weeks are already empty. Nothing to move.');
    await c.end();
    process.exit(0);
  }

  console.log(plan.length + ' week(s) to move:\n');
  for (const w of plan) {
    console.log('  ' + w.name + '  ' + ymd(w.from) + ' to ' + ymd(new Date(w.to.getTime() - DAY_MS)) +
                '  ' + w.rows.toLocaleString().padStart(10) + ' rows');
  }
  console.log('\n  ' + grandTotal.toLocaleString() + ' rows total.');
  console.log('  Local copies : ' + OUT_DIR);
  console.log('  Drive folder : ' + (FOLDER_ID || '(GDRIVE_TRACKING_FOLDER_ID not set)'));
  console.log('\n  What this costs: an archived week can no longer be drawn on the Live');
  console.log('  Tracking map, and its day timelines lose their trail. Hours, clock-ins');
  console.log('  and clock-outs are untouched.');

  if (dryRun) {
    console.log('\nDry run — nothing was written, uploaded or deleted.');
    await c.end();
    process.exit(0);
  }

  // Authenticate BEFORE writing anything. Discovering that the credentials are
  // wrong after an hour of archiving helps nobody.
  let token = null;
  if (!skipUpload) {
    const auth = await drive.getAccessToken(KEY_PATH);
    token = auth.token;
    console.log('\nDrive: authenticated as ' + auth.email);
    if (!FOLDER_ID) {
      console.error('GDRIVE_TRACKING_FOLDER_ID is not set — refusing to delete anything.');
      await c.end();
      process.exit(1);
    }
  } else {
    console.log('\n--delete-without-uploading: the archive will exist ONLY on this server.');
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  let movedWeeks = 0;
  let movedRows = 0;

  for (const w of plan) {
    const base = 'tracking_' + w.name + '_' + ymd(w.from) + '_to_' +
                 ymd(new Date(w.to.getTime() - DAY_MS)) + '.csv.gz';
    const file = path.join(OUT_DIR, base);
    console.log('\n' + w.name + ' -> ' + base);

    // ---- 1. write --------------------------------------------------------
    const gzip = zlib.createGzip({ level: 9 });
    const out = fs.createWriteStream(file);
    const finished = new Promise((resolve, reject) => {
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
        'WHERE tracked_at_utc >= ? AND tracked_at_utc < ? AND id > ? ORDER BY id LIMIT ' + PAGE,
        [sqlTime(w.from), sqlTime(w.to), lastId],
      );
      if (!batch.length) break;
      let buf = '';
      for (const r of batch) {
        buf += [r.id, r.session_id, r.employee_id, r.tracked_at_utc,
                r.latitude, r.longitude, r.accuracy_meters == null ? '' : r.accuracy_meters]
          .join(',') + NEWLINE;
        lastId = r.id;
      }
      await write(buf);
      written += batch.length;
      process.stdout.write('  written ' + written.toLocaleString() + ' / ' + w.rows.toLocaleString() + '\r');
    }
    gzip.end();
    await finished;
    console.log('  written ' + written.toLocaleString() + ' / ' + w.rows.toLocaleString());

    // ---- 2. verify locally, against a FRESH database count ----------------
    const bytes = fs.readFileSync(file);
    const dataRows = zlib.gunzipSync(bytes).toString('utf8')
      .split(NEWLINE).filter(l => l.length > 0).length - 1;
    const localMd5 = md5(bytes);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');

    const [[recount]] = await c.query(
      'SELECT COUNT(*) AS n FROM live_tracking_points WHERE tracked_at_utc >= ? AND tracked_at_utc < ?',
      [sqlTime(w.from), sqlTime(w.to)],
    );
    console.log('  archive: ' + dataRows.toLocaleString() + ' rows, ' +
                (bytes.length / 1048576).toFixed(1) + ' MB, md5 ' + localMd5.slice(0, 12));

    if (dataRows !== Number(recount.n)) {
      console.log('  MISMATCH: the database now holds ' + Number(recount.n).toLocaleString() +
                  ' rows for this week, the archive holds ' + dataRows.toLocaleString() + '.');
      console.log('  SKIPPED — nothing deleted.');
      continue;
    }

    // ---- 3. upload, and read it back --------------------------------------
    let driveId = null;
    if (!skipUpload) {
      const up = await drive.uploadFile({ token, folderId: FOLDER_ID, filePath: file, name: base })
        .catch(err => { console.log('  UPLOAD FAILED: ' + err.message); return null; });
      if (!up) { console.log('  SKIPPED — nothing deleted.'); continue; }

      const back = await drive.getFile(token, up.id)
        .catch(err => { console.log('  READ-BACK FAILED: ' + err.message); return null; });
      if (!back) { console.log('  SKIPPED — nothing deleted.'); continue; }

      // Google's md5 is computed from what arrived. Matching it is the only
      // proof that the copy in Drive is the file we wrote.
      if (back.md5Checksum !== localMd5 || Number(back.size) !== bytes.length) {
        console.log('  DRIVE COPY DOES NOT MATCH: size ' + back.size + ' vs ' + bytes.length +
                    ', md5 ' + back.md5Checksum + ' vs ' + localMd5);
        console.log('  SKIPPED — nothing deleted.');
        continue;
      }
      driveId = up.id;
      console.log('  drive  : uploaded and verified, id ' + driveId);
    }

    // ---- 4. only now, delete ---------------------------------------------
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
    movedWeeks++;
    movedRows += deleted;

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
        bytes: bytes.length,
        md5: localMd5,
        sha256: sha,
        drive_file_id: driveId,
        keep_days: KEEP_DAYS,
        note: driveId
          ? 'Location history for this week now lives in Drive and in the local copy.'
          : 'Uploaded nowhere. This week exists ONLY in the local archive file.',
      })],
    );
  }

  console.log('\n' + movedWeeks + ' week(s), ' + movedRows.toLocaleString() +
              ' rows moved out of the database.');
  await c.end();
  process.exit(0);
})().catch(e => {
  console.error('Failed:', e.message);
  process.exit(1);
});

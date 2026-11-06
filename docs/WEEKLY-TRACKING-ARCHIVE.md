# Moving location history to Drive every Sunday

`live_tracking_points` gains roughly one row per employee per 30 seconds of
every shift and never stops. This moves a completed week out to Google Drive
and deletes it from the database.

It is a **move**, not a copy: the rows are gone from MySQL afterwards. Read the
"What it costs" section before switching it on.

## Setup, once

**1. Reuse the backup service account.** The two-hourly database dumps already
reach Drive as `drive-backup-service@primal-bonbon-452013-p0`, so its key is
already on the server. Find it by its project id — this prints paths only, never
contents:

```bash
sudo grep -rl "primal-bonbon-452013-p0" /home/deploy --include=*.json 2>/dev/null
```

On the production box that is
`/home/deploy/raceautoindia-db-backup-app/credentials.json`, owned by the
`backup-app` PM2 process. Check the app's own user can read it — the Sunday job
runs as `deploy`, not as root:

```bash
test -r /home/deploy/raceautoindia-db-backup-app/credentials.json \
  && echo "readable" || echo "NOT readable — fix this first"
```

Pointing at another app's key file couples the two: if
`raceautoindia-db-backup-app` is ever re-cloned from scratch, this job stops
until the path is corrected. That is a fair trade against copying a private key
to a second place on disk, but it is a coupling, and the failure shows up as
`Google refused the credentials` on a Sunday.

**2. Add two lines to the env file the app actually uses.** On this deployment
that is **`.env`** — there is no `.env.local` in `/home/deploy/attendance-app`:

```
GDRIVE_SERVICE_ACCOUNT_JSON=/home/deploy/raceautoindia-db-backup-app/credentials.json
GDRIVE_TRACKING_FOLDER_ID=1UMh4q5aYGjy_X_9YqhcbtAEdS0m5tmg8
```

`scripts/lib/env.js` reads `.env.local` then `.env`, in Next.js's own
precedence, so either file works and the database credentials do not have to be
duplicated. It used to read `.env.local` alone, which on this server meant the
script started with no configuration at all and failed against
`undefined:3306`. The summary line `Config from : .env` says which file was
actually read — check it if the settings seem to be ignored.

**3. The folder is already writable.** `1UMh4q5aYGjy_X_9YqhcbtAEdS0m5tmg8` is
"race auto Website Database", owned by `raceautoindia@gmail.com`, and the
service account writes a dump into it every two hours — so the Editor share is
in place and needs no action. Sharing the folder is only a step if you point
`GDRIVE_TRACKING_FOLDER_ID` somewhere new. The archive filenames start
`tracking_` and cannot collide with the dumps' `db_backup_`.

**4. Look before you leap:**

```bash
node scripts/archive-tracking.js --dry-run
```

Prints the table size, every eligible week and its row count, and changes
nothing. Run this first, always.

**5. Move one week by hand**, so the first real run is watched:

```bash
node scripts/archive-tracking.js --confirm --week=2026-W25
```

Then confirm the file is in Drive before going further.

**6. Schedule it:**

```bash
chmod +x scripts/weekly-tracking-archive.sh
crontab -e
```

```cron
# Sundays 02:00 — nobody is clocked in, the 07:00 settling sweep is long done,
# and the two-hourly dump runs on even hours so this sits between them.
0 2 * * 0 /home/deploy/<app-dir>/scripts/weekly-tracking-archive.sh
```

Check afterwards:

```bash
tail -n 60 backups/tracking/archive.log
```

## What it does each Sunday

Weeks that **ended more than 21 days ago** are written to
`tracking_2026-W25_2026-06-15_to_2026-06-21.csv.gz`, uploaded, verified and
deleted.

The 21 days are not arbitrary. The settlement rule reads a day's last tracked
position when it settles that day; prune closer to the present and days would
start settling from a roster instead of from evidence. Lengthen it freely with
`--keep-days=N`; shortening it costs accuracy in the attendance figures.

## Nothing is deleted on trust

A week is removed only after **all** of:

1. the archive is written and gunzipped back;
2. its row count matches a **fresh** count from the database — a row that
   arrived mid-archive skips the week rather than vanishing with it;
3. Drive accepts the upload;
4. **Drive's own md5**, computed from what actually arrived, matches the local
   file. A 200 response is not evidence that a file is intact.

Any one failing leaves the week in the database, untouched, to be retried the
following Sunday. The cron wrapper logs a FAILED line so it is noticed before
that becomes three weeks.

Every moved week writes a `tracking_points_archived` audit entry carrying the
filename, byte count, md5, sha256 and the Drive file id.

## What it costs

The rows are the map.

| Still works | Stops working for an archived week |
|---|---|
| Hours, clock-ins, clock-outs | Live Tracking's "review a finished day" |
| Attendance reports and totals | The path drawn on the day timeline |
| The audit trail of events | Coordinates of individual pings |

Attendance figures are safe — they live in `attendance`, not here. But if
somebody is asked to prove where an employee was during an archived week, the
answer is in the CSV in Drive, not in the app.

## Reading an archive back

The file is a gzipped CSV with a header, straight from the table:

```
id,session_id,employee_id,tracked_at_utc,latitude,longitude,accuracy_meters
311,2,8,2026-06-16 05:37:46,13.0080015,80.1969905,
```

To restore a week — for a dispute, or if something went wrong:

```bash
gunzip -c tracking_2026-W25_*.csv.gz > /tmp/week.csv
mysql -u <user> -p <db> -e "
  LOAD DATA LOCAL INFILE '/tmp/week.csv'
  INTO TABLE live_tracking_points
  FIELDS TERMINATED BY ',' IGNORE 1 LINES
  (id, session_id, employee_id, tracked_at_utc, latitude, longitude, @acc)
  SET accuracy_meters = NULLIF(@acc, '');"
```

The original `id`s are preserved, so a restore lands the rows exactly where
they were. This was tested: a week archived, deleted, and reloaded from its own
file came back to the same row count.

## If it fails

| Log line | Meaning |
|---|---|
| `GDRIVE_SERVICE_ACCOUNT_JSON is not set` | Step 2. Nothing was touched. |
| `Google refused the credentials` | Wrong or expired key file. |
| `Drive rejected the upload` | The service account cannot write to that folder — step 3. |
| `DRIVE COPY DOES NOT MATCH` | The upload was truncated. The week stays put; it retries next Sunday. |
| `MISMATCH: the database now holds …` | Rows arrived while archiving. Harmless; retries next Sunday. |

In every one of those, the database is unchanged.

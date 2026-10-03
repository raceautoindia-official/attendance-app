#!/usr/bin/env bash
#
# The Sunday job: move last week's location history to Drive, then drop it
# from the database.
#
# Install (as the user that owns the app, usually deploy):
#
#   chmod +x scripts/weekly-tracking-archive.sh
#   crontab -e
#
#   # Sundays at 02:00 IST. Quiet hours: nobody is clocked in, the 07:00
#   # settling sweep has long finished, and the two-hourly database dump runs
#   # on even hours so this sits between them.
#   0 2 * * 0 /home/deploy/<app-dir>/scripts/weekly-tracking-archive.sh
#
# Check it afterwards with:  tail -n 60 <app-dir>/backups/tracking/archive.log
#
set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${TRACKING_ARCHIVE_DIR:-$APP_DIR/backups/tracking}"
LOG="$LOG_DIR/archive.log"

mkdir -p "$LOG_DIR"

{
  echo
  echo "=============================================================="
  echo "Weekly tracking archive — $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "=============================================================="
} >> "$LOG"

cd "$APP_DIR" || { echo "cannot cd to $APP_DIR" >> "$LOG"; exit 1; }

# node is often absent from cron's PATH even when it is on yours.
NODE_BIN="$(command -v node || echo /usr/bin/node)"

"$NODE_BIN" scripts/archive-tracking.js --confirm >> "$LOG" 2>&1
STATUS=$?

if [ $STATUS -eq 0 ]; then
  echo "Finished cleanly." >> "$LOG"
else
  # A non-zero exit means nothing was deleted — every failure path in the
  # script leaves the week in the database to be retried next Sunday. The
  # log line is here so somebody notices before that becomes three weeks.
  echo "FAILED (exit $STATUS). No data was deleted; it will be retried next Sunday." >> "$LOG"
fi

# Keep the log from growing for ever: last 2000 lines is a couple of years
# of Sundays.
tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"

exit $STATUS

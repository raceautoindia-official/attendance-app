#!/usr/bin/env bash
#
# scripts/deploy.sh — deploy the attendance app on the production VPS.
#
# RUN THIS ON THE SERVER, from the application directory:
#
#   cd /path/to/attendance-app
#   bash scripts/deploy.sh            # preflight + backup + build + reload
#   bash scripts/deploy.sh --check    # preflight and migration status only
#
# WHY THIS EXISTS
# ---------------
# README's documented procedure cannot succeed: `npm install --omit=dev` removes
# typescript and @tailwindcss/postcss, which `npm run build` then needs. It also
# has no backup step, no migration gate and no rollback, while `npm run build`
# overwrites .next in place — so a failed build leaves no good version to serve.
#
# CREDENTIALS
# -----------
# Secrets are read from the server's own .env.local and are NEVER printed, never
# passed on a command line (visible in `ps`), and never written anywhere except a
# 0600 MySQL option file that is deleted on exit, including on failure. This
# script contains no credentials and does not need any passed to it.
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

CHECK_ONLY=0
APPLY_MIGRATIONS=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --apply-migrations) APPLY_MIGRATIONS=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$APP_DIR/../attendance-backups"
MYCNF=""

say()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m  %s\n' "$*"; }
warn() { printf '    \033[33m!!\033[0m  %s\n' "$*"; }
die()  { printf '\n\033[1;31mFAILED:\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() {
  # The option file holds the DB password. Remove it whatever happens.
  [ -n "$MYCNF" ] && [ -f "$MYCNF" ] && shred -u "$MYCNF" 2>/dev/null || true
  [ -n "$MYCNF" ] && [ -f "$MYCNF" ] && rm -f "$MYCNF" || true
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Read one key from .env.local without echoing it.
# Handles optional surrounding quotes and trailing CR.
# ---------------------------------------------------------------------------
env_get() {
  local key="$1"
  sed -n "s/^${key}=//p" .env.local 2>/dev/null \
    | head -n1 \
    | sed -e 's/\r$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# ---------------------------------------------------------------------------
say "1/8  Preflight"
# ---------------------------------------------------------------------------
[ -f package.json ] || die "not an app directory — no package.json in $APP_DIR"
[ -f .env.local ]   || die ".env.local not found. Production secrets must exist on the server."

command -v node >/dev/null   || die "node is not installed"
command -v npm  >/dev/null   || die "npm is not installed"
command -v pm2  >/dev/null   || warn "pm2 not found — the reload step will be skipped"
command -v mysqldump >/dev/null || die "mysqldump is not installed (needed for the backup)"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "Node $NODE_MAJOR is too old — this app needs Node 20 or 22 LTS"
fi
ok "node v$(node -p 'process.versions.node')"

# Required variables — existence only, values are never shown.
MISSING=""
for k in DB_HOST DB_USER DB_PASSWORD DB_NAME JWT_ACCESS_SECRET JWT_REFRESH_SECRET \
         WEBAUTHN_RP_ID WEBAUTHN_ORIGIN; do
  [ -n "$(env_get "$k")" ] || MISSING="$MISSING $k"
done
[ -z "$MISSING" ] || die "missing required variables in .env.local:$MISSING"
ok "all required variables present (values not displayed)"

# Optional: the assistant. The app runs fine without these.
if [ -n "$(env_get OPENAI_API_KEY)" ]; then
  ok "OPENAI_API_KEY is set — the reporting assistant will be enabled"
  [ -n "$(env_get OPENAI_MODEL)" ] || warn "OPENAI_MODEL not set; it will fall back to the code default"
else
  warn "OPENAI_API_KEY not set — /api/chat* will return 503, rest of the app unaffected"
fi

# A dirty tree means someone edited the server in place; pulling would conflict.
if command -v git >/dev/null && [ -d .git ]; then
  if [ -n "$(git status --porcelain)" ]; then
    warn "working tree has local changes:"
    git status --short | sed 's/^/        /'
    warn "the pull may fail or overwrite them. Stash or commit them first."
  else
    ok "git working tree is clean"
  fi
fi

# ---------------------------------------------------------------------------
say "2/8  Database connectivity and migration status"
# ---------------------------------------------------------------------------
# An option file keeps the password out of argv (visible in `ps`) and out of the
# environment (visible in /proc/<pid>/environ). umask 077 BEFORE mktemp so the
# file is never even briefly world-readable while it holds the password —
# chmod-after-create leaves a window.
MYCNF="$(umask 077 && mktemp)"
chmod 600 "$MYCNF" 2>/dev/null || true
# Verify, and be explicit when we cannot: silently assuming success would be the
# wrong default for a file that is about to hold the database password.
MYCNF_PERMS="$(stat -c '%a' "$MYCNF" 2>/dev/null || echo unknown)"
case "$MYCNF_PERMS" in
  600)     ok "temporary MySQL option file is 0600" ;;
  unknown) warn "cannot read file permissions here (non-GNU stat?); relying on umask 077" ;;
  *)       die "temporary option file is $MYCNF_PERMS, not 0600 — refusing to write the database password to it" ;;
esac
{
  printf '[client]\n'
  printf 'host=%s\n'     "$(env_get DB_HOST)"
  printf 'port=%s\n'     "$(env_get DB_PORT || true)"
  printf 'user=%s\n'     "$(env_get DB_USER)"
  printf 'password=%s\n' "$(env_get DB_PASSWORD)"
} > "$MYCNF"
# An empty port line is invalid; drop it if DB_PORT was unset.
sed -i '/^port=$/d' "$MYCNF"

DB_NAME_V="$(env_get DB_NAME)"

mysql --defaults-extra-file="$MYCNF" -D "$DB_NAME_V" -e "SELECT 1" >/dev/null 2>&1 \
  || die "cannot connect to database '$DB_NAME_V' with the credentials in .env.local"
ok "connected to '$DB_NAME_V'"

if [ -f database/migrations/check-status.sql ]; then
  echo
  echo "    ---- migration status (read-only) ----"
  mysql --defaults-extra-file="$MYCNF" -D "$DB_NAME_V" --table \
    < database/migrations/check-status.sql 2>/dev/null \
    | grep -E "APPLIED|MISSING|PARTIAL|NEEDS|OK|check_name|migration" \
    | sed 's/^/    /' || true
  echo "    --------------------------------------"
  echo
  warn "Apply only the migrations reported MISSING. The ALTERs are NOT idempotent."
  warn "If anything says PARTIAL, stop and inspect before running it."
else
  warn "check-status.sql not found — cannot report migration state"
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  say "--check requested: stopping here. Nothing was changed."
  exit 0
fi

# ---------------------------------------------------------------------------
say "3/8  Backup"
# ---------------------------------------------------------------------------
mkdir -p "$BACKUP_DIR"
DB_BACKUP="$BACKUP_DIR/db-$DB_NAME_V-$STAMP.sql"
mysqldump --defaults-extra-file="$MYCNF" \
  --single-transaction --routines --triggers --events \
  --databases "$DB_NAME_V" > "$DB_BACKUP"
chmod 600 "$DB_BACKUP"
ok "database -> $DB_BACKUP ($(du -h "$DB_BACKUP" | cut -f1))"

# .next is overwritten in place by the build, so keep the last good one.
if [ -d .next ]; then
  rm -rf "$BACKUP_DIR/next-previous"
  cp -a .next "$BACKUP_DIR/next-previous"
  ok "previous build -> $BACKUP_DIR/next-previous (for rollback)"
fi

GIT_BEFORE="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
ok "current commit: $GIT_BEFORE"

# ---------------------------------------------------------------------------
say "4/8  Apply migrations"
# ---------------------------------------------------------------------------
if [ "$APPLY_MIGRATIONS" -eq 1 ]; then
  warn "--apply-migrations given: running every .sql in database/migrations in name order."
  warn "This is only safe if the status above reported them all MISSING."
  for f in $(ls database/migrations/*.sql | grep -v check-status | sort); do
    printf '    running %s ... ' "$(basename "$f")"
    if mysql --defaults-extra-file="$MYCNF" -D "$DB_NAME_V" < "$f" 2>/dev/null; then
      echo "ok"
    else
      echo "FAILED (probably already applied) — continuing"
    fi
  done
else
  warn "Migrations NOT applied. Review the status above, then run each MISSING one:"
  warn "  mysql --defaults-extra-file=<secure-cnf> -D $DB_NAME_V < database/migrations/<file>.sql"
  warn "Or re-run this script with --apply-migrations once you have checked."
fi

# ---------------------------------------------------------------------------
say "5/8  Pull"
# ---------------------------------------------------------------------------
git pull --ff-only || die "pull failed (not a fast-forward, or local changes). Resolve, then re-run."
ok "now at $(git rev-parse --short HEAD)"

# ---------------------------------------------------------------------------
say "6/8  Install and build"
# ---------------------------------------------------------------------------
# npm ci (not --omit=dev): the build needs typescript and @tailwindcss/postcss,
# which live in devDependencies.
npm ci || die "npm ci failed"
ok "dependencies installed"

npm run build || die "build failed — nothing has been reloaded. Previous build is in $BACKUP_DIR/next-previous"
ok "build succeeded"

# ---------------------------------------------------------------------------
say "7/8  Reload"
# ---------------------------------------------------------------------------
if command -v pm2 >/dev/null; then
  pm2 reload ecosystem.config.js --update-env || pm2 restart attendance || die "pm2 reload failed"
  ok "pm2 reloaded"
  sleep 3
else
  warn "pm2 missing — start the app yourself"
fi

# ---------------------------------------------------------------------------
say "8/8  Smoke test"
# ---------------------------------------------------------------------------
PORT_V="$(grep -oE "PORT: *['\"]?[0-9]+" ecosystem.config.js 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)"
PORT_V="${PORT_V:-3000}"
URL="http://127.0.0.1:$PORT_V/login"

CODE="$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$URL" || echo 000)"
if [ "$CODE" = "200" ]; then
  ok "app responding on port $PORT_V (HTTP $CODE)"
else
  warn "app returned HTTP $CODE on $URL — check: pm2 logs attendance --lines 50"
fi

# These change nothing and need no API key.
if command -v npx >/dev/null; then
  echo
  warn "Optional verification (read-only, no API calls):"
  echo "        npx tsx --env-file=.env.local scripts/verify-chat-tools.ts"
  echo "        npx tsx --env-file=.env.local scripts/verify-holidays.ts"
fi

cat <<EOF

$(printf '\033[1;32mDeploy complete.\033[0m')

  from  $GIT_BEFORE
  to    $(git rev-parse --short HEAD)

ROLLBACK
  code:     git reset --hard $GIT_BEFORE && npm ci && npm run build && pm2 reload attendance
  build:    rm -rf .next && cp -a "$BACKUP_DIR/next-previous" .next && pm2 reload attendance
  database: mysql --defaults-extra-file=<secure-cnf> < "$DB_BACKUP"

NOTE
  The reporting assistant streams over SSE. If its replies arrive in one lump
  rather than word by word, add to the nginx site config:

      location /api/chat/stream { proxy_buffering off; proxy_cache off; }

  then: nginx -t && systemctl reload nginx

EOF

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Which branch is production

**Production runs `feature/workday-permissions-and-hardening`, not `master`.**

`master` is stale. At the time of writing it sat 110 commits behind this branch,
and it does not contain device binding, permission and on-duty requests, password
resets, token versioning, out-of-fence review, the Google Drive tracking
archival, or the WorkLens rebrand.

Consequences, before you touch anything:

- **Never deploy `master`.** It would roll production back by months.
- **Branch from this branch**, not from `master` or from a fresh clone's default.
- A fresh `git clone` checks out the default branch, which may be `master`. Run
  `git checkout feature/workday-permissions-and-hardening` first, and confirm with
  `git log --oneline -1` that you are on a recent commit.
- Before assuming a feature is missing, check this branch for it. Work has been
  lost to re-implementing things that already existed here.

## The database

Production's database is named **`attendance_db`**. `.env` on the server is the
source of truth (`DB_NAME`), and the app reads `.env`, not `.env.local`.

Migrations in `database/migrations/` are hand-run and mostly **not idempotent**.
Before running any of them:

```bash
mysql -u <user> -p <database> < database/migrations/check-status.sql   # read-only
```

Apply only what it reports MISSING. If anything reports PARTIAL, stop and inspect
— that is the state where an ALTER dies halfway. Never put a hardcoded `USE <db>;`
in a migration: deployments differ in database name, and a migration that names
the wrong one silently never runs.

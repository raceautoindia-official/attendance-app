<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Which branch is production

**`master`. It is also GitHub's default branch and what the server deploys.**
One branch, one truth — branch from it, deploy it, clone it.

It was not always so. Production ran `feature/workday-permissions-and-hardening`
while `master` sat 112 commits behind as the GitHub default, so a fresh clone
gave you the stale branch and any PR targeted a branch nothing deployed. That
cost a working session and stranded finished work on the wrong side. The two
were merged into `master` on 2026-10-03; the feature branch is kept only as a
short-lived fallback and should be deleted once `master` has proven stable.

If you ever find production on a branch other than `master` again, stop and fix
that before writing code — not after.
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

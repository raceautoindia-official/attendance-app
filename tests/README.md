# Tests

These run against a **running server and a real database**. They are not unit
tests and there is no framework: each file is plain Node, prints `PASS`/`FAIL`
lines, and exits non-zero if anything failed.

```bash
node tests/journey.js
```

Point them somewhere other than localhost with `TEST_BASE_URL`:

```bash
TEST_BASE_URL=https://attendance.raceinnovations.in node tests/journey.js
```

Every suite restores what it touched, but **run them against staging first**.
They clock employees in and out and change schedule settings while running.

---

## Why these exist

Three broken features reached production despite a large, green test suite.
They shared one cause: every test verified a piece of code by **calling it
directly**, which proves the logic and nothing about whether the system uses
it.

- The away-from-site watchdog was proven by POSTing to
  `/api/cron/live-tracking-monitor`. Nothing in the system ever called that
  endpoint. The logic was correct and the feature was dead.
- Auto clock-in on returning to site was never exercised for a single-session
  employee, so a silent skip looked like intended behaviour.
- Logging out and back in was never tested until a user did it and was locked
  out.

Running the old suite ten more times would have produced ten more green runs.

## The two that matter most

### `journey.js` — what a person does

Walks a whole day over HTTP only: sign in, clock in, leave the site, come back,
clock out, sign out, sign in again, and a stale refresh token.

Two rules keep it honest:

- it may **not** call `/api/cron/*` — if scheduled work does not happen by
  itself, that is the bug, and triggering it by hand would hide it;
- it may **not** write attendance rows directly — clocking goes through the
  API, so a refusal the real app would hit is a refusal here too.

Admin configuration (switches, schedules) is set up in SQL, because an admin
sets that up too. Nothing about the day itself is.

### `wiringcheck.js` — does the scheduled work happen on its own

Plants a situation the server must act on, then **touches nothing**:

```bash
TEST_EMPLOYEE_ID=<id> node tests/wiringcheck.js seed
# start the server, wait ~60s, call no endpoints
TEST_EMPLOYEE_ID=<id> node tests/wiringcheck.js verify
```

It writes **real attendance** for that employee, so there is no default id —
name a test account explicitly. It refuses to run against someone who is
clocked in right now, snapshots their schedule before touching anything, and
restores it during `verify` whatever the verdict.

If the row changed, a scheduler really runs the work. This fails loudly when
logic is correct but wired to nothing — the exact gap that let a dead feature
ship.

## The rest

| file | covers |
| --- | --- |
| `fencecycle.js` | leave the fence → clocked out; return → clocked back in, first stretch banked; and the single-session refusal being reported rather than silent |
| `tightfence.js` | a small radius is enforced exactly — clock-in refused just outside it, and someone who walks out mid-shift is clocked out |
| `locationwarnings.js` | location off → exactly 4 warnings, spaced, then an automatic clock-out; and the paths that actually deliver them |
| `deadlocation.js` | a deactivated work location fences nobody — clock-in refuses as a misconfiguration rather than measuring against stale coordinates |
| `whynologout.js` | the `why_no_auto_logout.sql` diagnostic agrees with the watchdog, gate by gate |
| `notifications.js` | off-site clock-ins reach the admin Notifications tab, and approving OR rejecting never changes anybody attendance — an unreviewed one counts in full |
| `offsitereason.js` | clocking in away from the site with a reason — refused without one, recorded as outside with it, alerted to an admin, and a reason from inside the fence records no exception |
| `fencetoggle.js` | the per-person geofence checkbox — unticking leaves live tracking running, and a fence is refused without usable coordinates |
| `livelist.js` | Live Tracking lists everyone who is clocked in, reporting or not — a quiet phone shows as a row with no coordinates instead of disappearing |
| `autologin.js` | coming back to the site clocks you in again after the SERVER clocked you out — the case that never worked in production — while a manual clock-out still ends the day |
| `doubleclockin.js` | two clock-ins fired at once — only one may win, or the race erases the hours already banked that day |
| `enablerollout.js` | `enable_auto_logout.sql` is a dry run until told otherwise, and never arms a phone that is not reporting — the mistake that would have cost six people about seven hours each |

## Writing another one

Prefer a journey over a unit. If you find yourself calling an internal function
or a cron endpoint to make something happen, ask what makes it happen in
production — and test *that* instead.

# HR portal plan — navigation, alerts, and payroll

Written 2026-10-12, against the tree at `master` + the uncommitted platform work
(org structure, RBAC, onboarding, holidays).

Three asks, in the order they were given:

1. **The portal looks complicated.** 18 sidebar entries, 21 admin pages. Needs a
   feasible way down, not a redesign that rewrites every page.
2. **Alerts** for repeated lateness, heavy leave, and anyone who has not clocked
   in.
3. **An HR portal structure** that manages salary and payroll, synced with what
   is already here.

## 0. A brief that changed, on purpose

`docs/POLICY-SYSTEM-PLAN.md` section 6 says, under **Deliberately NOT in the
policy**:

> Salary, CTC or pay rates. The brief said "not salary details", and keeping
> money out means this stays an attendance system whose output *supports*
> payroll rather than a payroll system with weaker controls than a real one.

That brief has now changed — payroll comes in. The *reasoning* in it still
stands and shapes this plan: money needs controls attendance does not have, so
payroll gets things no other part of this app has, namely **snapshots**, an
**approval step**, **immutability after approval**, and **its own permissions**.
Salary still does not go into `policies`. It goes in its own dated table.

---

## 1. What is actually there now

| | Count |
|---|---|
| Admin pages | 21 |
| Sidebar entries | 18, in 5 groups |
| Pages with no sidebar entry | 3 (`/hours` redirects, `/review`, `/regularisations`) |
| API routes | 96 |
| Database tables | 40 |
| Verification suites | 37, all passing |

Relevant machinery that payroll and alerts can stand on rather than reinvent:

- `lib/hoursLedger.ts` — required vs worked vs credited, per employee per day.
- `lib/payrollExport.ts` — the month's hours as a pack, with provenance and a
  **checksum over the figures only**, so a disputed file can be verified.
- `lib/monthClose.ts` — a month can be closed, which locks attendance writes.
  Deliberately **not** a snapshot: figures stay derived.
- `lib/exceptions.ts` — already detects short days (< 0.6 of requirement), a low
  average (< 0.75 over >= 5 days), an implausible day (> 14h), and absence
  streaks (>= 5 days). Read-only, month-scoped, no storage, no delivery.
- `lib/scheduler/autoClockOut.ts` — a self-healing 15-minute sweep plus a faster
  live-tracking sweep. Idempotent, no external crontab.
- `lib/mailer.ts` — SES API or SMTP, whichever is configured.
- `lib/access.ts` — `can()`, `scopeOf()`, `visibleEmployeeIds()`,
  `employeeScopeSql()`. Scopes are `self | team | department | all`.
- `policies` — statutory **flags** per policy (`pf_applicable`, `esi_applicable`,
  `professional_tax_applicable`, `income_tax_tds_applicable`, `lwf_applicable`,
  `gratuity_applicable`, `bonus_applicable`), plus `overtime_multiplier`,
  `probation_months`, `notice_period_days`.
- `employees` — `joined_on`, `last_working_day`, `probation_ends_on`, bank
  account + IFSC, PAN, Aadhaar.
- `permissions` — the catalogue already contains `payroll.export`.

What is missing is narrower than it looks: **no money anywhere**. No salary
column on `employees`, no rates behind the statutory flags, no payroll run, no
payslip, no notification table, no alert thresholds.

---

## 2. Navigation — why it feels complicated, and the way down

### The diagnosis

It is not the number of pages. It is that **five entries all mean "somebody is
waiting on a decision from me"** and **three mean "what did people work"**, and
nothing on screen says which to open:

| Entry | What it actually is |
|---|---|
| Notifications | off-site clock-ins + permission requests, grouped by day |
| Permissions | the permission request queue, again |
| Regularisations | attendance correction requests — **not in the sidebar at all** |
| Review | the month's exceptions — **not in the sidebar at all** |
| Checkin Records | today's and past attendance, with its own exception strip |

Three more problems:

- **Seven of the 18 are setup** (Policies, Schedules, Holidays, Locations, Roles
  & Access, Audit Log, Organisation) and sit in the same rail as daily work.
  Setup is touched once a quarter.
- **Two features are invisible.** `/review` and `/regularisations` are reachable
  only from links inside other pages. A feature nobody can find does not exist.
- **The employee side has one page.** `/dashboard`. Payslips, claims and
  declarations have nowhere to live, so the HR ask forces this open anyway.

### The approach: fewer destinations, more tabs

This is already proven in this codebase. `/organisation` is **four** views
behind one entry (Structure, People, Grades, Company) and is the least confusing
screen in the app. The same move applied everywhere takes 18 entries to **7**,
with no page rewritten — each existing page becomes a tab component.

| New entry | Route | Tabs (existing pages, moved) |
|---|---|---|
| **Today** | `/overview` | one screen: who is in, who has not clocked in, who is late, open alerts |
| **Inbox** `(badge)` | `/inbox` | Needs a decision · Permissions · Leave · Regularisations · Off-site · Month review |
| **People** | `/people` | Employees · Joining & leaving · Organisation · Documents |
| **Time** | `/time` | Attendance · Leave · Permissions · Schedules · Holidays |
| **Pay** | `/pay` | Salary · Payroll runs · Payslips · Statutory · Bank file *(new)* |
| **Insight** | `/insight` | Reports & hours · Performance · Live tracking |
| **Settings** | `/settings` | Policies · Locations · Roles & access · Audit log · Company |

The Inbox is the one real consolidation: it replaces Notifications, the
Permissions queue, Regularisations and Review **as destinations**. They become
filters over one queue whose badge is the only number an admin has to watch.
Permissions and Leave still appear under Time, because reading the month's leave
is a different job from deciding today's request.

### How it gets done without a rewrite

1. Parent route renders a `<Tabs>` shell; each old page body moves into a
   component untouched. `/organisation` already shows the shape.
2. **Every old URL keeps working** as a redirect that carries its query string
   across — the `/hours` page is the precedent and the comment at the top of it
   explains why: bookmarks and in-app links are already out there.
3. One group at a time, each shippable on its own. Nav shell first, then People,
   Time, Insight, Settings, and Pay last because it does not exist yet.

### Two things to add while the rail is open

- **Command palette** (Ctrl/Cmd-K): type "late", "payslip", "RACE014" and go
  straight there. Tabs add a level of depth, and this is what pays for it. The
  sidebar already has a search box to build on.
- **Role-filtered nav.** The rail is currently filtered by
  `superAdminOnly`, a hard-coded flag. It should ask `can()` instead, so a
  manager sees Today, Inbox, People, Time and Insight — five entries — and
  never sees a page that will refuse them. The permission layer is already
  there and the sidebar is the last place still ignoring it.

### What shipped, 2026-10-12

Phase A is in the tree, and it diverged from the plan above in one way
worth writing down.

**The plan said each page would *become* a tab component, with the old URL
redirecting.** It did not need to. Each page stayed exactly where it is and
the tab strip navigates between the routes - so no page was rewritten, no
redirect was written, and every tab is still its own deep-linkable,
bookmarkable URL with a working back button. Same information
architecture, a fraction of the churn, and nothing to un-break later.

| | |
|---|---|
| Rail entries | 18 -> **6** (Today, Inbox, People, Time, Insight, Settings) |
| Pages | 21, all of them reachable; two that were in no menu now have one |
| New | `/inbox`, the one queue |
| New | Ctrl/Cmd-K command palette, reaching pages **and people** |
| New | `lib/nav.ts` - one definition the rail, tabs, palette, phone bar and page title all read |
| New | `GET /api/access/me` + `useNavAccess`, so the rail asks the permission system |
| Gone | the `superAdminOnly` flag, the group-collapse state, its localStorage, and the second hard-coded title list that left 11 pages titled "Admin" |

**Pay is not in the rail yet.** It arrives in phase C, with something
behind it. Six entries, not seven, until then.

**The Inbox does not decide anything.** Each row links to the page that
owns the rule - a permission request has to be checked against the monthly
hours cap, a correction rewrites an attendance row under an audit entry.
What it adds is the fact none of those four pages carried: how long
something has been waiting. Inline approval is a later, deliberate step.

**Nobody lost access.** `canSee` consults the legacy role for anybody with
no row in `employee_roles` - which is everybody - so the rail shows exactly
what it showed before, and becomes permission-driven the moment a role is
granted. `scripts/verify-nav.ts` asserts that page by page, and would fail
if a future edit quietly hid one.

Covered by `scripts/verify-nav.ts` (58 checks, no database - including a
filesystem sweep that fails if an admin page exists with no menu entry) and
`scripts/verify-inbox.ts` (38 checks against planted rows of known age).

### The employee surface

`/me`, with tabs: Today · My attendance · My leave · **My payslips** · My
documents · My checklist. Needed for payroll self-service, and it is also where
"you have been late four times this month" belongs — self-correction before
escalation.

---

## 3. Alerts

### Three families, because they need three cadences

**Live** — evaluated on the existing sweep, concerning today:

| Rule | Fires when | Suppressed by |
|---|---|---|
| `not_clocked_in` | a scheduled working day, no clock-in by shift start + grace + N | week-off, holiday, approved leave, an approved permission covering the start, **a flexible shift** |
| `no_clock_out` | the work day ended (07:00 IST) with a session still open | already settled by the sweep — the alert records that it was settled rather than measured |
| `off_site_clock_in` | clock-in outside the fence | nothing; it needs a human |
| `phone_silent` | tracking stopped mid-session | exists today in `liveTrackingMonitor` |

The flexible-shift exclusion is not a nicety. Lateness is only measurable
against a shift start; twelve people are on flexible schedules and an alert that
calls them late every morning is how the whole feature gets muted in week one.

**Pattern** — evaluated once a day, over a month or rolling window:

| Rule | Default threshold |
|---|---|
| `late_pattern` | late on >= 3 days in the month, counting only days where lateness is measurable |
| `leave_pattern` | >= 4 leave days in the month |
| `leave_quota_breached` | leave taken exceeds the policy entitlement for the year |
| `absence_streak` | >= 5 consecutive absent days *(exists)* |
| `low_average_hours` | < 0.75 of requirement over >= 5 days *(exists)* |
| `short_day`, `implausible_day` | *(exist)* |

**Lifecycle** — once a day, nothing to do with attendance:

`probation_ending` (within 14 days) · `onboarding_task_overdue` ·
`document_missing` (from `documentCompliance`) · `month_not_closed` (previous
month still open after the 7th) · `no_policy_assigned` · `unplaced_in_org`
(17 of the 18 active people today) · `bank_details_missing` (blocks payroll).

### Where the thresholds live

**In `policies`, every one nullable, and NULL means off.** This is the same
ship-inert discipline the rest of the policy system uses: deploying the feature
changes nobody's experience until somebody sets a number, and different groups
can have different numbers — a plant and an office do not share a view of
lateness.

New nullable policy columns: `late_alert_days_per_month`,
`leave_alert_days_per_month`, `missing_clockin_alert_minutes`,
`low_hours_alert_ratio`, `alert_digest_enabled`.

### Schema

```
alert_rules      rule_key (pk), label, description, family, default_severity,
                 is_enabled, created_at
alerts           id, rule_key, employee_id NULL, employee_key GENERATED
                   (COALESCE(employee_id,0)), period_key, severity, state
                   enum('open','acknowledged','resolved'), detail JSON,
                   first_seen_at, last_seen_at, acknowledged_by, acknowledged_at,
                   acknowledge_note, resolved_at
                 UNIQUE (rule_key, employee_key, period_key)
alert_deliveries id, alert_id, channel enum('inbox','email'), recipient_id,
                 sent_at, error
```

The generated `employee_key` is not decoration. A unique key containing a
nullable column does not dedupe in MySQL — `NULL != NULL` — and that exact bug
already put two identical rows in `holiday_countries` during this project.
Company-level alerts have no employee, so they need the sentinel.

### Rules of engagement

- **One row per employee per rule per period**, updated rather than re-inserted,
  so a week of lateness is one alert with a rising count, not seven.
- **Auto-resolve.** Alerts are recomputed; when the fact goes away (leave is
  approved retrospectively, attendance is corrected) the alert resolves itself.
  A stale alert nobody can clear is how a queue gets abandoned.
- **Acknowledge with a note**, audited. "Spoke to him, hospital visit" is the
  outcome of most of these, and it belongs on the record.
- **Snooze** per rule per employee, with an expiry.
- **Scope-aware delivery.** A manager sees their own team's alerts via
  `employeeScopeSql()`; HR sees all. New permissions: `alerts.view` (scopable),
  `alerts.manage`.
- **One email a day, not one per alert** — a digest, off by default, per policy.
  There is no push channel: no device token is stored anywhere, so in-app plus
  email is the whole delivery surface until the mobile app gains one.

### Where it runs

Inside the existing 15-minute sweep in `lib/scheduler/autoClockOut.ts`. It is
idempotent, self-heals after a restart, and needs no crontab — the same reasons
it was chosen for marking absentees. Pattern and lifecycle rules run once per
day on the first sweep after 08:00 IST; live rules run every sweep.

### What shipped, 2026-10-12

Phase B is in the tree. `database/migrations/2026-10-12_alerts.sql` is
**not yet applied to production** - it joins the five already waiting.

**Seven rules, not twelve.** The ones asked for plus the cheap, low-volume
ones:

| Rule | Family | Fires when |
|---|---|---|
| `not_clocked_in` | live | rostered today, grace plus policy allowance gone, nothing clocked |
| `late_pattern` | pattern | late days this month reach the policy's number |
| `leave_pattern` | pattern | leave days this month reach the policy's number |
| `low_hours_pattern` | pattern | credited hours below the policy's share of required |
| `probation_ending` | lifecycle | probation ends within a fortnight |
| `onboarding_overdue` | lifecycle | a joining or leaving task is past its date |
| `month_not_closed` | lifecycle | last month still open after the 7th |

Deferred on purpose: `document_missing`, `bank_details_missing`,
`unplaced_in_org` and `no_policy_assigned`. All four are setup hygiene, and
the last two would open seventeen alerts on the morning they were switched
on. They matter for payroll readiness, so they arrive with phase D and the
run that needs them.

Nothing restates what the inbox already carries - pending requests,
corrections, off-site clock-ins - or the queue would double-count and the
badge would stop meaning anything.

**Three deviations from the plan above.**

*The digest is an env flag, not a policy column.* The plan listed
`alert_digest_enabled` on the policy. A policy describes the people being
measured; a digest is about who RECEIVES it, and those are different sets.
It is `ALERT_DIGEST=on`, recipients are active super admins with an email,
and a per-manager narrowed digest is a separate feature worth doing
deliberately rather than by accident.

*`employee_key` is VIRTUAL, not STORED.* MySQL refuses `ON DELETE CASCADE`
on a column that a stored generated column is built from - error 1215, found
by hitting it. Virtual still carries the unique index, which is all it is
for, and it is what `holiday_countries` already does.

*The employee's own view went on the existing dashboard*, not a new `/me`
section. That section is worth building when payslips need it.

**Where they surface:** the Inbox (as a sixth kind, with the only inline
action in that queue - acknowledge with a note, or snooze a week), a strip at
the top of Today that renders nothing when there is nothing, the employee's
own dashboard re-worded in the second person, and one daily email.

**How they run:** inside the existing fifteen-minute sweep. Live rules every
sweep; pattern and lifecycle once a day after 08:00 IST, claimed through a
unique row in `alert_deliveries` so a restart cannot re-run them and two
processes cannot both do it.

**Thresholds** are four nullable policy columns, set on the Policies page
under *Alerts - empty means silence*. NULL is off, so applying the migration
changes nobody's morning. Lateness and hours come from `buildHoursLedger`,
the same function the Reports page and payroll pack read, so an alert can
never disagree with the report it came from.

Covered by `scripts/verify-alerts.ts` (57 checks): nothing fires with no
threshold; four runs leave one row; an alert resolves itself when the fact
goes and reopens as the SAME row if it returns; an acknowledged one is not
reopened to be acknowledged again; a flexible-shift employee is never named
by either lateness rule; approved permission and leave both suppress
`not_clocked_in`; a company-level alert with no employee dedupes exactly once
(which is what the generated key is for).

One API change fell out of it: `buildInbox` now takes employee **ids** and
builds its own clauses, because the version that took a ready-made WHERE
fragment needed a second one for the alerts table - and a caller that passed
the first and forgot the second got a narrowed list of requests beside an
unnarrowed list of alerts. `verify-inbox` caught it while testing something
else.

### Where it surfaces

Inbox (the badge), Today (a strip: "3 not clocked in, 2 late"), the employee's
own `/me` page for their own alerts only, and the daily email digest.

---

## 4. Payroll

### Decisions taken, 2026-10-12

| Question | Answer | Consequence |
|---|---|---|
| Where is payroll done today | **Excel, by hand, in-house** | the app becomes the system of record and replaces the sheet |
| How is pay defined | **one fixed monthly amount, no components** | no CTC breakup, no Basic/HRA split to maintain |
| Statutory | **PF, ESI, PT, TDS, LWF** | a real statutory engine with dated rates, not flags alone |
| Overtime | **banked by default, paid when approved** | OT becomes money only through an explicit, audited conversion |

### The one tension, and how it is resolved

A single fixed monthly figure and PF cannot both be taken literally. **PF is
computed on basic wages**, not on gross, and there is no basic in a one-figure
model. The options are to make everybody enter a basic (which is the component
split that was just rejected), or to derive it.

**Derive it, from one company-wide setting.** `statutory_settings` carries
`pf_basic_percent_of_gross` (50% is the common convention), and the PF wage is
`min(basic_derived, pf_wage_ceiling)`. A per-employee `pf_wage_override` exists
for the cases where the derived figure is wrong — a senior hire whose PF is
capped, somebody with a declared basic in their offer letter.

This keeps data entry at one number per person, which is what was asked for, and
makes PF computable and explainable. The payslip states the basis it used, so
nobody has to reverse-engineer it later.

Same shape for the rest: **ESI** on gross minus LOP, when below its ceiling.
**PT** from a slab table by state and month, because Tamil Nadu pays half-yearly
and Maharashtra monthly. **LWF** by frequency. **TDS** is the one that cannot be
automated honestly in phase one — it needs declarations, proofs and projections
— so until phase E it is **a monthly amount entered per employee**, which is
exactly what the Excel sheet does today. Better an honest input than a wrong
computation.

### Schema

```
employee_salary      id, employee_id, effective_from, monthly_gross,
                     pf_wage_override NULL, revision_note, created_by, created_at
                     UNIQUE (employee_id, effective_from)

statutory_settings   id, effective_from, pf_employee_rate, pf_employer_rate,
                     pf_wage_ceiling, pf_basic_percent_of_gross,
                     esi_employee_rate, esi_employer_rate, esi_wage_ceiling,
                     lwf_employee, lwf_employer, lwf_months,
                     gratuity_percent, pt_state_code

pt_slabs             id, state_code, effective_from, from_amount, to_amount,
                     monthly_tax, due_months

payroll_runs         id, period_month, status
                       enum('draft','computed','approved','paid','cancelled'),
                     is_provisional, hours_checksum, standard_monthly_minutes,
                     computed_by, computed_at, approved_by, approved_at,
                     paid_on, notes

payroll_lines        id, run_id, employee_id, monthly_gross, paid_days,
                     lop_days, lop_amount, ot_minutes_paid, ot_amount,
                     other_earnings, pf_employee, pf_employer, esi_employee,
                     esi_employer, professional_tax, tds, lwf_employee,
                     advance_recovery, other_deductions, net_payable,
                     basis JSON
                     UNIQUE (run_id, employee_id)

payroll_inputs       id, period_month, employee_id, kind
                       enum('reimbursement','incentive','arrear','deduction',
                            'advance_recovery','ot_payout','tds'),
                     amount, note, approved_by, approved_at

employee_advances    id, employee_id, amount, issued_on, monthly_recovery,
                     outstanding, closed_on            (phase E)
```

`employee_salary` is **dated revisions**, the same pattern as
`employee_org_assignments`: a raise in June leaves May's payroll reproducible.
`payroll_lines` is a **snapshot**, deliberately unlike `monthClose` — attendance
figures stay derived because they must stay correctable, but what somebody was
paid must never change because a shift definition was edited afterwards.

### Computation order

Written down because it has to be reproducible and arguable:

1. Salary effective on the last day of the period, from `employee_salary`.
2. Hours from `buildHoursLedger` for the period: working days, days present,
   LOP days (absent, uncovered by leave), banked OT minutes.
3. `gross = monthly_gross`; `lop_amount = gross / working_days * lop_days`.
   Working days from the roster, not calendar days — the policy already decides
   what a working day is, and two definitions of it would make the payslip
   disagree with the hours report.
4. OT money **only** from an approved `ot_payout` input. Rate is
   `gross / standard_monthly_hours * overtime_multiplier` from the policy.
   Converting debits the banked balance, so it cannot be paid twice.
5. Statutory, in order: PF (on derived basic, capped), ESI (if under ceiling),
   PT (slab), LWF (if a due month), TDS (input).
6. `net = gross - lop + ot + other earnings - employee deductions - advance recovery`.
7. Employer contributions are **reported, never deducted** — they are a cost
   line, and showing them as a deduction is the classic payslip complaint.

### Gates

- A run for a month that is **not closed** is marked `is_provisional` and
  **cannot be approved**. Closing is already the act that freezes attendance;
  paying against unfrozen hours is the thing the month close exists to prevent.
- Computing stores the payroll pack's `hours_checksum`, so a payslip can be
  traced to the exact hours file it came from — the pack's checksum covers
  figures only, so it survives a regeneration.
- `approved` is immutable. A mistake is corrected by **cancel + recompute**,
  both audited, never by an edit.
- Permissions: `payroll.view` (scopable — an employee sees self),
  `payroll.view_salary` (separate, exactly like `employee.view_identity`, because
  most managers need the person and not their pay), `payroll.manage`,
  `payroll.approve`, and the existing `payroll.export`.

### Outputs

Payslip PDF (per line, stating its basis) · payroll register xlsx · **bank
transfer file** with a validation report naming anybody whose IFSC or account is
missing · PF ECR text file · ESI contribution csv · PT summary by state ·
departmental cost report, grouped from `employee_org_assignments`.

### What syncs with what

| Existing | Feeds |
|---|---|
| `hoursLedger` / payroll pack | paid days, LOP days, OT minutes, and the checksum on the run |
| `monthClose` | the gate: provisional until closed |
| `policies` statutory flags | which contributions apply to whom |
| `policies.overtime_multiplier` | the OT payout rate |
| `leave_records`, `leave_quotas` | what is paid leave and what is LOP |
| `holiday_calendar` | paid holidays, and holiday working |
| `employees` bank + PAN | the bank file and the PF/ESI returns |
| `employee_org_assignments` | cost by department, structure by grade |
| `documentCompliance` | a pre-run warning for missing PAN or bank proof |
| `employees.last_working_day`, `notice_period_days` | full and final settlement |
| `audit_log`, RBAC | every run action, and who may see pay at all |

### Deliberately out of scope

Income-tax projections and Form 16 generation (phase E at the earliest; a
chartered accountant's output, not an attendance app's), multi-currency,
contractor invoicing, and any attempt to file returns automatically.

---

### What shipped in phase C, 2026-10-12

Data and arithmetic. No payroll run, no payslip, nothing paid - and the page
says so at the top rather than implying otherwise.

`database/migrations/2026-10-12_payroll_foundation.sql` adds
`employee_salary` (dated revisions), `statutory_settings` (dated) and
`pt_slabs`, plus four permissions. It is **not yet applied to production**; it
joins the six already waiting.

**The PF compromise, as built.** One figure per person, and the PF basic is
`pf_basic_percent_of_gross` (seeded at 50) of gross, capped at the ceiling,
with a per-employee `pf_wage_override` for an offer letter that states a
basic. Every function returns the BASIS it used, so the breakdown reads
"PF 1,800 on a PF wage of 15,000 (derived basic 20,000, capped at the
ceiling)" rather than a bare number somebody has to reverse-engineer.

**Seeded, not verified.** The rates are the standard national ones and the PT
slabs are the published Chennai half-yearly bands. The Statutory screen
carries that sentence as a banner until somebody clears it, and the worked
example takes any gross so a real payslip can be typed in and compared. That
is the cheapest moment to discover the rates are wrong.

**What reads the policy flags.** `pf_applicable`, `esi_applicable` and the
rest have existed since the policy system shipped and had never been read by
anything. The breakdown is the first thing that reads them.

**TDS is an input, not a computation** - as planned. The preview says so in
the figure's place rather than inventing one.

**Pay is in the rail now**, super-admin only: `payroll.view` opens the
section and `payroll.view_salary` is what shows the amounts. Without the
second one the page still answers the question most people ask it - who is
missing a salary - with every figure withheld. All eighteen active people
currently have none, which the page leads with.

Covered by `scripts/verify-pay.ts` (83 checks): the ceiling at, above and
below; an override, including an override above the ceiling; a raise in July
leaving June readable; a correction on the same date replacing rather than
stacking; the half-yearly slab assessed on six months of pay; a gap between
slabs returning nothing rather than zero; 1200% refused as a rate; and a
manager without `payroll.view` refused by the API rather than merely not
shown the menu entry.

Two things the tests caught, both worth recording:

*My own expectations were wrong before the code was.* The first run asserted
ESI on a 30,000 gross. ESI stops at 21,000, so the code was right and the
test was not - which is exactly the mistake the ceiling exists to prevent,
made by the person who had just implemented it. There is now a case either
side of the line.

*`verify-policy-shift` had never deleted the attendance rows it writes.*
Employees are ON DELETE RESTRICT, so the leftovers made a LATER run fail at
its own cleanup rather than at anything it tested. Pre-existing, unrelated to
payroll, fixed here because it is in the tree.

### What shipped in phase D, 2026-10-12

The run. `database/migrations/2026-10-12_payroll_runs.sql` adds
`payroll_runs`, `payroll_lines` and `payroll_inputs`, plus `lop_basis` and
`lop_fixed_days` on the statutory settings. **Not yet applied to
production**; it joins the seven already waiting.

**The open question became a setting.** The plan said the first run has to
match whatever divisor the spreadsheet uses for loss of pay, and that the
answer was unknown. Rather than guess, `lop_basis` offers all three
conventions - roster working days, calendar days, or a fixed 26 - defaulting
to the roster. Each run RECORDS the one it used, so a reconciliation that
comes out wrong is one setting away from being right rather than a rebuild.

**The order of operations**, written down because somebody will one day
disagree with it: salary in force on the last day of the month; hours from
`buildHoursLedger`; loss of pay priced by the divisor; overtime only where
it was deliberately converted; statutory on what was EARNED rather than on
the full salary; net last. Employer contributions are reported, never
deducted.

**Every line stores its own working.** `basis` holds sentences - "PF wage
12,000 = 50% of 24,000 earned", "315 per half year, not due in month 8" -
and the payslip PDF prints them. A payslip that cannot be explained is one
that gets argued about.

**The gates, all tested:** a run on an open month is provisional and cannot
be approved; an approved run cannot be recomputed and nothing more can go
into it; approving twice is refused; the only correction is cancel with a
reason then recompute, and the cancelled run keeps its figures. One live run
per month, enforced by a nullable unique column - deliberately using the
same NULL != NULL behaviour that was an accident in `holiday_countries`.

**Overtime is converted, never assumed.** "Banked by default, paid when
approved" is a button per person per month that prices the banked minutes
from the salary and the policy multiplier - the multiplier that has been
recorded and unused since the policy system shipped - and refuses to convert
the same month twice.

**Three outputs:** the register as a spreadsheet with a provenance cover
sheet, a bank transfer CSV that LEAVES OUT anybody with no account or IFSC
and names them in the file rather than dropping them silently, and a payslip
PDF per person.

Covered by `scripts/verify-payroll-run.ts` (87 checks), including every
figure of three worked examples computed by hand in the comments.

**The tests caught my arithmetic twice.** First a net that assumed PF was
12% of gross rather than of the derived basic - the exact mistake the derived
basic exists to prevent, made by the person who had just built it. Then an
assertion that only our fixture would be skipped, when in truth all eighteen
real employees are skipped too, because none of them has a salary on record
yet. Both were the test being wrong and the code being right, which is the
better way round.

**Still to do before this pays anybody**, and it is the thing the plan
already insisted on: run a month side by side with the spreadsheet, confirm
the divisor, the PF basic convention and the PT slabs, and explain every
difference. Phase D is not finished until that comparison has been made.

### What shipped in phase E1, 2026-10-12

The month's OUTPUTS: to the employee, and to the filings. Phase E is listed
as one block in the table below, so this is the first slice of it - advances
with recovery schedules, TDS declarations and full-and-final settlement are
still to come.

`database/migrations/2026-10-12_statutory_ids.sql` adds `uan` and
`esic_number` to employees. **Not yet applied to production**; it joins the
eight already waiting.

**The employee can see their own payslip.** `/api/pay/me` plus a card on
their dashboard. Three rules, and they are the whole endpoint: the employee
id comes from the SESSION and there is no parameter that could be changed to
somebody else's; only `approved` and `paid` runs are visible, because a
provisional figure shown to the person it is about and then changed costs
more than a payslip that arrives three days late; and the PDF comes from
`lib/payslip.ts`, which the administrator's download also uses - so the two
copies cannot drift apart.

**Three filings.** The PF ECR (`#~#` delimited, eleven fields, with the
employer's 12% split into EPS at 8.33% and the EPF remainder), an ESI
contribution CSV, and a professional tax summary by slab with a per-person
list under it. Each is keyed on an identifier, so each ends with a block
NAMING whoever is missing theirs rather than leaving them out of a return -
the same discipline the bank transfer file already follows.

**The formats are written from the published layouts and have not been
through a portal.** The files say so in their own header, and so does the
page they are downloaded from. The first upload of each has to be checked.

**UAN and ESIC number** are stored beside PAN and Aadhaar and read under the
same `employee.view_identity` permission, kept out of `BANK_COLUMNS` on
purpose: `hasBankColumns` tests for one column from an older migration, so
adding these to that list would have made every employee read fail on a
deployment that has the bank columns and not yet these - which is
production, right now.

Covered by `scripts/verify-payslips.ts` (34 checks), and it earned its keep
immediately: **a draft run is invisible to the employee; a cancelled one
disappears again; the other employee asking for the same run id gets their
OWN line and not the first one's; the two PDF copies come out the same
size** - and it found a real bug. `String(dateFromMysql).slice(0, 7)`
returns "Wed Jul", not "2026-07". `toYmd` exists for exactly that and is
used everywhere else; four calls in the new routes had got away with the raw
`String()`, and the test asserting the month it got back is what caught it.

### What shipped in phase E2a, 2026-10-12

Advances, with a schedule the payroll run reads.
`database/migrations/2026-10-12_advances.sql` adds `employee_advances` and
`advance_recoveries`. **Not yet applied to production**; it joins the nine
already waiting.

**Why it is more than the deduction that already existed.** A run could
already carry a typed-in `advance_recovery`. The failure mode of that is not
a wrong figure, it is a month where nobody typed one - and an advance that
quietly stopped being recovered is discovered when the person leaves owing
money nobody tracked.

**Four rules, all tested:**

*Outstanding is derived*, never stored. Amount less what was actually
recovered; a stored balance is a second fact that can disagree with the
recoveries behind it.

*The last instalment is whatever is left.* 20,000 at 6,000 a month goes
6,000, 6,000, 6,000, 2,000 - never a fourth full instalment.

*A recovery never exceeds the pay.* Somebody with 3,000 left after
deductions does not have 6,000 taken off them: it is capped, the net floors
at zero rather than going negative, the remainder waits for next month, and
the payslip's working SAYS SO - an employee who expected 6,000 to come off
and saw 3,000 can read why.

*Booking happens on APPROVAL, not on compute.* A draft is recomputed
several times and each one would otherwise take the same instalment again.
The unique key on (advance_id, period_month) makes a double recovery
impossible even if the code tried, and cancelling an approved run reverses
its recoveries - reopening any advance those recoveries had closed, because
leaving it closed would lose the balance because of a bookkeeping action.

Two advances on one person are recovered oldest first, so the earlier one
clears rather than both being paid off slowly, and the allocation per
advance is stored in the line's `basis` - the approval books from there
rather than recomputing a schedule that may have moved on.

There is deliberately no "record a recovery" action. A recovery is what a
payroll run took; a second way to create one would be a second set of
numbers that can disagree with the payslips.

Covered by `scripts/verify-advances.ts` (65 checks).

### What shipped in phase E2b, 2026-10-12

Full and final, and income tax. Two migrations -
`2026-10-12_settlements.sql` and `2026-10-12_tax.sql` - neither applied to
production yet; they join the ten already waiting.

**This was built against unreconciled arithmetic, deliberately.** The plan
said to hold both until a real month had been checked against the
spreadsheet, that concern was raised, and the instruction was to proceed.
It still stands: the salary, gratuity and PF basic conventions underneath
these are the same ones the reconciliation has to confirm, so a mistake
there is now a mistake in two more places.

#### Full and final

One person, an arbitrary date, and three lines that exist nowhere else:
leave encashment, gratuity, and notice - which goes in either direction.

**The total is signed.** Somebody who leaves without serving notice while
holding an advance OWES the company, and a figure that floored at zero
would quietly forgive it. The page says "owed to us" rather than showing a
minus sign and hoping.

**Every figure is computed, then editable, and the difference is visible.**
Encashment on basic or on gross, four years and eight months counted as
five or not, notice recovered on basic or on gross - these vary more
between Indian employers than anything else in payroll. Each is a SETTING,
and on top of that any component can be overridden with a reason, keeping
the computed figure beside it. A second edit still shows the arithmetic's
number rather than the last typed one.

**Notice is not guessed.** Nothing in this database records how much notice
somebody actually served, so both notice lines start at zero and the
preparer enters what happened. A recovery invented from a date comparison
would be a number nobody could defend to the person it was taken from.

Approving closes the advances the statement says it recovered; cancelling
reopens them. Recomputing discards overrides, because the point of
recomputing is that something underneath moved.

#### Income tax

**The slabs are data.** Rates change in a budget, and a payroll that needs
a deployment to keep pace deducts the wrong tax every February. The bands,
the standard deduction, the rebate and the cess are rows with a financial
year on them, seeded for 2026-27 from the previously published rates and
marked as seeded until somebody confirms them.

**Declared and approved are two numbers, and payroll uses the second.**
Deducting on a claim is what produces a March shortfall nobody budgeted
for. An employee saves and submits their own declaration; only a reviewer
with `tax.manage` - its own permission, because a declaration carries
somebody's insurance, rent and loans - sets what payroll uses, and every
approval is capped at the section limit on the way in.

The run deducts the projection spread over the months remaining, and a
figure typed by hand always wins: an accountant who says otherwise is the
authority.

**What it does not do:** file anything, value perquisites, verify a proof,
or pretend a one-figure salary has an HRA component - the exemption is
computed against a derived basic and an assumed HRA, and says so in its own
notes.

Covered by `scripts/verify-settlement-tax.ts` (95 checks), with every tax
band and every gratuity figure worked by hand in the comments.

**One mistake worth recording.** The first draft of the F&F module was
written to `lib/settlement.ts`, which already existed - it holds the pure
rule for what a day with no clock-out is worth, read by the nightly sweep
and the history repair script. It was restored from git intact and the new
module is `lib/finalSettlement.ts`, which now carries a comment explaining
why the shorter name was not available.

### Fixes and corrections, 2026-10-12

#### Typing was broken everywhere, and the cause was one line

`Drawer` traps focus in an effect whose dependency array listed `onClose`.
All 39 call sites pass `onClose={() => ...}` - a new function on every
render - so the effect tore down and re-ran on EVERY render, which for a
controlled input is every keystroke: the cleanup handed focus back to the
button that opened the drawer, and the effect then moved it to the drawer's
first field. Every form in this app is a drawer, so "typing does not work"
was true everywhere at once. `onClose` is now held in a ref and the effect
depends on `open` alone. Modal never had the bug.

#### Number fields ate decimals

Fourteen fields on the statutory screen, plus the grade Rank and the leave
quotas, were written as `value={String(x)}` with
`onChange={e => setX(Number(e.target.value))}`. Typing "12.5" gives 125,
because the field is briefly asked to hold "12." and `Number("12.")` is 12.
Clearing one gives 0, because `Number("")` is 0, so it could not be emptied.
`components/ui/NumberField.tsx` keeps the TEXT while somebody types, reports
null for an empty field, and ignores a partial entry rather than rewriting
it.

Both are now guarded by `scripts/verify-input-contracts.ts` (11 checks), a
STATIC audit of the source: no effect that moves focus may depend on a
handler, no numeric field may parse on every keystroke, and no controlled
field or dropdown may exist without an onChange. There is no browser in
this test setup, and both bugs were invisible to all 45 other suites while
being obvious to anybody using the app for ten seconds.

#### The company profile and the work sites are linked

`locations` already held a name, an address, a city, a state, a country and
coordinates for six sites. `companies` then asked for an address again, in
its own columns, with nothing joining the two - so the registered address
and the site it is at could disagree and nobody would find out.

`2026-10-12_company_locations.sql` adds `locations.company_id` and
`companies.registered_location_id`, both nullable and both ON DELETE SET
NULL: attendance reads these rows on every clock-in, so nothing here may
become mandatory and deleting a company must not cascade into the geofence.

The statutory address columns STAY, because a filing uses what was filed -
what goes away is having to type it from memory. The Company screen picks a
registered office from the sites that exist and offers to copy its city and
country across; the location form says which company a site belongs to. And
**Work sites moved out of Settings into People**, beside the company
profile, because that is what they describe.

#### The payroll pages explain themselves

The Salary page now opens with the four steps in order - set a salary,
compute a month, check and approve, pay and file - rather than assuming the
reader knows what a run is. Jargon went: "kept as a dated history so an old
month stays reproducible" became "every change is kept with the date it
started, so an old month can still be worked out exactly as it was paid";
"banked unless somebody converts it" became "extra hours stay as time off
unless you choose to pay for them". Each of the five download buttons on a
run now says what the file is for.

## 4b. Payroll was removed, 2026-10-12

**Decision: payroll comes out entirely.** It was judged too complicated to
be worth it, and that is a reasonable verdict on what it had become - six
screens, five tables of money, three filing formats and two sets of
statutory conventions that nobody had yet confirmed against a real filing.

What was deleted: the Pay section and its six pages, eight API routes, six
libraries (`pay`, `payrollRun`, `advances`, `finalSettlement`, `tax`,
`payslip`), the employee payslip card, five test suites, and six migrations
- `payroll_foundation`, `payroll_runs`, `advances`, `settlements`, `tax`
and `statutory_ids`. The permissions those migrations seeded
(`payroll.view`, `payroll.view_salary`, `payroll.manage`,
`payroll.approve`, `tax.manage`) went with them, along with
`employees.uan` and `employees.esic_number`, which had no reader left.

None of it had ever been deployed, so production was never touched. The
local database was dropped back to match a fresh deployment.

**What deliberately stayed**, because it is older than this work and is
about HOURS rather than money:

* `lib/payrollExport.ts` and `/api/reports/payroll-pack` - the month's
  hours as a pack with provenance and a checksum, which is what a pay
  dispute is settled against.
* `permissions.payroll.export`, which governs that pack.
* `lib/settlement.ts` - nothing to do with full and final. It is the pure
  rule for what a day with no clock-out is worth, read by the nightly sweep
  and by the history repair script.
* The statutory flags on `policies` (`pf_applicable` and the rest), which
  predate all of this and are carried onto the hours pack.

The write-ups of phases C, D, E1, E2a and E2b above are left in place as a
record of what was built and why, including the conventions that were
chosen. If payroll is ever wanted again, that reasoning - and the list of
things that had to be confirmed first - is the useful part.

## 4c. The company chain, 2026-10-12

**company -> work sites -> departments -> people**, and it already existed
in the schema with none of it connected.

`locations.company_id` was added this week; `departments.company_id` has
been there since the org migration. Nothing in the application ever set
either. So six work sites belonged to no company, three departments
belonged to no company, seventeen people were rostered at a site while one
was placed in a department - and every screen looked fine.

What was built:

* A **Company** picker on the department form, which writes the column that
  had never been written.
* The chain, **counted** on the Company tab: sites, departments, and people
  BOTH ways - through the department (the org chart) and through the work
  site (the roster). When those two numbers disagree the card says so,
  because that disagreement is the only visible symptom of a half-connected
  chain.
* The **gaps**, named: which sites and departments belong to no company, and
  who is rostered at one company's site while placed in another company's
  department. A screen that shows only what IS connected cannot tell anybody
  what is missing, and missing is the normal state here.
* The employee wizard labels each work site with its company, and the create
  endpoint returns a warning when the chosen site and department belong to
  different companies. **Reported, not refused**: a group company moving
  somebody between two of its own entities is a real arrangement.
* Work sites moved from Settings into **People**, beside the company
  profile, because that is what they describe.

Covered by `scripts/verify-company-chain.ts` (32 checks), which creates a
company, a site, a department and a person, walks the whole chain in one
SQL join, and asserts both the gap list and the cross-company warning.

## 4d. Features that existed only in the API, 2026-10-13

A whole class of flaw, found by asking one question of every endpoint:
**can anybody reach this from a screen?**

The answer was no more often than anybody would guess. Each of these was
written, commented, permission-checked, audited and in several cases
covered by tests - and unreachable.

| What | Where it is now |
|---|---|
| **Close a month, and reopen it with a reason.** A complete sign-off feature with an audit trail. The hours ledger has always said "close the month once it has been reviewed to make it final" and "cannot be edited unless the month is reopened", and neither act had a button. Figures were either never final or frozen by somebody with a database client | Reports & hours, beside the period picker, because closing is a statement about the period showing |
| **Correct or remove a holiday.** The calendar was append-only: a date typed wrong stayed for good, and the nearest thing to deleting it was leaving it unobserved. The date could be changed, but only as a side effect of observing it with a confirmed date | On the date itself, in the drawer that shows it. A name is a label and may be changed any time; the DATE only while the holiday closes nothing, because the closure may be inside a month already closed |
| **Switch an alert rule off.** Seven rules shipped; a noisy one could only be stopped by editing the database. A rule nobody can turn off is a rule that gets the whole queue ignored | Inbox, folded away under "Change which alerts appear" |
| **Evaluate the rules now.** Its own comment said it was "for the administrator who has just set a threshold and reasonably expects to see whether it caught anything" - who would have waited up to an hour for the scheduler | "Check now", beside the rules |
| **Put people on the shift their policy names.** Assigning a policy offers the move, but assigning a policy somebody already holds is refused - so the ordinary case, noticed days later on the hours ledger, had a working repair endpoint and no way in. The route's own header said "there was no route to fixing it" | A panel on Policies listing who disagrees, with the move dated and per-person. Silent when there is nothing to say |
| **Withdraw a correction request** instead of rejecting it, and **remove a permission request** raised against the wrong person. Both allowed by the API from the day it shipped; the only way out of a mistaken request was a rejection on somebody's record | Next to Approve and Reject on each queue |
| **Reset a forgotten PIN.** The route, the single-use token, the rate limit, the mail template and `/reset-password` all worked. The login page never linked to them, so on the web a forgotten PIN meant telephoning an administrator - and `/reset-password` told people to use the phone app | "Forgot your PIN?" on the login page |
| **Retire a department, team, grade or company.** Every form sent `is_active: true` and nothing ever sent false, so a team created by mistake stayed in every dropdown for good. `include_inactive=1` existed on all four endpoints with nothing asking for it, so even a row retired in the database could not be found again | An "In use" switch on each form, a "Show retired" tick beside the tabs, and a Retired mark wherever one can now appear. Retiring, not deleting: people were placed in these and the placements are dated history |
| **Assign work sites and departments to a company.** Both links were only settable from the other end, so a company reported zero of everything and the fix was on another screen | "Assign sites & departments" on the company's own card, and on the gap card in place of instructions |

### A real bug, found by the same question

The holiday **observance** toggle - the act that actually applies a holiday,
removing the day from required hours - was sending `POST` to a route that
only exports `PUT`, so every tick answered **405**. The page had been
rewritten around a POST helper and the verb was lost; at `HEAD` it was
correct. Nothing else in the suite could see it, because the route is right,
the lib function is right, and they were never introduced to each other.

### Kept honest by

`scripts/verify-reachability.ts`. For every route under `app/api` it works
out the URL, finds the write methods and the `action` discriminators, and
asserts that some screen calls each one. It is deliberately loose about HOW
- the app calls through helpers like `send(url, body, 'PATCH')` and
`method: editing ? 'PATCH' : 'POST'`, and a checker that only understood
`method: 'PATCH'` would cry wolf on both. Paths a browser is not supposed to
call (the phone app's, the scheduler's) are listed by name with the reason,
and a fourth check fails if one of those names stops existing - a list of
exemptions nobody prunes is how the next unreachable feature hides.

**The rule this encodes:** a feature is not finished when its endpoint
works. It is finished when somebody who has not read the code can find it,
and the place to put it is where the thing it acts on is already shown -
not on a settings screen they would have to be told about.
## 4e. The API refusing its own output, 2026-10-13

Saving a company answered:

```
is_active: Invalid input: expected boolean, received number
```

Nothing was wrong with the request. **mysql2 returns `TINYINT(1)` as the
number 1**, every flag in this schema is a `TINYINT(1)` (31 columns), and an
edit form seeds itself from the row it is editing and posts that row back. The
app handed out a 1, was given the same 1 back, and rejected it.

TypeScript cannot see this. `query<Company>` ASSERTS a shape rather than
checking one, so a field declared `boolean` holding a number type-checks all
the way to the schema that finally looks.

### Why only companies

Every other row type the app edits goes through a mapper that normalises what
the driver returns - `toPolicy()` has `bool()` and `num()` helpers;
`listDepartments`, `listTeams` and `listGrades` each map `Boolean(r.is_active)`.
`listCompanies` and `getCompany` were the only reads of an editable row type
that returned `query<T>` straight to the caller. The convention was right and
one function was outside it.

A sweep of every query site in `lib/` and `app/api` found **43** that hand out
a TINYINT where the type promises a boolean. Most are harmless - the value is
truthy-tested and 1 behaves exactly like `true` - and the ones that are not
are the ones a client sends back.

### Fixed on both ends, because one end is not enough

**What goes out:** `listCompanies` and `getCompany` now map `is_active`, like
their siblings always did.

**What comes back:** `lib/zodFields.ts` adds `zBool`, and all **32** flags
across **18** route schemas now use it. The API accepts the 1 it has always
handed out. This half matters most for the **phone app**, which echoes values
it was given, is released on its own schedule, and cannot be fixed by
deploying this.

`zBool` is a union of `true|false|1|0`, deliberately **not**
`z.coerce.boolean()` - that one says true to `"false"`, to `"no"` and to `{}`,
turning a validation error into a silent wrong answer. The union still refuses
`2`, `"true"` and `null`. `zNum` is beside it for the same reason: a `DECIMAL`
column comes back as a string.

### Shapes deliberately left alone

The long-standing phone-facing reads - employees, locations, profile,
attendance, live tracking, rosters, permissions - still return the raw
TINYINT. Changing the JSON a separately-released client parses is a
compatibility decision, not a drive-by tidy-up, and `zBool` means nothing
breaks either way. They are listed **by file, with the reason**, in
`scripts/verify-field-shapes.ts`, and a check fails if one of those files
stops existing - a list of exemptions nobody prunes is how the next one hides.

### Kept honest by

`scripts/verify-field-shapes.ts` (18 checks): that `zBool` reads 1 and 0 and
still refuses nonsense, that no `z.boolean()` is left in any route schema,
that the four row types the organisation screen edits carry real booleans,
and - last - **the exact request that failed**, posted to the real handler,
both as the form sends it and as a literal `is_active: 1`, with the stored
value checked afterwards so a 0 retires a company rather than being read as
true.
## 4f. Where to start, 2026-10-13

An administrator handed an empty workspace cannot tell from the menu what to
do first, because the menu is organised by subject and the work has an
**order**. An employee cannot be created without a department and a work site.
A policy is useless without a shift to name. The hours ledger stays empty
until all of it exists. None of that is discoverable by looking.

### A flow, not a tour

Three things make the difference, and all three are load-bearing:

1. **It navigates.** Each step knows its page. If you are not there, the guide
   takes you there, then WAITS for the control to exist - a page that has just
   been pushed has not rendered, and a tour that measures too early points at
   the corner of the screen. `?tab=` was added to Organisation so a step can
   land on the Company tab, and the tab now follows the URL rather than merely
   starting from it.

2. **You do the real thing.** The spotlight is a hole, not a picture: the
   overlay is `pointer-events: none` everywhere except its own card, so the
   highlighted button is the actual button and opens the actual form. Nothing
   is simulated, so nothing can be marked done without having happened.

3. **It watches the data, not the clicks.** While a step is open the guide
   re-asks the server every few seconds whether the thing exists. When the
   company is really saved, the step ticks and it moves on by itself.

### Why there is no progress table

Because a step is done when **the thing exists**. `setupState()` counts
companies, sites, departments, shifts, policies and people, and that is the
whole state. The consequences are the reason for the design:

* **It cannot lie.** A guide that ticks a step because a tooltip was dismissed
  tells somebody they have a shift when they do not.
* **It resumes anywhere.** Close the browser, change machine, hand the job to
  a colleague halfway: it picks up from the first thing still missing.
* **No migration, no cleanup, nothing to keep in step.** There is no stored
  progress that can contradict the workspace.
* **It stops by itself.** Once the essentials exist nothing opens unasked, and
  the button stays for whoever wants to see what is left.

### The order

| # | Step | Why it is here |
|---|---|---|
| 1 | Company | Everything belongs to one - sites, departments, and through them people |
| 2 | Work site | Where people clock in; nobody can be rostered until one exists |
| 3 | Department | The employee form asks for one |
| 4 | Shift | The hours a day is measured against |
| 5 | Policy | The rules; it names the shift from step 4 as its default |
| 6 | People | Last, because it needs all five above |

Then, optional and never counted against the progress bar: teams, putting
people on their policy's shift, the holidays you close for, and who can see
what. Real work, but nothing is broken while they are undone, so they are not
allowed to make a finished workspace look unfinished.

Steps somebody has no permission for are **removed**, not shown locked: a
manager with `employee.manage` is told to add their people and not told that
creating the company is their job and then refused at the door.


### The other person: joining a workspace that already works

The first version had one list and one button, and the button read **"Setup
complete"**. For whoever built the workspace that is correct and final. For
somebody handed a login to a company that was set up three years ago it is a
dead end - nothing is missing, so the setup list is six green ticks that
teach them nothing, and there was no way to start anything over.

So there are now two walks behind one control:

| | **Setup** | **Tour** |
|---|---|---|
| For | whoever is building the workspace | whoever has just been given a login |
| Opens at | the first thing missing | the beginning, always |
| Steps are | things to create | places, and what each is for |
| Advances | by itself, when the thing really exists | only when you press Next |
| Progress bar | yes, over the six essentials | none - there is nothing to finish |

The six tour stops are the rail itself: Today, the inbox, People, Time,
Insight, Settings - what each section is for and when you would open it. They
are anchored with `data-tour={`nav-${section.key}`}` on the rail entry, so a
new section is anchored by existing rather than by being added to a second
list. The tour then continues into the setup steps, so a newcomer also sees
where each piece is changed - after the screens they will use daily, not
before them.

The button opens a **menu**: carry on setting up (when something is left),
take the tour from the start (always), and walk the setup again (when nothing
is left). **Start over** sits in the card too, so somebody half way through
does not have to find the menu again. The label reads **Guide** rather than
"Setup complete" once the essentials exist - a status nobody presses, versus
a thing you can open.
### Kept honest by

`scripts/verify-setup-guide.ts` (45 checks): every step lands on a page that
exists and points at a `data-tour` control that appears **exactly once** on
it; the essentials are in dependency order; the counts are the real ones; one
employee (the administrator themselves) does not count as "your people"; a
people-only manager gets a filtered list; and the overlay still lets clicks
through - without that last one the guide becomes a wall that cannot be used,
while still looking perfectly correct in a screenshot. It also checks the tour: that every
stop points at a section of the rail that exists, that the tour never
advances by itself, and that there is a way in once setup is complete.
## 5. Order of work

Each phase ships on its own and arrives inert.

| Phase | What | Size | Why here |
|---|---|---|---|
| **A** | **Done 2026-10-12.** Nav shell, 6 entries (Pay waits for C), tabs as real routes so no redirects were needed, command palette over pages and people, permission-filtered rail with a legacy fallback, Inbox consolidating four queues with a waiting age | L | The live complaint, and payroll adds five more pages — doing this second makes it worse |
| **B** | **Done 2026-10-12.** Seven rules, catalogue with per-rule on/off, four nullable policy thresholds, inbox integration with inline acknowledge, Today strip, daily digest behind `ALERT_DIGEST`, employee self-notice on their own dashboard | M | Needs the Inbox from A to land in |
| **C** | **REMOVED 2026-10-12.** Built, then removed on instruction - `employee_salary` with dated revisions, `statutory_settings` + `pt_slabs` seeded, Pay > Salary and Statutory tabs, the derivation and a worked example. Nothing computes a payslip | M | Data before arithmetic |
| **D** | **REMOVED 2026-10-12.** Built, then removed on instruction - Compute, review with every figure openable, approve behind its own permission, immutable once approved, payslip PDF, register xlsx, bank CSV with a validation block. The LOP divisor is a setting rather than a guess | L | The replacement for the Excel sheet |
| **E1** | **REMOVED 2026-10-12.** Built, then removed on instruction - Employee payslip self-service, one shared payslip builder, PF ECR / ESI / PT filing files each naming who they had to leave out, UAN and ESIC number on the employee record | M | The outputs of a month, which is what makes D usable |
| **E2a** | **REMOVED 2026-10-12.** Built, then removed on instruction - Advances with recovery schedules, capped at what a month can pay, booked on approval and reversed on cancellation | M | The one part of a run that still needed remembering every month |
| **E2b** | **REMOVED 2026-10-12.** Built, then removed on instruction - Full and final with every component computed, shown and overridable; income tax with slabs as data, declarations, review, and a monthly deduction the run reads | L | Built before the reconciliation, on instruction - the concern is recorded above |

Every migration additive and guarded, pure ASCII, non-idempotent nothing — the
mobile app shares this database and reads these tables.

## 6. Risks

- **Nav churn.** Muscle memory is real. Mitigated by keeping every old URL alive
  and by the command palette, but the first week will feel unfamiliar.
- **Alert fatigue** is the failure mode that kills this feature. Hence: inert
  defaults, suppression rules, one row per period, auto-resolve, one digest.
- **Payroll correctness.** The derived PF basic is a convention, not a law. It
  needs confirming against what is actually being filed today before phase D is
  approved by anybody.
- **The first run must be reconciled against the Excel sheet** for one month,
  side by side, before it is used to pay anybody. Phase D is not done until that
  comparison has been made and the differences explained.

## 7. Open questions

1. Which **state** for professional tax, and is PT filed monthly or
   half-yearly? (Decides the slab rows and the due months.)
2. Is PF **capped at the ceiling** for everybody, or paid on full basic for some?
3. What does the Excel sheet currently use for the **LOP divisor** — working days
   or calendar days? Whatever it is, the first run has to match it to reconcile.
4. Are there **advances or salary loans** outstanding right now that need
   carrying in, or does phase E start from zero?

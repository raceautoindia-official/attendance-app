# Platform plan — org structure, RBAC, onboarding, navigation

Written 2026-10-10, before any code. Nothing here is committed or deployed.

Ten changes were asked for. They are not independent: four of them need an org
structure that does not exist yet, and one of them needs data that is currently
wrong. This orders them so each phase stands on the one before it, and says
what I found that changes the shape of the work.

---

## 1. What is actually there now

Checked first, because three of the requests are already half-built.

| Asked for | What exists | The gap |
|---|---|---|
| Company profile | Nothing. No `companies` table. | Build it. Also the natural home for the statutory identifiers currently nowhere. |
| Departments, L1/L2, teams | `employees.department` — a **free-text string**. `employees.manager_id`. | No table, no hierarchy, no teams. **And the free-text field is already corrupted — see §2.** |
| Role-based access | Three hard-coded roles: `super_admin`, `manager`, `employee`. Page gating by role in `proxy.ts`. | No per-permission control, no scoping to "my team", no admin UI. **And no manager-role user exists — see §2.** |
| HR onboarding | Nothing. | Build it. |
| Holidays | `holiday_calendar`, `holiday_observances`, bundled `data/holidays/IN-2026.json` and `IN-2027.json`. 24 rows live. | India only, two years, no country/city concept. |
| No modals | `<Modal>` used on **9 pages** plus `PermissionHoursCard`. | Replace with drawers / in-page views. |
| Grouped, searchable nav | Flat list of ~15 items in `Sidebar.tsx`. | Group and make searchable. |
| Step-by-step creation | Single long forms. | Wizards. |
| Filters everywhere | Some pages have them, inconsistently. | A shared filter pattern. |

---

## 2. Two things that change the plan

### The department field is already wrong

Live values, all 16 active employees:

```
(none)        7
ADMIN001      3      <- an employee ID
7305408577    2      <- a phone number
Wash Plant    5
Sales         1      <- trailing space
```

Five of sixteen people are filed under something that is not a department, and
seven under nothing. A free-text column did what free-text columns do.

This matters because **the migration cannot simply copy the old values into a
new table**. It has to create real departments, map the salvageable values
(`Wash Plant`, `Sales`), and leave the rest explicitly unassigned for an
administrator to place — not silently invent a department called `ADMIN001`.
The old column stays, untouched and unread, because the mobile app shares this
database.

### Nobody has a manager

```
employee      16 active,  0 with a manager
super_admin    1 active
manager        0 users
```

So "a manager sees only their team" currently describes an empty set. The
permission model is worth building, but it is inert until the org structure is
populated — which is why §4 comes before §5, and why the onboarding flow (§6)
has to be the thing that keeps it populated. A hierarchy nobody is obliged to
fill in goes stale within a quarter.

---

## 3. Phase 0 — the UI foundations everything else is built from

Doing this first means the nine features that follow are built the new way
once, rather than built the old way and converted.

**A `Drawer` component.** Side panel, not a centred box: it keeps the list
behind it visible, which is the stated reason for dropping modals. Needs real
focus management — focus trapped while open, returned to the trigger on close,
Escape to dismiss, `aria-modal`, body scroll locked. A drawer without these is
worse than the modal it replaced, not better.

**A grouped, searchable sidebar.** Fifteen flat items become five groups:

```
Daily        Overview · Attendance · Live Tracking · Permissions
People       Employees · Onboarding · Departments & Teams · Documents
Time         Schedules · Holidays · Leaves · Policies
Insight      Reports & Hours · Performance · Audit Log
Setup        Company · Locations · Roles & Access · Notifications
```

With a search box that filters across all of them, so nothing has to be hunted
for. Groups remember whether they were open.

**One filter pattern.** A `FilterBar` every list page uses, so the controls sit
in the same place, behave the same way, and show what is currently applied.
Consistency is most of what makes filters feel present rather than hidden.

**A `Wizard` shell.** Stepper, per-step validation, back without losing input,
and a clear "you can change all of this later" so step one is not frightening.

---

## 4. Phase 1 — company, departments, teams

### `companies`
Legal name, trading name, registration number, PAN, TAN, GSTIN, PF and ESI
establishment codes, registered address, financial year start, default
timezone, logo. One row expected; the table does not assume it.

### `departments` — a tree, not a list

`id, company_id, parent_id, name, code, level, head_employee_id, is_active`

`parent_id` makes it a tree of any depth. **L1/L2 is then a property of depth,
not a separate concept** — L1 is a department with no parent, L2 is its child.
This is the one design decision I want confirmed, because "L1, L2" could
equally mean job grades (L1 engineer, L2 engineer), which is a different table
entirely and would sit on the employee, not the department. §9 asks.

### `teams`
`id, department_id, name, code, lead_employee_id, is_active` — a team belongs
to one department and has a lead.

### `employee_org_assignments`
`employee_id, department_id, team_id, reports_to_employee_id, effective_from,
effective_to`

Dated, like `employee_schedules` and `employee_policies`, for the same reason:
somebody who moves department in March must have January reported under the old
one. Every org query then resolves "as at a date", and a reorganisation does
not rewrite history.

**A cycle check is not optional.** Both the department tree and the reporting
line need one — a reporting loop makes "everyone under this manager" recurse
forever, and it is reachable with two ordinary edits.

---

## 5. Phase 2 — roles and access

### `roles`, `permissions`, `role_permissions`, `employee_roles`

Permissions named by what they let somebody do, not by page:
`attendance.view`, `attendance.edit`, `employee.create`, `payroll.export`,
`policy.manage`, `documents.view_identity`, and so on.

### Scope is the part that matters

A permission alone is not enough. "A manager may view attendance" has to mean
*their* team's attendance. So each grant carries a scope:

| Scope | Means |
|---|---|
| `self` | Only their own records |
| `team` | The team they lead |
| `department` | Their department and everything below it in the tree |
| `all` | Everybody |

`department` is why the tree exists: resolving it walks downward from their
node. This is the single piece of logic most likely to leak data if it is
wrong, so it gets its own test suite before any page relies on it.

### Enforcement in one place

The scope filter is applied **in the query layer**, not in the page. A page
that forgets to filter is a page that shows a manager somebody else's salary
band. Every list endpoint takes the caller's scope and narrows its `WHERE`
before it runs.

`super_admin` keeps a hard-coded bypass. A permission system that can lock out
its own administrator is a permission system that will.

### Migration safety
Existing roles map to equivalent grants on day one, so **nothing changes for
anybody** until an administrator edits a role. Same discipline as the policy
system: ship it inert.

---

## 6. Phase 3 — HR onboarding

### `onboarding_templates`, `onboarding_tasks`, `employee_onboarding`

A template is a named checklist — tasks with an owner role, a due offset in
days from joining, and whether they block. Creating an employee instantiates
the template into real dated tasks.

Tasks as asked for, plus the ones that get forgotten: ID card issued, training
completed, attendance app installed and first clock-in seen, documents
collected, email and system accounts created, asset issued (laptop, SIM, keys),
bank details captured, statutory enrolment (PF/ESI/UAN), emergency contact,
policy acknowledged, probation review date set, buddy assigned.

**The employee sees their own list.** A checklist only HR can see is a checklist
HR chases by email.

**Offboarding is the same table.** See §8 — it is the thing most often left
until somebody has already left with a laptop.

---

## 7. Phase 4 — holidays

### The data source is the real decision

"Standard holidays for all countries, every year" cannot come from bundled JSON
files — that is 200 countries × every year, maintained by hand.

**Recommendation: the `date-holidays` package.** It computes from rules rather
than shipping a list, so it answers any year including future ones, covers
~200 countries with state and region subdivisions, needs no API key, and works
offline. An external API (Calendarific, Nager.Date) means a network dependency
on a page that must work, a rate limit, and a key to rotate.

### Schema
`holiday_calendar` gains `country_code` and `region_code`. `locations` gains
`country_code` and `city` — it has `state_code` but no country, so "filter by
country and city" has nothing to filter on today.

### The page
Month and year calendar grid rather than a table, country and region pickers,
and a clear separation between **candidates** (imported, inert) and
**observed** (this company actually closes). That distinction already exists in
`holiday_observances` and is the most useful thing about the current design —
it survives the rewrite.

---

## 8. What was not asked for and probably should be

Ordered by how much trouble their absence causes.

1. **Offboarding.** The mirror of onboarding: assets returned, accounts
   revoked, access removed, final attendance settled, exit interview. The cost
   of not having it is an ex-employee who can still sign in. Same tables as §6,
   so it is nearly free once onboarding exists.

2. **Probation tracking.** Policies already carry `probation_months` and
   nothing uses it. A joining date plus that number is a confirmation date, and
   a confirmation date nobody is reminded of is a probation that lapses
   silently into permanence.

3. **Document expiry.** Documents are stored with no expiry. Contracts, visas,
   and certifications lapse. One nullable `expires_on` plus a dashboard queue
   covers it.

4. **Who may see identity numbers.** `employees` holds PAN and Aadhaar in
   plain columns. Under RBAC these need their own permission, separate from
   "view employee" — most managers need the person, not their Aadhaar number.
   Worth doing *with* §5, not after.

5. **Bulk import for the org structure.** Building a department tree and
   assigning 16 people through a UI is tolerable; doing it for 200 is not.

6. **Reminders.** Onboarding tasks, probation dates and document expiries all
   need a nudge. The end-of-day scheduler already exists and can carry them.

7. **An org chart view.** A tree people can see is the fastest way to find the
   errors in it.

8. **Audit on access changes.** `audit_log` exists. Role and permission changes
   must be in it — "who gave them that" is asked only after something has gone
   wrong.

9. **Employee self-service profile.** Let people correct their own phone,
   address and emergency contact, with changes queued for approval. Removes a
   steady stream of small HR requests.

---

## 9. Decisions — answered 2026-10-10

1. **L1/L2 is BOTH.** Departments nest as a tree *and* people carry a job
   grade. These are deliberately separate tables: a grade travels with the
   person when they move department, and a department keeps its shape when
   somebody is promoted. Folding one into the other would make a promotion
   look like a transfer.

2. **Holidays come from `date-holidays`.** Rules, not lists, so any year
   answers including future ones. No API key, no network dependency on a page
   that has to work.

3. **Offboarding ships with onboarding.** Same tables, extra templates and a
   direction flag.

4. **The corrupted departments** (`ADMIN001`, `7305408577` — five people) are
   left explicitly unassigned for an administrator to place. Inventing a
   department named after a phone number would bury the problem rather than
   surface it, and the migration reports exactly who needs placing.
## 10. Order of work

| Phase | Contents | Why here |
|---|---|---|
| **0** | Drawer, grouped searchable sidebar, FilterBar, Wizard shell | Everything after is built the new way once |
| **1** | Company profile, departments tree, teams, dated assignments, org chart | Four later phases need it |
| **2** | Roles, permissions, scope resolution, admin UI | Needs the tree to resolve `department` scope |
| **3** | Onboarding + offboarding, employee-visible checklist | Needs roles to assign task owners |
| **4** | Holiday revamp, country/region, calendar UI | Independent — can move earlier if preferred |
| **5** | Modal sweep, wizards on every create flow, filters everywhere | Mechanical once Phase 0 exists |

Each phase ends green: full suite, clean build, routes audited. Nothing is
pushed.

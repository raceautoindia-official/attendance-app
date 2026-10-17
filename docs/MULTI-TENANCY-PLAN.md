# Multi-tenancy — turning the app into a platform

Written 2026-10-10, before any code. Nothing here is committed or deployed.

This is not a feature. It changes what the product *is*: from one company's
internal tool into a service several unrelated companies sign up to, operated
by you as the provider. Almost every decision below follows from one fact about
the data, stated in §3.

---

> **PARKED 2026-10-10.** Feature work comes first; tenancy resumes after.
>
> What is already built is inert: `MULTI_TENANT` defaults off, so the app runs
> single-tenant exactly as before and all 847 checks pass against it. The
> registry schema, the async-context layer and the pool manager are in the
> tree, unused, with their own suite.
>
> **The one rule that keeps the retrofit cheap: all database access keeps going
> through `query()` / `queryOne()` in `lib/db.ts`.** The entire plan rests on
> that one file being the only place a connection is opened. A feature that
> creates its own pool, or imports `mysql2` directly, puts itself outside the
> boundary and will have to be found and fixed later - which is exactly the
> audit this design exists to avoid.

## 1. The three levels

```
PROVIDER  — you. One console, above every tenant.
  |
  +-- TENANT  — a customer organisation. A sealed environment.
        |         Sees nothing of any other tenant and cannot learn one exists.
        |
        +-- COMPANY  — a corporate profile inside that tenant. Several allowed:
              |        group structures, subsidiaries, separate legal entities.
              |
              +-- DEPARTMENT (tree) -> TEAM -> EMPLOYEE
```

The `companies` table built yesterday already fits here unchanged: it is the
**corporate profile** level, and it was deliberately written as a table that
holds many rows rather than a settings blob. The department tree, grades, teams
and assignments all sit inside a tenant and need no rework.

What is missing is everything above `companies`.

---

## 2. The numbers that decide the architecture

Measured, not estimated:

| | |
|---|---|
| Raw SQL call sites | **130** |
| Files containing them | **50** |
| Files that open a database connection | **1** (`lib/db.ts`) |
| Background jobs running outside any request | **3** (`markAbsent`, `closeSessions`, `liveTrackingMonitor`) |

That last-but-one row is the important one. Every query in the application
already funnels through `query()`, `queryOne()` and the exported `pool`. The
boundary can therefore be placed in one file rather than in a hundred and
thirty.

---

## 3. The fact everything follows from

This database holds, for every employee of every customer:

- **Aadhaar and PAN numbers** (`employees.aadhaar_number`, `pan_number`)
- **Bank account number, IFSC, account name**
- **Biometric credentials** (`passkeys`, `webauthn_challenges`)
- **Continuous GPS location** (`live_tracking_points`)
- **Photographs** taken at login (`login_photo_proofs`)
- **Identity documents** (`employee_documents` - Aadhaar cards, PAN cards)

A cross-tenant leak here is not an embarrassing bug. It is one customer's staff
identity documents disclosed to another customer, and under the DPDP Act it is
a reportable breach.

**Hold that next to the number 130.**

---

## 4. The isolation decision

### Option A - shared tables, `tenant_id` column (row-level)

Every table gains `tenant_id`; every query filters on it.

*For:* one migration serves everyone; trivial cross-tenant reporting; smallest
operational change; one connection pool.

*Against:* the boundary is a `WHERE` clause repeated 130 times and in every
line written from now on. Isolation depends on nobody ever forgetting - not
today, and not in two years when somebody adds a feature in a hurry. A single
omission in a `JOIN` silently returns another company's rows. Per-tenant
export, restore and deletion all become bespoke queries, and "delete my data"
is a legal obligation, not a feature request.

### Option B - a database per tenant (recommended)

One MySQL database per tenant on the same server. A registry database maps
tenant to database name. The request resolves the tenant and uses that pool.

*For:* **the boundary is the connection.** A forgotten `WHERE` can only ever
show a tenant its own data, because the other tenants' rows are not reachable
from that connection. The 130 call sites do not change - only `lib/db.ts`.
Backup, restore, export and deletion of one customer become a `mysqldump` and
a `DROP DATABASE`. A large tenant can later be moved to its own server with no
code change. And it is the honest version of the promise you are selling: "your
data is in your own database" is verifiable; "we filter by a column" is a
request to trust us.

*Against:* migrations must run once per tenant, and the current process is
hand-run and - as `AGENTS.md` says - mostly not idempotent. Pools multiply.
Cross-tenant reporting needs its own path.

### Recommendation: **Option B.**

The deciding argument is not elegance. It is that under Option A the only thing
standing between Company A and Company B's employees' Aadhaar numbers is a
clause that a hundred and thirty existing places and every future place must
remember. That is not a defensible posture for this data, and it is not a
promise worth making to a customer.

The two real objections have answers, in §6 and §7. Neither is free, and both
are work I would rather do once than explain to a customer later.

---

## 5. How a request finds its tenant

### Resolution order

1. **Subdomain** - `acme.worklens.raceinnovations.in`. Preferred: it is visible,
   bookmarkable, and makes "which company am I in" unambiguous on screen.
2. **The session.** After sign-in the tenant is in the JWT, so every later
   request carries it and a stolen token cannot be replayed into another tenant.
3. **Login** has no session yet, so it resolves by subdomain, or by the email
   domain, or by an explicit tenant code on a shared login page.

The token gains `tid`. **A token without one is rejected** - see §8.

### Carrying it to `query()`

`query()` is called from library functions many layers below the request, which
have no parameter to pass a tenant through. Threading one through 130 call
sites would be the same mistake as Option A, in a different costume.

Instead, **`AsyncLocalStorage`**: the route resolves the tenant once and runs
the handler inside a context. `lib/db.ts` reads the current tenant from that
context and returns its pool. Nothing else in the application changes, and a
new feature is tenant-safe by default rather than by discipline.

```
request -> resolve tenant -> ALS.run({ tenant }, handler)
                                     |
                              query() -> poolFor(ALS.get().tenant)
```

### Fail closed, always

If there is no tenant in context, `query()` **throws**. It does not fall back
to a default database, and it does not return an empty result.

A fallback is how every multi-tenant breach happens: some path loses its
context, quietly reads tenant one, and nobody notices until a customer sees a
name they do not employ. A thrown error is a page that breaks loudly in
staging. That trade is not close.

---

## 6. Migrations across a fleet

Today: 31 files, hand-run, mostly not idempotent. Multiplied by N tenants, that
becomes a near-certainty of a half-migrated fleet.

So this has to change before the second tenant exists:

- **`schema_migrations` in every tenant database** - filename, checksum, when
  applied, how long it took.
- **A runner** that walks the registry, applies what a tenant is missing in
  order, and stops the moment one fails. A fleet half-migrated to a *known*
  point is recoverable; one migrated in an unknown order is not.
- **A template database** so a new tenant is created from a current schema
  rather than by replaying 31 migrations.
- **Checksums**, because a migration edited after it was applied somewhere is
  the quiet way a fleet diverges.
- **`check-status.sql` runs per tenant** and reports a fleet-wide table.

This is the real cost of Option B, and it is worth saying plainly: it is a
week's work that buys a boundary that cannot be forgotten.

---

## 7. Connection pools

A measured constraint, not a hypothetical: this MySQL has
**`max_connections = 151`**, and the app's pool is currently 10. Fifteen tenants
at ten connections each would exhaust the server.

- Per-tenant pool of **2-3**, not 10. A tenant is a few dozen users, not a few
  thousand.
- **LRU eviction** of idle tenant pools, with a cap on how many stay open.
- The registry pool is separate and small.
- Raise `max_connections` deliberately, with the arithmetic written down.

Twenty active tenants x 3 = 60 connections. Comfortable. The number to watch is
*concurrently active* tenants, not registered ones.

---

## 8. Security rules that are not negotiable

1. **No tenant in context - throw.** Never a default.
2. **The tenant lives in the signed token**, never in a header or query
   parameter a client can set. `?tenant=42` would be an authorisation bypass
   with a friendly name.
3. **Provider staff do not get silent access.** Support access to a tenant is
   explicit, time-boxed, written to that tenant's audit log, and visible to the
   tenant. "Our support team may enter your environment and you will see when
   they did" is sellable; silent access is not.
4. **Cross-tenant queries exist in exactly one module**, used only by the
   provider console, and are read-only aggregates - counts and health, never
   employee rows.
5. **Every new table is created inside a tenant database by default.** The
   registry is the exception and is listed explicitly.
6. **A test suite that tries to leak** - signs in as tenant A, asks for tenant
   B's data through every list endpoint, and fails if a single row comes back.
   Written before the second tenant exists, not after.

---

## 9. The provider console

Separate surface, separate route group, separate permission - not an extra role
inside a tenant. The two must not share a navigation tree, because the moment
they do, somebody adds a page that reads across tenants by accident.

- Tenants: create, configure, suspend, resume, delete.
- Provisioning: create the database, apply the template, seed the first
  administrator, send the invitation.
- Health: schema version per tenant, last activity, employee counts, failed
  jobs. Counts and status, never rows.
- Plan limits: employee cap, feature flags, storage.
- Support access: request, approve, time-box, log.
- Billing hooks, if that becomes relevant.

---

## 10. The existing data

The current database becomes **tenant one** and keeps its name,
`attendance_db`. Nothing is copied, nothing is renamed, nobody is migrated. The
registry simply records that tenant one lives there.

That matters because the mobile app shares this database. Tenant one is exactly
where it was; the second tenant is a second database that the mobile app will
never see unless it is told to.

**The mobile app needs a decision of its own** (§12). Until it is made, tenant
one behaves precisely as today.

---

## 11. What this does to the phases already planned

The org work stands; it simply moves inside a tenant.

| Phase | Was | Now |
|---|---|---|
| **0** | Drawer, sidebar, FilterBar, Wizard | Unchanged. **Done.** |
| **T1** | - | **Registry, tenant resolution, ALS, fail-closed `query()`, migration runner** |
| **T2** | - | **Provider console, provisioning, tenant lifecycle** |
| **T3** | - | **Leak test suite** - before tenant two exists |
| **1** | Company, departments, grades, teams | Unchanged, inside a tenant. Schema **done**, UI next |
| **2** | Roles and scope | Scope gains no tenant level - the connection already did that |
| **3** | Onboarding and offboarding | Unchanged |
| **4** | Holidays | Unchanged. `date-holidays` is per-tenant configuration |
| **5** | Modal sweep, wizards, filters | Unchanged |

**T1 to T3 come before any further feature work.** Retrofitting a tenant
boundary under a larger application is strictly harder than placing it now,
and every feature built before it is a feature that must then be audited for
leaks.

---

## 12. Decisions - answered 2026-10-10

**1. Database per tenant.** Confirmed, with the condition that existing data
is not modified. That is already how it works: tenant one *is* `attendance_db`,
under its current name, with nothing copied, renamed or moved. The registry
records where it lives and otherwise leaves it alone.

**2. No subdomain and no path prefix - resolved from the account, like Zoho.**
One URL for everybody. Signing in determines which organisation you belong to,
and somebody in more than one picks between them.

This has a consequence worth stating before it bites: **the login lookup is the
one thing that cannot happen inside a tenant database.** "Which tenant does
this person belong to" has to be answerable before a tenant is chosen, so the
registry carries a small directory - login identifier to tenant - and nothing
else. No credentials. The PIN hash, the passkeys and the employee record all
stay inside the tenant.

And a sharper problem: **`emp_id` is not unique across tenants.** Two companies
will both have an `ADMIN001`. Today the mobile app signs in with `emp_id` plus
a PIN, so the resolution rule is:

| Situation | What happens |
|---|---|
| The client sent a tenant code | Use it. Unambiguous. |
| No code, and the `emp_id` exists in exactly one tenant | Sign in there. **This is every request from today's mobile app, so it keeps working untouched.** |
| No code, and the `emp_id` exists in several | Refuse and ask which organisation. The web shows a picker. |

Every tenant therefore gets a short **tenant code** at creation, and a later
mobile build sends it as `x-tenant-code`. Until then nothing breaks, because
tenant one is the only tenant and no `emp_id` collides with anything.

**3. The mobile app calls the API.** I checked rather than assumed.
`lib/deviceBinding.ts` reads `x-device-id` and `x-device-platform` from request
headers, and its own comment describes "the build already on employees' phones"
sending headers to clock in. It is an HTTP client, not a database client.

**This removes the long pole.** Database-per-tenant needs no change to the
mobile app at all: tenant one keeps its database and its behaviour, and the
app continues to resolve to it by the rule above.

Still open, and not blocking T1:

- **Provider support access** - may your staff enter a tenant environment?
  Recommended: yes, time-boxed, logged, visible to the customer.
- **Self-serve signup** or provisioning by hand? By hand is right until the
  tenth customer; self-serve needs verification, trials and abuse limits.
## 13. What would change my mind about Option B

Worth writing down, so the decision can be revisited honestly rather than
defended:

- **Hundreds of small tenants.** The pool arithmetic stops working somewhere
  around fifty concurrently active ones. At that scale the answer is sharding
  tenants across servers - still database-per-tenant, just more of them - or
  accepting row-level with a query layer that cannot be bypassed.
- **Heavy cross-tenant analytics as a product feature.** Not counts and health,
  but real reporting across customers. That wants one warehouse, fed from the
  tenant databases.
- **A hosting constraint** that makes creating databases impossible.

None of these apply today.

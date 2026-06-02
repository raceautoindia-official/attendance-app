# Attendance App — Developer Documentation

> **Framework:** Next.js 16.2.1 (Turbopack, App Router)
> **Language:** TypeScript 5
> **Database:** MySQL 8
> **Auth:** PIN + WebAuthn (Passkeys)

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Directory Structure](#2-directory-structure)
3. [Authentication Flow](#3-authentication-flow)
4. [Database Schema](#4-database-schema)
5. [API Reference](#5-api-reference)
6. [Frontend Architecture](#6-frontend-architecture)
7. [Key Libraries & Patterns](#7-key-libraries--patterns)
8. [Next.js 16 Migration Notes](#8-nextjs-16-migration-notes)
9. [Local Development](#9-local-development)
10. [Production Deployment](#10-production-deployment)
11. [Known Issues & Gotchas](#11-known-issues--gotchas)

---

## 1. Project Overview

A production-ready workforce attendance management system. Key capabilities:

| Feature | Description |
|---------|-------------|
| **Two-factor login** | PIN verifies identity, WebAuthn (passkey) verifies device |
| **Geofence clock-in/out** | GPS coordinates checked against configurable work-location radius |
| **Shift management** | Fixed, flexible, and rotating shift types |
| **Leave & holiday tracking** | Per-employee or company-wide |
| **Admin dashboard** | Live stats, attendance editing, employee CRUD |
| **Report exports** | CSV and PDF with IST-formatted timestamps |
| **Dark mode** | Tailwind `darkMode: 'class'` via next-themes |
| **Role-based access** | `employee`, `manager`, `super_admin` |

---

## 2. Directory Structure

```
attendance-app/
├── app/
│   ├── (auth)/                  # Route group — unauthenticated pages
│   │   ├── login/page.tsx       # PIN + passkey login form
│   │   └── register-passkey/page.tsx  # WebAuthn enrolment
│   ├── (employee)/              # Route group — employee-facing pages
│   │   ├── dashboard/page.tsx   # Live clock, clock-in/out, 7-day history
│   │   └── loading.tsx          # Skeleton for employee pages
│   ├── (admin)/                 # Route group — manager/super_admin pages
│   │   ├── overview/page.tsx    # KPI cards + live attendance table
│   │   ├── employees/page.tsx   # Employee CRUD
│   │   ├── attendance/page.tsx  # Edit attendance records
│   │   ├── schedules/page.tsx   # Shift CRUD + schedule assignment
│   │   ├── locations/page.tsx   # Location CRUD
│   │   ├── leaves/page.tsx      # Leave & holiday management
│   │   ├── reports/page.tsx     # Summary table + CSV/PDF download
│   │   ├── layout.tsx           # Sidebar + topbar layout
│   │   └── loading.tsx          # Skeleton for admin pages
│   ├── api/                     # Next.js Route Handlers
│   │   ├── auth/
│   │   │   ├── login/route.ts
│   │   │   ├── logout/route.ts
│   │   │   ├── refresh/route.ts
│   │   │   └── webauthn/
│   │   │       ├── authenticate/route.ts
│   │   │       ├── authenticate-verify/route.ts
│   │   │       ├── register/route.ts
│   │   │       └── register-verify/route.ts
│   │   ├── attendance/
│   │   │   ├── route.ts         # GET list / admin edit
│   │   │   ├── [id]/route.ts    # PUT attendance record
│   │   │   ├── clock-in/route.ts
│   │   │   ├── clock-out/route.ts
│   │   │   └── today/route.ts
│   │   ├── employees/
│   │   │   ├── route.ts         # GET list, POST create
│   │   │   ├── [id]/route.ts    # GET, PUT, DELETE
│   │   │   ├── [id]/exemption/route.ts
│   │   │   └── [id]/passkeys/route.ts
│   │   ├── schedules/
│   │   │   ├── route.ts         # GET shifts, POST create shift
│   │   │   ├── [id]/route.ts    # DELETE shift
│   │   │   └── assign/route.ts  # POST assign schedule
│   │   ├── locations/
│   │   │   ├── route.ts
│   │   │   └── [id]/route.ts
│   │   ├── leaves/
│   │   │   ├── route.ts         # GET list, POST create
│   │   │   └── [id]/route.ts    # DELETE
│   │   ├── reports/
│   │   │   ├── summary/route.ts
│   │   │   ├── csv/route.ts
│   │   │   └── pdf/route.ts
│   │   ├── audit-log/route.ts
│   │   └── cron/mark-absent/route.ts
│   ├── providers.tsx            # QueryClientProvider + ThemeProvider
│   ├── layout.tsx               # Root layout — loads providers
│   ├── globals.css              # Tailwind v4 @import entry point
│   ├── global-error.tsx         # Next.js global error boundary (has own html/body)
│   ├── not-found.tsx            # 404 page
│   └── loading.tsx              # Global loading skeleton
├── components/
│   ├── ui/
│   │   ├── Badge.tsx
│   │   ├── Button.tsx
│   │   ├── Card.tsx
│   │   ├── Input.tsx
│   │   ├── Modal.tsx
│   │   ├── Pagination.tsx
│   │   ├── Spinner.tsx
│   │   ├── Table.tsx
│   │   └── ThemeToggle.tsx
│   └── ErrorBoundary.tsx        # React class component error boundary
├── lib/
│   ├── api.ts                   # apiFetch helper — auto-logout on 401
│   ├── auth.ts                  # JWT sign/verify, bcrypt, cookie helpers
│   ├── cn.ts                    # clsx className utility
│   ├── constants.ts             # TIMEZONE, LOGIN_MAX_ATTEMPTS, etc.
│   ├── db.ts                    # mysql2/promise pool + graceful shutdown
│   ├── env.ts                   # Startup env validation (skips during build)
│   ├── ratelimit.ts             # In-memory rate limiter (per-process)
│   ├── types.ts                 # Shared TypeScript interfaces
│   └── user.ts                  # localStorage user session helpers
├── database/
│   ├── schema.sql               # All table DDL
│   └── seed.sql                 # Default users, location, shift, exemptions
├── nginx/
│   └── attendance.conf          # Production Nginx config
├── proxy.ts                     # Next.js 16 proxy (replaces middleware.ts)
├── next.config.ts               # Security headers, CORS, turbopack config
├── tailwind.config.ts           # Dark mode class strategy
├── ecosystem.config.js          # PM2 cluster config
└── DOCUMENTATION.md             # This file
```

---

## 3. Authentication Flow

### Login sequence

```
User enters emp_id + PIN
       │
       ▼
POST /api/auth/login
       │
       ├─ PIN invalid → 401 "Invalid credentials" + audit log
       │
       ├─ Has passkeys registered?
       │     YES → set pending-auth cookie → return { requiresWebAuthn: true }
       │              │
       │              ▼
       │        Browser calls startAuthentication()
       │        POST /api/auth/webauthn/authenticate-verify
       │              │
       │              └─ OK → set access_token + refresh_token cookies → redirect
       │
       ├─ Has passkey_exemptions record (is_active = TRUE)?
       │     YES → issue tokens directly (PIN-only login) → redirect
       │
       └─ Neither → return { requiresPasskeySetup: true }
              │
              └─ UI shows: "Passkey setup required. Contact your administrator."
```

### Token storage

| Token | Storage | Details |
|-------|---------|---------|
| Access token | HttpOnly cookie `access_token` | JWT, 15 min TTL (configurable via `JWT_ACCESS_EXPIRY`) |
| Refresh token | HttpOnly cookie `refresh_token` | JWT, 7d TTL; SHA-256 hash stored in `refresh_tokens` table |
| User info | `localStorage` | `{ id, emp_id, name, role }` — readable by JS for UI rendering |

### Passkey exemptions

An employee can log in with PIN only if they have an active row in `passkey_exemptions`. This is intended for:

- **Local development / seed accounts** — all seed users get an exemption so local testing works immediately.
- **Employees who cannot use a passkey device** — admin grants exemption manually via the Employees page.

Once an employee registers a passkey, the exemption path is never reached (passkey check runs first). The exemption record can remain; it just won't be used.

### JWT verification in proxy

`proxy.ts` (Next.js 16 proxy, equivalent to middleware) verifies JWTs on the Edge using `crypto.subtle` (Web Crypto API) — no Node.js crypto module. It injects `x-employee-id` and `x-employee-role` headers forwarded to all protected route handlers.

The `requireAuth(request, roles)` helper in `lib/auth.ts` reads those headers.

---

## 4. Database Schema

### Tables

| Table | Purpose |
|-------|---------|
| `employees` | All users — employees, managers, super_admins |
| `passkeys` | WebAuthn credential public keys (one employee → many passkeys) |
| `passkey_exemptions` | Employees allowed to log in with PIN only |
| `refresh_tokens` | Hashed refresh tokens (SHA-256) with expiry |
| `locations` | Work sites with GPS coordinates and geofence radius |
| `shifts` | Shift definitions — fixed / flexible / rotating |
| `employee_schedules` | Assigns a shift + location to an employee with effective dates |
| `attendance` | Daily clock-in/out records; all times stored as UTC (`clock_in_utc`, `clock_out_utc`) |
| `leave_records` | Leave and holiday entries; `employee_id = NULL` means company-wide holiday |
| `audit_log` | Immutable activity log for all sensitive actions |

### Important field notes

- `attendance.work_date` — `DATE` column, always a `string` (`YYYY-MM-DD`) when read from MySQL via `mysql2/promise`
- `attendance.clock_in_utc` / `clock_out_utc` — `DATETIME` stored UTC; convert to IST with `formatInTimeZone(new Date(value), 'Asia/Kolkata', ...)`
- `leave_records.type` — `ENUM('leave', 'holiday')` — only two values at the DB level
- `leave_records.employee_id` — nullable; `NULL` = company-wide holiday

---

## 5. API Reference

All protected routes require a valid JWT. The proxy injects `x-employee-id` and `x-employee-role` headers; `requireAuth()` validates them.

### Auth

| Method | Path | Access | Description |
|--------|------|--------|-------------|
| POST | `/api/auth/login` | Public | PIN login; returns `requiresWebAuthn`, `requiresPasskeySetup`, or tokens |
| POST | `/api/auth/logout` | Authenticated | Clears cookies, revokes refresh token |
| POST | `/api/auth/refresh` | Public (cookie) | Issues new access token from refresh token |
| GET | `/api/auth/webauthn/authenticate` | Public | Get WebAuthn challenge |
| POST | `/api/auth/webauthn/authenticate-verify` | Public | Verify WebAuthn assertion |
| GET | `/api/auth/webauthn/register` | Authenticated | Get WebAuthn registration options |
| POST | `/api/auth/webauthn/register-verify` | Authenticated | Verify and save new passkey |

### Attendance

| Method | Path | Access | Description |
|--------|------|--------|-------------|
| GET | `/api/attendance` | manager, super_admin | List records; filters: `from_date`, `to_date`, `employee_id`, `status` |
| PUT | `/api/attendance/[id]` | manager, super_admin | Edit attendance record |
| POST | `/api/attendance/clock-in` | employee | Clock in with GPS coordinates |
| POST | `/api/attendance/clock-out` | employee | Clock out with GPS coordinates |
| GET | `/api/attendance/today` | employee | Today's attendance record for the calling user |

### Employees

| Method | Path | Access | Description |
|--------|------|--------|-------------|
| GET | `/api/employees` | manager, super_admin | List; query: `search`, `page`, `limit` |
| POST | `/api/employees` | super_admin | Create employee |
| GET | `/api/employees/[id]` | manager (own team), super_admin | Get single employee |
| PUT | `/api/employees/[id]` | super_admin | Update employee |
| DELETE | `/api/employees/[id]` | super_admin | Deactivate (soft delete) |
| GET/DELETE | `/api/employees/[id]/passkeys` | super_admin | List / revoke passkeys |
| POST/DELETE | `/api/employees/[id]/exemption` | super_admin | Grant / revoke PIN exemption |

### Schedules

| Method | Path | Access | Description |
|--------|------|--------|-------------|
| GET | `/api/schedules` | manager, super_admin | List shifts |
| POST | `/api/schedules` | super_admin | Create shift |
| DELETE | `/api/schedules/[id]` | super_admin | Delete shift |
| POST | `/api/schedules/assign` | super_admin | Assign shift + location to employee |

### Locations

| Method | Path | Access | Description |
|--------|------|--------|-------------|
| GET | `/api/locations` | manager, super_admin | List |
| POST | `/api/locations` | super_admin | Create |
| PUT | `/api/locations/[id]` | super_admin | Update |
| DELETE | `/api/locations/[id]` | super_admin | Deactivate |

### Leaves

| Method | Path | Access | Description |
|--------|------|--------|-------------|
| GET | `/api/leaves` | manager, super_admin | List; filters: `from_date`, `to_date`, `employee_id` |
| POST | `/api/leaves` | manager, super_admin | Create leave or holiday record |
| DELETE | `/api/leaves/[id]` | manager (own team), super_admin | Delete leave record |

### Reports

| Method | Path | Access | Description |
|--------|------|--------|-------------|
| GET | `/api/reports/summary` | manager, super_admin | JSON summary by employee |
| GET | `/api/reports/csv` | manager, super_admin | Download CSV; params: `from_date`, `to_date`, `employee_id` |
| GET | `/api/reports/pdf` | manager, super_admin | Download PDF; same params |

### Cron

| Method | Path | Access | Description |
|--------|------|--------|-------------|
| POST | `/api/cron/mark-absent` | `x-cron-secret` header | Marks employees absent if no attendance/leave for today |

### Audit Log

| Method | Path | Access | Description |
|--------|------|--------|-------------|
| GET | `/api/audit-log` | super_admin | Paginated audit log; filters: `action`, `entity`, `performed_by` |

---

## 6. Frontend Architecture

### State management

- **Server state** — TanStack Query v5 (`useQuery`, `useMutation`, `queryClient.invalidateQueries`)
- **Form state** — React Hook Form v7 + Zod v4 (`zodResolver`)
- **UI state** — React `useState`/`useReducer`
- **User session** — `localStorage` via `lib/user.ts` (`storeUser`, `getStoredUser`, `clearStoredUser`)
- **Theme** — `next-themes` (`ThemeProvider` in `providers.tsx`)

### Data fetching conventions

```typescript
// All fetches go through apiFetch (lib/api.ts) which auto-logs out on 401
import { apiFetch } from '@/lib/api';

const { data } = useQuery({
  queryKey: ['employees', { page, search }],
  queryFn: () => apiFetch<ApiResponse<{ employees: Employee[] }>>('/api/employees?page=1'),
});
```

### Form pattern with Zod + coerce

When Zod schemas use `z.coerce.number()` (needed for HTML `<input type="number">` which emits strings), the resolver type disagrees with the explicit form type. Cast the resolver:

```typescript
import { type Resolver } from 'react-hook-form';

const form = useForm<MyForm>({
  resolver: zodResolver(mySchema) as unknown as Resolver<MyForm>,
});

// handleSubmit callback also needs an explicit type annotation:
<form onSubmit={form.handleSubmit((v: MyForm) => mutation.mutate(v))}>
```

### Route groups and layouts

| Group | Path prefix | Layout | Access control |
|-------|-------------|--------|----------------|
| `(auth)` | `/login`, `/register-passkey` | Centered card, no sidebar | Public |
| `(employee)` | `/dashboard` | Minimal header | `employee`, `manager`, `super_admin` |
| `(admin)` | `/overview`, `/employees`, etc. | Sidebar + topbar | `manager`, `super_admin` |

Access control is enforced at two layers:
1. **proxy.ts** — redirects unauthenticated page visits to `/login`; redirects employees away from admin pages to `/dashboard`
2. **API route handlers** — `requireAuth(request, ['manager', 'super_admin'])` returns 401/403

---

## 7. Key Libraries & Patterns

### `lib/db.ts` — MySQL connection pool

```typescript
import { query, queryOne, insertAuditLog } from '@/lib/db';

// Returns T[] — use for lists
const rows = await query<Employee>('SELECT * FROM employees WHERE is_active = TRUE', []);

// Returns T | null — use for single-row lookups
const emp = await queryOne<Employee>('SELECT * FROM employees WHERE id = ?', [id]);

// Structured audit insert
await insertAuditLog({ action: 'login_success', entity: 'auth', entity_id: emp.id, performed_by: emp.id, details: {...}, ip_address: ip });
```

`lib/db.ts` also imports `./env` (which validates required env vars at startup) and registers `SIGTERM`/`SIGINT` handlers for graceful pool shutdown.

### `lib/auth.ts` — Auth helpers

```typescript
signAccessToken(payload)     // signs JWT with JWT_ACCESS_SECRET
signRefreshToken(payload)    // signs JWT with JWT_REFRESH_SECRET
comparePin(plain, hash)      // bcrypt.compare
setAuthCookies(res, at, rt)  // sets HttpOnly cookies on NextResponse
setPendingAuthCookie(res, emp_id)  // sets short-lived pending-webauthn cookie
requireAuth(request, roles)  // reads x-employee-id/role headers; returns auth object or NextResponse 401/403
```

### `lib/ratelimit.ts` — In-memory rate limiter

Map-based per-process rate limiter. Used in the login route. Note: **per-process only** — use Redis for multi-instance PM2 deployments.

```typescript
import { checkRateLimit, recordFailedAttempt, resetAttempts } from '@/lib/ratelimit';
```

### `lib/constants.ts`

```typescript
TIMEZONE = 'Asia/Kolkata'        // IST — all display formatting uses this
LOGIN_MAX_ATTEMPTS = 5
LOGIN_LOCKOUT_MINUTES = 15
```

### `@simplewebauthn/browser` v13

The API changed in v13 — options are now passed as an object:

```typescript
// v13 API (not the old positional argument style)
const credential = await startAuthentication({ optionsJSON: challengeFromServer });
const credential = await startRegistration({ optionsJSON: registrationOptionsFromServer });
```

---

## 8. Next.js 16 Migration Notes

This app targets **Next.js 16** (Turbopack default). Key differences from Next.js 14/15:

### `middleware.ts` → `proxy.ts`

The `middleware` file convention is **deprecated** in Next.js 16 and renamed to `proxy`. The exported function is also renamed:

```typescript
// proxy.ts (NOT middleware.ts)
export async function proxy(request: NextRequest) { ... }

export const config = { matcher: [...] };
```

### Turbopack by default

Next.js 16 uses Turbopack for both `next dev` and `next build`. Custom `webpack()` configs in `next.config.ts` will cause the build to fail unless you also provide a `turbopack` config or use the `--webpack` flag.

This app uses:
```typescript
// next.config.ts
const nextConfig: NextConfig = {
  turbopack: {},  // empty = use Turbopack with defaults; also silences the guard error
  ...
};
```

The `webpack resolve.fallback: { fs: false }` pattern is **not needed** — route handlers run on the Node.js server, never in the browser bundle.

### Async route params

Route segment params are now always async:

```typescript
type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Params) {
  const { id } = await context.params;  // must await
}
```

---

## 9. Local Development

### Prerequisites

- Node.js 20.9+
- MySQL 8.0+
- npm 10+

### Steps

```bash
# 1. Install dependencies
npm install

# 2. Create environment file
cp .env.example .env.local
# Fill in DB credentials and JWT secrets (see Environment Variables below)

# 3. Set up the database
mysql -u root -p < database/schema.sql
mysql -u root -p attendance_db < database/seed.sql

# 4. Start dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DB_HOST` | ✅ | — | MySQL host |
| `DB_PORT` | | `3306` | MySQL port |
| `DB_USER` | ✅ | — | MySQL username |
| `DB_PASSWORD` | ✅ | — | MySQL password |
| `DB_NAME` | ✅ | — | Database name |
| `JWT_ACCESS_SECRET` | ✅ | — | Secret for access tokens (≥ 32 chars) |
| `JWT_REFRESH_SECRET` | ✅ | — | Secret for refresh tokens (≥ 32 chars) |
| `JWT_ACCESS_EXPIRY` | | `15m` | Access token TTL |
| `JWT_REFRESH_EXPIRY` | | `7d` | Refresh token TTL |
| `WEBAUTHN_RP_ID` | ✅ | — | Relying party domain (e.g. `localhost`) |
| `WEBAUTHN_RP_NAME` | | `Attendance App` | App name shown in passkey prompt |
| `WEBAUTHN_ORIGIN` | ✅ | — | Full origin (e.g. `http://localhost:3000`) |
| `APP_TIMEZONE` | | `Asia/Kolkata` | Display timezone |
| `NEXT_PUBLIC_APP_URL` | | `http://localhost:3000` | App URL (CORS header) |
| `LOGIN_MAX_ATTEMPTS` | | `5` | Failed logins before lockout |
| `LOGIN_LOCKOUT_MINUTES` | | `15` | Lockout duration |
| `CRON_SECRET` | | — | Shared secret for mark-absent cron endpoint |
| `SMTP_HOST` | | — | SMTP server for alerts |
| `SMTP_PORT` | | — | SMTP port |
| `SMTP_USER` | | — | SMTP username |
| `SMTP_PASS` | | — | SMTP password |
| `ADMIN_EMAIL` | | — | Recipient for late/absent alert emails |

### Seed credentials

| Employee ID | PIN | Role |
|-------------|-----|------|
| ADMIN001 | 000000 | super_admin |
| MGR001 | 111111 | manager |
| EMP001 | 123456 | employee |
| EMP002 | 123456 | employee |

> All seed users have a `passkey_exemption` record so they can log in with PIN only during local development. After logging in, each user can enrol a passkey at `/register-passkey`.

### Why seed users need passkey exemptions

The login flow has three branches (see [Authentication Flow](#3-authentication-flow)):

1. Has passkey → require WebAuthn
2. Has active `passkey_exemption` → PIN-only login (issues tokens)
3. Neither → returns `requiresPasskeySetup: true` → UI shows error

Fresh seed data has no passkeys. Without `passkey_exemption` rows, all users land in branch 3 and can never log in. The seed inserts exemptions for all four accounts so that the app works immediately after `seed.sql` is loaded.

---

## 10. Production Deployment

See [README.md](README.md) for the full Ubuntu VPS deployment walkthrough (PM2, Nginx, Let's Encrypt).

### Security checklist

- [ ] Change all seed PINs immediately
- [ ] Revoke seed `passkey_exemptions` after each user has enrolled a passkey
- [ ] Set `WEBAUTHN_RP_ID` to the production domain (not `localhost`)
- [ ] Use strong random secrets for `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET`
- [ ] Run `npm audit` and apply patches
- [ ] Replace in-memory rate limiter (`lib/ratelimit.ts`) with Redis for multi-instance PM2

### Rate limiter note

`lib/ratelimit.ts` is a **per-process** in-memory Map. In PM2 cluster mode (multiple Node processes), each process has its own counter — an attacker hitting different processes can exceed the intended limit. Replace with a Redis-backed rate limiter for production multi-instance setups.

---

## 11. Known Issues & Gotchas

### `z.coerce.number()` with React Hook Form

`z.coerce.number()` gives the field an input type of `unknown` (because Zod coerces from any input). This conflicts with the explicit `useForm<MyForm>()` type parameter. Fix: cast the resolver.

```typescript
resolver: zodResolver(schema) as unknown as Resolver<MyForm>
```

Also add an explicit type annotation to `handleSubmit` callbacks:

```typescript
form.handleSubmit((v: MyForm) => mutation.mutate(v))
```

### `clock_in_utc` / `clock_out_utc` vs. `clock_in` / `clock_out`

The `attendance` table uses `clock_in_utc` and `clock_out_utc` as column names. The `AttendanceRecord` TypeScript interface mirrors this. Do not use `clock_in` or `clock_out` — those fields do not exist.

### `work_date` is always a string

MySQL's `DATE` columns come back as `string` (`"YYYY-MM-DD"`) through `mysql2/promise`, not as a JavaScript `Date`. Use `String(row.work_date).slice(0, 10)` — never `instanceof Date`.

### `leave_records.type` ENUM values

The DB schema has `type ENUM('leave', 'holiday')` — only two values. The admin UI `leaves/page.tsx` maps UI-level types (`casual`, `sick`, `earned`, `other`) to `'leave'` at the API boundary, and only `'holiday'` maps to `'holiday'`.

### WebAuthn on localhost

Set `WEBAUTHN_RP_ID=localhost` and `WEBAUTHN_ORIGIN=http://localhost:3000` in `.env.local`. Passkey enrolment and authentication only work on `localhost` or HTTPS origins; they will fail on plain HTTP with a non-localhost hostname.

### `crypto.subtle` in proxy.ts

`proxy.ts` runs on the Edge runtime. It uses `crypto.subtle` (Web Crypto API) for JWT verification because `jsonwebtoken` requires Node.js's `crypto` module which is unavailable on the Edge. The `base64urlDecode` helper returns an `ArrayBuffer` (not `Uint8Array`) to satisfy TypeScript's stricter `BufferSource` type constraint.

### Build-time env validation skipped

`lib/env.ts` skips validation when `NEXT_PHASE === 'phase-production-build'` or `SKIP_ENV_VALIDATION=1`. This allows CI/CD pipelines to run `npm run build` without providing real secrets. Validation runs at server startup in production.

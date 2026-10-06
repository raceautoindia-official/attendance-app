# Attendance app — revamp audit and plan

Written after a read-only audit of the code and of the production database on
2026-10-06. Nothing in production was changed. Every number quoted below was
measured, not estimated; where a figure is a judgement call it says so.

## Status

| Phase | State |
|---|---|
| 0 — local/production parity | **Done.** Local was missing 3 tables and 7 columns; all applied locally, and the two schemas now match at 209 columns with zero drift either way. |
| 1 — hours clarity and shortage | **Done, local only, not deployed.** `lib/hoursLedger.ts`, `/api/reports/hours-ledger`, the Working Hours page, month dropdowns, and per-day Required/Short columns in the existing Day-by-day tab. 88 new checks, 195 in total, all passing. |
| 2 — assistant accuracy | **Done, local only, not deployed.** All four defects fixed at the cause: `employee_ids` threaded through the exports, a `get_hours_ledger` tool so derived figures exist to be read, fuzzy name matching with "did you mean", and empty results that say *which* kind of empty they are. 33 offline checks plus 12 live model checks, all passing. |
| 3 — visuals | **Done, local only, not deployed.** Dependency-free SVG charts (bar, column, line, pie, stacked bar) against a colour-vision-validated palette, a `build_chart` tool that takes data and never markup, charts rendered in the assistant panel, and a worked-against-required chart on the Working Hours page. 47 offline checks plus 16 live model checks. |
| 4 — the futuristic layer | Not started. |

Decisions taken (§6): break policy is **net work with a nullable per-shift
allowance**; the standard is **roster-derived, displayed against the stated
norm**; build order is **Phase 1 first**. On the zero-hour employees, the rule
given was to ignore admin and management — on checking, only one of the seven
holds such a role, so the implemented rule skips `super_admin`/`manager` and
anyone with no roster, and groups the remaining dormant staff separately
instead of ranking them. See §2.3 #11.

---

## 1. The headline: the hard part is already built

The request was "compare an employee against a 225-hour monthly standard and
show the shortage". The app already computes 225 hours. It has never shown it.

`lib/reportSummary.ts` returns, per employee, per period:

| Field | Meaning |
|---|---|
| `expected_minutes` | What the roster demands, holidays already removed |
| `total_minutes_worked` | `SUM(attendance.total_minutes)` |
| `total_permission_minutes` | Approved short-leave minutes |
| `total_minutes_credited` | Worked **+** approved permission, capped at the day's requirement |
| `required_minutes_per_day`, `working_days`, `company_holidays`, `weekly_off_days` | The breakdown |
| `late_minutes`, `late_days`, `total_overtime_minutes`, `attendance_percentage` | Already derived |

For September 2026, measured against production:

- All three shifts (`regular day shift`, `Flexible Time`, `regular morning 10`)
  work **Mon–Sat** and are **9 hours** each — either `required_hours = 9.00` or a
  09:00–18:00 / 10:00–19:00 span.
- September 2026 has **26** Mon–Sat days.
- **One** company-wide holiday: 2026-09-14, a Monday, so a working day.

`expectedMinutesFor()` therefore returns 9 h × 26 − 9 h = **225 hours**, which
is exactly the standard quoted in the feedback. The engine is already right and
already agrees with HR.

**What is missing is the subtraction, the day-level view, and the presentation.**
`grep -rniE "shortage|deficit|shortfall"` across `app/`, `lib/` and `components/`
returns **zero hits**. The number everyone wants is one subtraction away from
data the app already has.

This matters for planning: this is not a rebuild. It is surfacing work, plus a
genuine policy decision (§3) that nobody has made yet.

---

## 2. Confirmed defects

Each one was traced to a specific line, not inferred from the symptom.

### 2.1 The assistant

| # | Symptom reported | Root cause | Where |
|---|---|---|---|
| 1 | "Average working day of X" → *can't do / no such data* | The system prompt **forbids** the model from doing arithmetic — "Do not add, subtract, average or convert numbers yourself… the correct response is that it is not available." No tool returns an average. The model obeyed its instructions exactly. | `lib/chat/prompt.ts:29` |
| 2 | Misspelled name → *no employee with that name*, no suggestion | `resolveEmployee` matches `emp_id = ?` or `name LIKE '%search%'` only. A substring miss returns zero rows and the note "No employee matches". No phonetic or edit-distance fallback. | `lib/chat/tools/employees.ts:57` |
| 3 | Individual report → 0 records, correct on the next prompt | Two causes compounding. (a) `getAttendanceDetail` never joins `employees`, so it cannot tell "no such employee" from "no rows in this period" — it silently returns `count: 0`. (b) When no range is given, `resolveRange` defaults to **`this_month`**; asked on the 6th, that is a 6-day window. The retry supplies a real month and works. | `lib/chat/tools/attendance.ts:234`, `lib/chat/dates.ts:133` |
| 4 | Asked for **one** person's Excel → got **every** employee | The download tool's schema exposes `employee_id` (**singular**) and documents it as "Required for attendance_detail and leave_balance. Null otherwise." But `getAttendanceSummary` filters on `employee_ids` (**plural array**) and the schema has no such property. So for `attendance_summary` there is **no way** for the model to scope to one person; the `employee_id` it passes is read by nothing. The whole company is correct behaviour for the code as written. | `lib/chat/registry.ts:317` vs `lib/chat/tools/attendance.ts:47` |
| 5 | No charts | No charting dependency is installed and no tool returns a chart spec. | `package.json` |

Defect 4 is the serious one: a confidently-delivered file containing the wrong
people. Defects 1 and 2 are capability gaps the model was blamed for.

### 2.2 Reports

| # | Gap | Where |
|---|---|---|
| 6 | No shortage figure anywhere, despite both operands existing | — |
| 7 | The daily report carries `worked_minutes`, `break_minutes`, `late_minutes`, `overtime_minutes`, `permission_minutes` — but **no required minutes**, so no per-day shortage. `dayRequiredMinutesOrNullSelect()` was written for exactly this and is **dead code with zero call sites**. | `app/api/reports/daily/route.ts:29`, `lib/shifts.ts:204` |
| 8 | Period selection is two raw date inputs. No month dropdown. | `app/(admin)/reports/page.tsx:311` |
| 9 | The employee's own dashboard shows "This Month: *login days*" — not hours worked against hours required. Staff cannot self-check before payroll. | `app/(employee)/dashboard/page.tsx:702` |
| 10 | Everything is dense tables. There is no per-employee monthly statement a non-technical reader can act on. | 902-line `reports/page.tsx` |

### 2.3 Data integrity found in production

| # | Finding | Why it matters |
|---|---|---|
| 11 | **7 active employees with 0 hours and 25 absences each** in September (Venkat Manohar, Manoj.P, Rajesh Kh, Sasi, Krishna Mohan, Karthik, Super Admin). | They will sit at the top of every "biggest shortage" ranking and drag every company average down. Any shortage feature is unusable until these are resolved. |
| 12 | `Addakatta Akash`: 28 days with hours but a **4.80 h/day** average, 9 multi-session days — against a 9 h requirement. | Either a genuine half-day arrangement that the roster does not record, or broken data. Must be understood before his shortage is shown to anyone. |
| 13 | `employee_schedules` rows exist with `effective_to` **earlier than** `effective_from`. | A nonsense validity window. Harmless today because the `effective_from <= date AND effective_to >= date` test excludes them, but it means schedule history cannot be trusted or audited. |
| 14 | `Karthik` and `Super Admin` have **no shift** at all. | Expected hours are correctly `NULL` — the report must say "no roster" rather than imply zero. Already handled; worth keeping. |

---

## 3. The one decision that must be made before building

**Does clocking out for lunch cost you credited hours?**

Right now it does, invisibly. Measured in September:

| Employee | Multi-session days | Avg h/day | Month total |
|---|---|---|---|
| KADALI SRIDATTA GANESH BABU | 0 | 10.98 | 318.4 h |
| Nalini Thilagar | 0 | 9.45 | 217.3 h |
| Arun Pandian | 1 | 8.68 | 208.3 h |
| **Reena Evanjaline** | **10** | **8.55** | **205.4 h** |
| Addakatta Akash | 9 | 4.80 | 134.3 h |

The requirement is 9 hours, derived from a 09:00–18:00 span — which **includes**
the lunch hour. But `total_minutes` for someone who clocks out for lunch
**excludes** it. So Reena, who clocked out for lunch on 10 days and otherwise
worked a normal month, shows roughly 20 hours short — and most of that gap is
lunch she correctly recorded. A colleague who stayed clocked in through lunch
shows no such gap.

If these figures are used to decide pay, that is a dispute waiting to happen,
and the app would be penalising the more honest record.

There are three defensible policies. This is a business decision, not a
technical one:

1. **Gross span (status quo, made explicit).** 9 h means 9 h on the clock,
   breaks included. Clocking out for lunch reduces your credit. Simple, matches
   the current numbers, arguably unfair to multi-session staff.
2. **Net work with a paid-break allowance.** Add a per-shift
   `unpaid_break_minutes` (e.g. 60) and require 8 net hours, crediting the first
   N minutes of break. Fairest, and makes the two groups comparable. Needs one
   new nullable column and a one-time decision per shift.
3. **Credit the break up to a cap.** Keep the 9 h target but add back break time
   up to, say, 60 minutes per day. Smallest change, same effect as (2) for most
   people.

My recommendation is **(2)**, with `unpaid_break_minutes` nullable so any shift
left unset behaves exactly as today. It is the only option that makes two
employees' monthly totals mean the same thing.

---

## 4. Plan

Phases are ordered so that each one is independently shippable and each later
phase depends only on earlier ones.

### Phase 0 — make local match production (half a day, no user-visible change)

Production has 22 tables; this working copy's database has 19. Missing locally:
`permission_requests`, `employee_devices`, `password_resets`. Permission minutes
feed directly into credited hours, so the hours work cannot be tested honestly
until local has them.

- Apply the existing migrations locally only.
- Seed a representative month of local data (multi-session, permissions,
  holidays, a no-shift employee) so the new figures can be verified against
  hand-arithmetic before anyone sees them.

### Phase 1 — hours clarity and the shortage engine

The core of the request.

- `lib/hoursLedger.ts` — one module that answers, for an employee and a period:
  required, worked, credited, permission, leave, holiday, week-off, overtime,
  and **shortage**, both for the month and **per day**. One module so the
  screen, the Excel export, the PDF and the assistant cannot disagree — the
  mistake `reportSummary.ts` was already written to avoid.
- Wire `dayRequiredMinutesOrNullSelect()` into `/api/reports/daily` to give each
  day its requirement, and add `shortage_minutes` per day.
- **Monthly statement view** — one employee, one month, readable by a
  non-technical reader: required vs worked as a single sentence and a bar, the
  shortage in hours and minutes, what leave and holidays account for, and a
  day-by-day table where short days are highlighted with the shortfall on each.
- **Month dropdown** alongside the existing From/To inputs. The range picker
  stays exactly as it is; the dropdown sets it.
- Additive API fields only.

### Phase 2 — assistant accuracy

Fix the five defects by their causes, not their symptoms.

- **Defect 4:** add `employee_ids` to the download schema and thread it through
  every multi-employee report. Make `attendance_summary` refuse to run when the
  question named one person but no scope was passed, rather than silently
  widening. A file that answers a different question than the one asked is worse
  than an error.
- **Defect 1:** return derived statistics *from the tools* — average hours per
  worked day, median, best and worst day, trend against the previous period.
  Keep the no-arithmetic rule in the prompt: the rule is correct, the tools were
  starved. Add a dedicated `get_employee_statistics` tool.
- **Defect 2:** fuzzy fallback in `resolveEmployee`. With 18 employees, load the
  names and rank by edit distance in JS, returning "did you mean…" candidates.
  No schema change, no extension.
- **Defect 3:** validate the employee exists; distinguish "no such person" from
  "no records in this period", and return the employee's actual first and last
  record dates so the model can say "they have no September data; their records
  run 12 Jun – 3 Oct".
- Expand the prompt with worked examples of the questions that failed.
- Extend `scripts/test-chat-live.ts` with a regression case per defect, so each
  one is proven fixed rather than assumed.

### Phase 3 — visuals

- Add one charting dependency and a small set of chart components used by both
  the reports page and the assistant.
- A `build_chart` tool returning a **data spec**, never pre-rendered HTML —
  the panel renders it. Pie, bar, line, stacked bar.
- Charts on the monthly statement: hours trend, shortage distribution,
  department comparison.

### Phase 4 — the "futuristic" layer (suggestions beyond the brief)

Ordered by value for the stated goal of paying salary from these records.

1. **Month close and lock.** Freeze a month once reviewed, with who signed it
   off and when. Without this, a report printed today and the same report
   printed next week can differ, and neither is authoritative. This is the
   single biggest step towards payroll-grade records.
2. **Regularisation requests.** An employee disputes a day; a manager approves
   or rejects; the correction is audited. Today corrections are silent edits
   (`attendance.edited_by`, `edited_at`) with no request trail.
3. **Exception-first dashboard.** Open the month and see only what needs a
   decision: missing clock-outs, zero-hour actives, short days beyond a
   threshold, geofence exceptions. Not another table of everyone.
4. **Anomaly flags.** Akash's 4.80 h average (§2.2, #12) should have raised a
   flag in September, not waited for an audit in October.
5. **Scheduled month-end email** of the statement pack to each manager.
6. **Comparison and trend** — this month vs last, employee vs department median.
7. **Pay-ready export** with the policy in force and a checksum printed on it,
   so a dispute can be settled by re-deriving the same number.

---

## 5. Non-negotiables while doing this

- **The mobile app shares this database.** Schema changes are **additive only** —
  new nullable columns and new tables. No renames, no type changes, no changes
  to the meaning of an existing column.
- **API responses are additive only.** New fields are safe; removing or renaming
  one is not.
- **No change to clock-in/clock-out behaviour.** The capture path is working and
  carries legal weight. This work is read-side only.
- `total_minutes` is **already cumulative** — it includes `banked_minutes`.
  Summing `total_minutes + banked_minutes` double-counts every multi-session
  employee. This is noted in `lib/chat/tools/attendance.ts` and must stay true.
- **Nothing reaches production** until Phase 1 is reviewed locally.

---

## 6. Open decisions

1. **Break policy** (§3) — gross span, net work with an unpaid-break allowance,
   or credit-up-to-a-cap. Recommendation: net work, nullable per shift.
2. **Standard hours source** — keep the roster-derived figure, which already
   produces 225 h for September, or add a fixed monthly standard that overrides
   it? Recommendation: keep the derived figure as the truth and display it
   against the stated standard, so a mismatch is visible rather than hidden.
3. **The 7 zero-hour active employees** (§2.3, #11) — deactivate, or mark as
   not-yet-onboarded? They must be resolved before shortage reporting is
   credible.
4. **Akash's 4.80 h/day** (§2.3, #12) — is this a real part-time arrangement? If
   so the roster should say so.

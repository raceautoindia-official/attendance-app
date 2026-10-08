# Policy / scheme system — design

Written 2026-10-07, before any code. Nothing here is committed or deployed.

---

## 1. What was asked for

> Admin creates a scheme/policy, attaches conditions to it — monthly work hours
> (225), week offs (4), shift details, PF / ESI / government tax applicable or
> not — then assigns the policy to employees. Those employees are then
> calculated under that rule set. Many policies, many employees each. Admin
> uploads proof documents per employee. A scoring section for best performers —
> no leave, timing, hours met — comparable by policy or by individual.

Plus: suggest what was missed, plan for the long term, and do not clash with
anything that already works.

---

## 2. What already exists (do not rebuild)

Checked before designing. Three of the requested pieces are already in the app:

| Requested | Already there | Gap |
|---|---|---|
| **Document upload** (Aadhaar, PAN, government ID) | `employee_documents` table, full API (`GET`/`POST`/`DELETE`), `EmployeeDocuments.tsx`, wired into the Employees page. 3 MB cap, PDF/JPEG/PNG/WebP. Types include `pan_card`, `aadhaar_card`, `bank_proof`, certificates, `offer_letter`. | No explicit **government ID** type (voter ID, driving licence, passport). **Zero documents uploaded in production** — built but unused. |
| **Shift details** | `shifts` (type, start, end, required hours, grace, working days, unpaid break) and `employee_schedules` (employee → shift, with `effective_from`/`effective_to` history) | Policy must **reference** a shift, never duplicate its fields |
| **Leave entitlement** | `leave_quotas` (casual / sick / earned, per employee per year) | Policy should seed these rather than replace them |
| **Monthly hours standard** | `STANDARD_MONTHLY_HOURS` — a single global env value, currently 225 | Needs to become **per employee**, which is exactly what a policy is for |

So the real new work is the **policy entity**, its **assignment with history**, the
**statutory flags**, and **scoring**.

---

## 3. The non-negotiable: an unassigned employee behaves exactly as today

Every rule a policy carries resolves through one function:

```
resolvePolicyFor(employeeId, date) → EffectivePolicy | null
```

`null` means *no policy assigned*, and every caller then falls back to precisely
today's behaviour — the global standard, the shift-derived requirement, the
global overtime line. Nothing moves for anybody until a policy is deliberately
assigned to them.

This is the same shape as `shifts.unpaid_break_minutes`: the column exists,
means "deduct nothing" when unset, and changed no figure anywhere until somebody
chose to set it. It is the only way to add a rules engine to a live payroll
system without a migration day.

**The mobile app shares this database.** Everything below is additive — new
tables, new nullable columns. No rename, no type change, no change to the
meaning of an existing column.

---

## 4. Data model

### 4.1 `policies` — the scheme itself

Grouped by what each field decides.

**Identity**
- `name`, `code` (short unique handle, e.g. `STAFF-225`), `description`, `is_active`

**Hours** — the heart of it
- `hours_basis` — `roster` | `fixed_monthly`. **The single most important field; see §5.**
- `monthly_hours` — e.g. `225.00`
- `week_offs_per_month` — e.g. `4`
- `default_shift_id` → `shifts.id`. A **reference**, never a copy.

**What counts as a day**
- `min_hours_full_day` — below this, the day is half
- `min_hours_half_day` — below this, the day is absent
- `late_grace_minutes` — overrides the shift's grace when set
- `overtime_after_minutes`, `overtime_multiplier`

**Leave and permission**
- `casual_leave_days`, `sick_leave_days`, `earned_leave_days` (per year)
- `carry_forward_days`
- `permission_hours_per_month`

**Statutory** — the checkboxes asked for, plus the ones missed (§6)
- `pf_applicable`, `esi_applicable`, `professional_tax_applicable`
- `income_tax_tds_applicable`, `gratuity_applicable`
- `lwf_applicable`, `bonus_applicable`

**Employment terms**
- `probation_months`, `notice_period_days`

**Scoring weights** — so different policies can value different things
- `score_weight_attendance`, `score_weight_punctuality`, `score_weight_hours`

### 4.2 `employee_policies` — assignment, with history

Deliberately shaped like `employee_schedules`:

```
employee_id, policy_id, effective_from DATE, effective_to DATE NULL,
assigned_by, notes
```

History is not optional. An employee who moves from one policy to another in
March must have January computed under the old rules and April under the new
ones, or every past month silently rewrites itself the moment somebody is
reassigned — and a closed month would stop matching the pack that was paid from
it.

### 4.3 Scoring — computed, not stored

Scores are derived on demand from attendance, exactly like the hours ledger. No
score table initially.

Storing them would create a second source of truth that drifts the moment an
attendance row is corrected — the same trap the payroll pack avoids by deriving
its figures rather than snapshotting them. If a frozen score per month is wanted
later, the right moment to capture it is **month close**, alongside the checksum.

### 4.4 Documents — extend, do not rebuild

Add to the existing `doc_type` enum: `government_id`, `passport`,
`driving_licence`, `voter_id`. Additive; existing rows unaffected.

---

## 5. The decision that matters most: `hours_basis`

"The policy says 225 hours, so calculate him on 225" has two readings, and they
disagree by hours every month.

**`roster`** — the requirement stays derived day by day from the shift and the
calendar; `monthly_hours` is the **stated norm** shown beside it. September 2026
genuinely works out to 225 h (25 working days × 9 h). October works out to 243 h,
because it has more working days and fewer holidays.

**`fixed_monthly`** — the month requires exactly `monthly_hours`, whatever the
calendar says. Predictable for payroll; wrong whenever a month is longer, shorter
or holiday-heavy, and silently wrong for anyone who joins or leaves mid-month.

**Recommendation: default every policy to `roster`**, and show the policy's
`monthly_hours` beside the derived figure so a mismatch is visible rather than
resolved in favour of whichever number the reader expected. `fixed_monthly` stays
available because some employers genuinely contract a flat monthly figure — but
it should be a deliberate choice, not the default.

The Working Hours page already displays both numbers and explains the difference,
so this needs no new UI concept; the policy simply replaces the global 225 with
the employee's own.

`week_offs_per_month` works the same way: under `roster` it is a **check** (flag
when the actual count differs), not a definition. Week offs are defined by
`shifts.working_days`, and having two things define them is how they start
disagreeing.

---

## 6. What was missed — candidates for the policy

Asked for: PF, ESI, government tax. Statutory and operational fields that
commonly belong beside them:

**Statutory (India)**
- **Professional Tax** — state-level; Tamil Nadu levies it, so it is likely needed
- **Gratuity** — eligibility after 5 years
- **Labour Welfare Fund** — Tamil Nadu has one
- **Bonus** — Payment of Bonus Act eligibility
- **TDS / income tax** — distinct from PT

**Operational, and the ones most likely to be wanted**
- **Overtime**: after how many minutes, and at what multiplier
- **Half-day threshold**: the hours below which a day counts as half — the app
  currently has no such concept, so a 4-hour day is simply "short"
- **Minimum hours for a day to count as present at all**
- **Permission hours cap** per month
- **Late grace** per policy, overriding the shift's
- **Probation** and **notice period**
- **Leave entitlement** per year, which should seed `leave_quotas`

**Deliberately NOT in the policy**
- Salary, CTC or pay rates. The brief said "not salary details", and keeping money
  out means this stays an attendance system whose output *supports* payroll rather
  than a payroll system with weaker controls than a real one.
- Anything that duplicates a shift field. The shift stays the authority.

---

## 7. Scoring

Three components, each 0–100, weighted by the policy.

| Component | Measure |
|---|---|
| **Attendance** | days present (incl. late) ÷ working days |
| **Punctuality** | days on time ÷ days where lateness is measurable |
| **Hours** | credited minutes ÷ required minutes, capped at 100 |

**Punctuality cannot be measured on a flexible shift** — `lateMinutes()` returns
null for one, which is exactly the bug that made the assistant report Arun as
having zero late days. So when punctuality is unmeasurable, its weight is
**redistributed across the other two and the score says so**. Scoring somebody out
of 70 because of how their shift is typed, and then ranking them against people
scored out of 100, would be indefensible.

Comparison works at two levels, as asked: **within a policy** (everybody on
`STAFF-225` ranked) and **across individuals**. Comparing across policies is
offered but labelled, since two policies may weight the components differently —
a cross-policy ranking is a comparison of different exams.

---

## 8. Build order — status

All four phases are built, locally, and nothing is committed or deployed.

| Phase | State |
|---|---|
| **A — foundation** | **Done.** `policies` and `employee_policies`, `resolvePolicyFor()`, CRUD API, Policies page, bulk assignment with history. Proven not to move a single figure. |
| **B — wire the rules in** | **Done.** Stated standard per employee, `hours_basis`, grace override, week-off check, statutory flags carried into the payroll pack. Proven reversible: removing a policy restores the ledger byte for byte. |
| **C — scoring** | **Done.** Three weighted components, weight redistribution when one cannot be measured, ranking within a policy or across everybody. Approved leave reported but never scored. |
| **D — documents** | **Done.** S3 direct upload with a database fallback, government-ID types, and a compliance report deriving each employee's requirements from their policy's statutory flags. |

Two decisions taken since this was written: **no half-day thresholds** (the
business has no half-day flow, so the fields were removed from the form and the
API rather than left to configure a concept the app does not implement), and
**documents live in S3** (see `docs/S3-DOCUMENT-STORAGE.md`).

### Original plan

## 8. Build order

Each phase is independently useful and leaves the app working.

**A — foundation, no behaviour change**
Tables, `resolvePolicyFor()`, policy CRUD API, Policies admin page, assignment UI
with history. Nothing reads policy yet. Verifiable: an assigned employee's figures
are byte-identical to before.

**B — wire the rules in**
Hours basis, stated standard, grace override, overtime override. Statutory flags
displayed on the employee and carried into the payroll pack's cover sheet, since
"was PF applicable for this person in this month" is a question that gets asked
later. Still no change for the unassigned.

**C — scoring**
Score computation, the comparison view, and policy/individual ranking.

**D — documents**
Extend the type enum, surface the upload more prominently given nothing has been
uploaded in production yet.

---

## 9. Open decisions

1. **`hours_basis` default** — recommendation `roster`. Confirm.
2. **Which statutory fields** from §6 do you actually need? I will include all of
   them as optional checkboxes unless you want a shorter list.
3. **Half-day threshold** — does the business have one? It does not exist in the
   app today, and adding it changes how short days are reported.
4. **Scoring weights** — default 40 attendance / 30 punctuality / 30 hours.
5. **What happens to `STANDARD_MONTHLY_HOURS`** once policies exist — keep as the
   fallback for unassigned employees. Recommended, and assumed below.

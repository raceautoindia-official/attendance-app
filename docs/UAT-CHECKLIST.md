# Manual test checklist — Phase 1–4 release

Deployed 2026-10-06, commit `d70e9b0`. Covers everything added since `93e2455`.

Work through **Part A first**. It is the part that must not have changed, and if
anything there fails, stop and roll back rather than continuing.

Each row: tick `✓` if it behaves as described, `✗` if not. For a `✗`, note what
you saw — "wrong number" is harder to act on than "showed 216h, expected 36h".

**Rollback if needed:** database backup is on the server at
`~/db-backups/attendance_db-pre-phase4-20261006-113937.sql.gz`; code is
`git checkout 93e2455`, `npm run build`, `pm2 restart attendance-app`. The three
new tables/columns are additive and empty, so they can be left in place.

---

## Part A — Nothing that worked before should have changed

| # | Test | Expected | ✓/✗ |
|---|---|---|---|
| A1 | Log in on the web | Works as before | |
| A2 | Log in on the **mobile app** (PIN) | Works as before | |
| A3 | Clock in and out from the mobile app | Recorded correctly | |
| A4 | Clock out for lunch and back in (multi-session day) | Sessions counted, hours correct | |
| A5 | Open **Attendance** | Loads, data correct | |
| A6 | Edit an attendance record | Saves as before | |
| A7 | Open **Employees**, edit one | Loads and saves | |
| A8 | Open **Leaves**, add and delete one | Works as before | |
| A9 | Open **Schedules** | Shifts list loads | |
| A10 | Open **Holiday Calendar** | Loads, holidays intact | |
| A11 | **Reports → Summary**, September 2026 | **Numbers identical to before this release** | |
| A12 | **Reports → Day by day** | Loads; new `Required` and `Short` columns appear, everything else unchanged | |
| A13 | Export **Excel**, **CSV**, **PDF** from Reports | All download and open | |
| A14 | Live tracking page | Loads as before | |

> A11 is the critical one. September must still show **225h** required. This was
> verified automatically after deploy, but confirm it with your own eyes.

---

## Part B — Working Hours (new page)

| # | Test | Expected | ✓/✗ |
|---|---|---|---|
| B1 | Sidebar → **Working Hours** | Page loads | |
| B2 | Choose **Reena Evanjaline**, **September 2026** | Headline: *worked 205h 22m of the 225h required — 19h 38m short for the month* | |
| B3 | Read the four tiles | Required 225h, Worked 205h 22m, Short, Average day | |
| B4 | Read **How September 2026 was made up** | Explains why it is 225h and not 30 × 9h | |
| B5 | The chart | Columns per working day, worked beside required | |
| B6 | Click **Show numbers** under the chart | Flips to a table of the same figures | |
| B7 | Hover a `×3` marker in the Out column | Explains the person clocked in/out 3 times; In is the first, Out is the last | |
| B8 | Scroll below the day table | Legend repeats that explanation (for phones, which have no hover) | |
| B9 | Check a `×N` row adds up | e.g. 1 Oct: in 09:53 am, out 06:40 pm, worked 7h 54m — coherent | |
| B10 | Choose **KADALI SRIDATTA GANESH BABU**, September | Reads **ahead for the month**, with a separate "unworked on short days" figure, and a note explaining why both are shown | |
| B11 | Switch to **October 2026** (current month) | Says **"Required so far"**, shows full-period figure beside it, warns figures are month-to-date | |
| B12 | In October, look at dates after today | Marked **"Not yet"** — **must not** show 9h short | |
| B13 | Switch the toggle to **Custom range** | Old From/To date inputs still work | |
| B14 | Pick someone with no shift (**Karthik**) | Says not held to rostered hours, rather than showing zeros | |
| B15 | Scroll to **How this compares** | Previous month and department median; may say there is no previous data | |

---

## Part C — Month Review (new page)

| # | Test | Expected | ✓/✗ |
|---|---|---|---|
| C1 | Sidebar → **Month Review**, September 2026 | About **32 items** | |
| C2 | Find **Addakatta Akash — "Averaging 4h 48m a day"** | Present, described as a pattern, suggests checking whether it is a part-time arrangement | |
| C3 | Find the **22-hour days** on 6 September | Flagged as possibly a missed clock-out, not asserted as fact | |
| C4 | Find the **dormant employees** (Venkat, Sasi, Manoj.P, Rajesh Kh, Krishna Mohan) | Listed once each, not duplicated as absence streaks | |
| C5 | Click the severity tiles | Filters the list; click again to restore | |
| C6 | Click **Open hours** on any row | Lands on that person's September directly | |

---

## Part D — Break policy (this one changes numbers)

Do this on **one shift first** and confirm before applying to the others.

| # | Test | Expected | ✓/✗ |
|---|---|---|---|
| D1 | **Schedules** → edit a shift | New **Unpaid break (minutes)** field with an explanation under it | |
| D2 | Leave it empty, save | Nothing changes anywhere | |
| D3 | Set **60**, save | Shift list shows `60m` under Unpaid break | |
| D4 | Re-check Reena's September | Requirement drops from 225h to about 200h; her shortfall drops accordingly | |
| D5 | Check a colleague who never clocks out for lunch | Now shows as ahead rather than level — expected, and explained | |
| D6 | Clear the field back to empty, save | Original figures return exactly | |

---

## Part E — Month close and lock

| # | Test | Expected | ✓/✗ |
|---|---|---|---|
| E1 | **Working Hours** in month mode | **Close this month** card appears | |
| E2 | Close **September 2026** with a note | Succeeds; warnings listed (open sessions, zero-hour staff) but do not block | |
| E3 | Re-open the statement | Banner reads **Closed — signed off by … on …** | |
| E4 | Try editing a **September** attendance record | **Refused**, naming who closed it and when | |
| E5 | Try adding leave dated in September | Refused the same way | |
| E6 | Try editing an **October** record | Still works — only the closed month is locked | |
| E7 | Click **Download pack** | xlsx downloads | |
| E8 | Open the **Cover** sheet | Period, closed-by, checksum, and the break policy for each shift | |
| E9 | Open the **Hours** sheet | One row per employee held to hours (not admins or the unrostered) | |
| E10 | Download it again, compare checksums | **Identical** — same data, same checksum | |
| E11 | Click **Reopen**, try an empty reason | Refused | |
| E12 | Reopen with a real reason | Succeeds; editing September works again | |
| E13 | **Audit Log** | Shows the close and the reopen, with the reason | |

---

## Part F — Corrections (new page)

The queue starts empty. Raise one first.

| # | Test | Expected | ✓/✗ |
|---|---|---|---|
| F1 | Sidebar → **Corrections** | Page loads, empty queue | |
| F2 | Raise a request for a day with a missed clock-out | Appears as **pending**; attendance **unchanged** so far | |
| F3 | Read the card | Shows what is being asked for, who raised it, and why | |
| F4 | Try to **Reject** with no note | Button disabled / refused | |
| F5 | **Reject** with a note | Status rejected; attendance still unchanged | |
| F6 | Raise another and **Approve** it | Attendance row now shows the corrected time and hours | |
| F7 | Check **Audit Log** | Both the request and the approval, with before and after | |
| F8 | Close that month, then try to approve a pending request in it | Refused | |
| F9 | Log in as that employee and try to approve their own | Refused | |

---

## Part G — AI assistant (Ctrl/Cmd+K)

| # | Test | Expected | ✓/✗ |
|---|---|---|---|
| G1 | *"What is Reena's average working day last month?"* | Answers **8h 33m** — does **not** say it cannot | |
| G2 | *"Show me Reeena's record"* (misspelled) | Asks **"did you mean Reena Evanjaline?"** rather than denying she exists | |
| G3 | *"Give me Reena's attendance report"* (no period) | States which period it used | |
| G4 | *"Export Reena's September 2026 summary to Excel"* | File contains **one row**, named for her — not the whole company | |
| G5 | *"Pie chart of hours worked by Reena, Arun and KADALI in September 2026"* | Pie renders with a **Show numbers** toggle | |
| G6 | *"Chart Reena's daily hours through September"* | Column or line chart, not a pie | |
| G7 | *"How short is Reena this month?"* | Uses the same figures as the Working Hours page | |
| G8 | Ask something unrelated (*"what's the weather"*) | Declines — out of scope | |
| G9 | Press **Stop** mid-answer | Stops; partial text kept under a "Stopped" marker | |
| G10 | Scroll up while an answer streams | Does not yank you down; **Jump to latest** pill appears | |
| G11 | Close and reopen the panel | Conversation still there | |
| G12 | Test on a **phone** | Full screen, scrolls properly | |

---

## Part H — Not working yet, by design

These are built but inert until something outside the app is fixed. Do not
raise them as bugs.

| What | Why | What unblocks it |
|---|---|---|
| **Month-end summary email** | `SMTP_FROM` is not a verified SES identity; SES has rejected 1,206 alert emails | Verify `enquiry@raceinnovations.in` in SES (ap-south-1) |
| **Nightly tracking archive** | `GDRIVE_TRACKING_FOLDER_ID` in `.env` is the documentation's example ID, and the service account can see no folders | Share a Drive folder with `drive-backup-service@primal-bonbon-452013-p0.iam.gserviceaccount.com` as Editor, put the real ID in `.env` |

---

## Decisions for you, not bugs

| Finding | Question |
|---|---|
| **Addakatta Akash** — 24 days worked, averaging 4h 48m against a 9h roster | Real part-time arrangement, or broken data? |
| **Balamurugan S**, **Shankar ganesh** — 3 and 8 days worked in September | Leavers? They top the shortage ranking until resolved |
| **Venkat Manohar, Sasi, Manoj.P, Rajesh Kh, Krishna Mohan** — no hours since June–August | Deactivate? |
| **Karthik** — active, no shift assigned | Assign a shift, or deactivate |
| **Cron secret** was printed in an earlier session | Rotate it |
| `origin/feature/workday-permissions-and-hardening` | Delete once this release proves stable |

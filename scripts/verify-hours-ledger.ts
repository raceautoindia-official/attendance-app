/**
 * scripts/verify-hours-ledger.ts — arithmetic checks for lib/hoursLedger.ts.
 *
 *   npx tsx --env-file=.env.local scripts/verify-hours-ledger.ts
 *
 * Builds its own September 2026 from scratch — a shift, three employees and a
 * controlled set of attendance rows — asserts figures worked out by hand, then
 * removes everything it created, including when an assertion fails.
 *
 * It exists because the shortage figure is going to be used to argue about pay.
 * "The totals look about right" is not good enough: every number below is
 * checked against hand arithmetic, and the fixture is deliberately built to
 * include the cases that were getting this wrong — a Sunday, a holiday, a
 * declared leave day, a half day, and an employee who clocks out for lunch.
 *
 * Touches ONLY the local database named in .env.local. Never run it against
 * production: it writes.
 */

import { buildHoursLedger } from '../lib/hoursLedger';
import { expectedMinutesFor, shiftsForEmployees } from '../lib/shifts';
import { companyHolidays, weekdayCounts } from '../lib/workingDays';
import { STANDARD_MONTHLY_MINUTES } from '../lib/constants';
import { query, queryOne, pool } from '../lib/db';

const FROM = '2026-09-01';
const TO = '2026-09-30';

// September 2026: 30 days, Sundays on the 6th, 13th, 20th and 27th.
// So 26 Mon–Sat days. One company holiday (the 14th, a Monday) leaves 25
// working days. At 9h each that is 225h — the figure HR quotes.
const WORKING_DAYS_BEFORE_HOLIDAY = 26;
const HOLIDAY = '2026-09-14';
const WORKING_DAYS = WORKING_DAYS_BEFORE_HOLIDAY - 1; // 25
const SHIFT_MINUTES = 540; // 09:00–18:00

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown) {
  check(name, actual === expected, `got ${actual}, expected ${expected}`);
}

/** 09:00 IST on a date, as a UTC datetime string. IST is UTC+5:30. */
const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  const utc = new Date(Date.parse(`${date}T00:00:00Z`) + (h * 60 + m - 330) * 60_000);
  return utc.toISOString().slice(0, 19).replace('T', ' ');
};

interface Fixture {
  shiftId: number;
  onTarget: number;
  lunchOut: number;
  dormant: number;
  noRoster: number;
  holidayRowId: number | null;
  leaveRowId: number | null;
}

async function seed(): Promise<Fixture> {
  const shift = await query<{ insertId: number }>(
    `INSERT INTO shifts (name, type, start_time, end_time, required_hours,
                         grace_minutes, working_days)
     VALUES ('__ledger_test_shift', 'fixed', '09:00:00', '18:00:00', NULL, 10,
             '["Mon","Tue","Wed","Thu","Fri","Sat"]')`,
  ) as unknown as { insertId: number };
  const shiftId = (shift as { insertId: number }).insertId;

  async function addEmployee(empId: string, name: string, role: string, roster: boolean) {
    const res = (await query(
      `INSERT INTO employees (emp_id, name, pin_hash, role, is_active)
       VALUES (?, ?, 'x', ?, 1)`,
      [empId, name, role],
    )) as unknown as { insertId: number };
    const id = res.insertId;
    if (roster) {
      await query(
        `INSERT INTO employee_schedules (employee_id, shift_id, effective_from)
         VALUES (?, ?, '2026-01-01')`,
        [id, shiftId],
      );
    }
    return id;
  }

  const onTarget = await addEmployee('__LT1', '__Ledger OnTarget', 'employee', true);
  const lunchOut = await addEmployee('__LT2', '__Ledger LunchOut', 'employee', true);
  const dormant = await addEmployee('__LT3', '__Ledger Dormant', 'employee', true);
  const noRoster = await addEmployee('__LT4', '__Ledger NoRoster', 'employee', false);

  // One company-wide holiday.
  const hol = (await query(
    `INSERT INTO leave_records (employee_id, location_id, leave_date, leave_type, notes)
     VALUES (NULL, NULL, ?, 'holiday', '__ledger_test')`,
    [HOLIDAY],
  )) as unknown as { insertId: number };

  // One declared leave day for the on-target employee: Tue 2026-09-08.
  const lv = (await query(
    `INSERT INTO leave_records (employee_id, leave_date, leave_type, notes)
     VALUES (?, '2026-09-08', 'casual', '__ledger_test')`,
    [onTarget],
  )) as unknown as { insertId: number };

  // Attendance. Walk every Mon–Sat that is not the holiday or the leave day.
  const rows: Array<[number, string, string, string | null, string | null, number | null, number, number]> = [];
  for (let d = 1; d <= 30; d++) {
    const date = `2026-09-${String(d).padStart(2, '0')}`;
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (dow === 0) continue;          // Sunday — no row at all
    if (date === HOLIDAY) continue;   // holiday — no row

    // On-target: a full 9h every working day, except the declared leave day.
    if (date !== '2026-09-08') {
      rows.push([onTarget, date, 'present', at(date, '09:00'), at(date, '18:00'), SHIFT_MINUTES, 1, 0]);
    }

    // Lunch-out: clocks out for lunch, so 8h worked inside a 9h span. The
    // span is 09:00–18:00 and total_minutes is 480, which makes the derived
    // break exactly 60.
    rows.push([lunchOut, date, 'present', at(date, '09:00'), at(date, '18:00'), 480, 2, 480]);
  }

  // Two half-days for the on-target employee, overwriting the full rows:
  // 4h on the 2nd and 3rd, to produce a known shortage.
  for (const date of ['2026-09-02', '2026-09-03']) {
    const i = rows.findIndex(r => r[0] === onTarget && r[1] === date);
    if (i >= 0) rows[i] = [onTarget, date, 'present', at(date, '09:00'), at(date, '13:00'), 240, 1, 0];
  }

  for (const r of rows) {
    await query(
      `INSERT INTO attendance (employee_id, work_date, status, clock_in_utc, clock_out_utc,
                               total_minutes, session_count, banked_minutes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      r,
    );
  }

  return {
    shiftId, onTarget, lunchOut, dormant, noRoster,
    holidayRowId: hol.insertId, leaveRowId: lv.insertId,
  };
}

async function cleanup(f: Fixture | null) {
  if (!f) return;
  const ids = [f.onTarget, f.lunchOut, f.dormant, f.noRoster].filter(Boolean);
  if (ids.length) {
    const list = ids.map(() => '?').join(',');
    await query(`DELETE FROM attendance WHERE employee_id IN (${list})`, ids);
    await query(`DELETE FROM leave_records WHERE employee_id IN (${list})`, ids);
    await query(`DELETE FROM employee_schedules WHERE employee_id IN (${list})`, ids);
    await query(`DELETE FROM employees WHERE id IN (${list})`, ids);
  }
  await query(`DELETE FROM leave_records WHERE notes = '__ledger_test'`);
  if (f.shiftId) await query(`DELETE FROM shifts WHERE id = ?`, [f.shiftId]);
}

async function main() {
  let f: Fixture | null = null;
  try {
    // Refuse to run anywhere that looks like production.
    const dbName = process.env.DB_NAME ?? '';
    if (/prod/i.test(dbName) || dbName === 'attendance_db') {
      console.log(`REFUSED: DB_NAME is "${dbName}", which looks like production. This script writes.`);
      failed += 1;
      return;
    }
    console.log(`\nSeeding fixture September 2026 in "${dbName}"…`);
    f = await seed();

    // ---- the calendar itself ------------------------------------------------
    console.log('\n— calendar —');
    const counts = weekdayCounts(FROM, TO);
    const monSat = counts.slice(1).reduce((a, b) => a + b, 0);
    eq('Mon–Sat days in September 2026', monSat, WORKING_DAYS_BEFORE_HOLIDAY);
    eq('Sundays in September 2026', counts[0], 4);
    const hols = await companyHolidays(FROM, TO);
    check('the fixture holiday is seen as company-wide', hols.includes(HOLIDAY), hols.join(','));

    // ---- the existing engine still agrees ----------------------------------
    console.log('\n— the roster requirement is 225h, matching the stated norm —');
    const shiftMap = await shiftsForEmployees([f.onTarget], TO);
    const expected = expectedMinutesFor(shiftMap.get(f.onTarget)!, counts, hols);
    eq('expectedMinutesFor (existing engine)', expected, WORKING_DAYS * SHIFT_MINUTES);
    eq('…which is 225 hours', expected / 60, 225);
    eq('…and equals the stated monthly standard', expected, STANDARD_MONTHLY_MINUTES);

    // ---- the on-target employee -------------------------------------------
    console.log('\n— employee who works full days, with 2 half-days and 1 leave day —');
    const a = (await buildHoursLedger({ employeeId: f.onTarget, fromDate: FROM, toDate: TO }))!;
    check('ledger built', Boolean(a));
    eq('calendar days', a.totals.calendar_days, 30);
    eq('week offs (the 4 Sundays)', a.totals.week_off_days, 4);
    eq('holidays', a.totals.holiday_days, 1);
    eq('leave days', a.totals.leave_days, 1);
    // 26 Mon–Sat − 1 holiday − 1 leave = 24 working days that demand hours.
    eq('working days that demand hours', a.totals.working_days, WORKING_DAYS - 1);
    eq('required minutes', a.totals.required_minutes, (WORKING_DAYS - 1) * SHIFT_MINUTES);

    // 24 working days: 22 full (540) + 2 half (240).
    eq('worked minutes', a.totals.worked_minutes, 22 * SHIFT_MINUTES + 2 * 240);
    // Each half day is 540 − 240 = 300 short.
    eq('shortage minutes', a.totals.shortage_minutes, 2 * 300);
    eq('days short', a.totals.days_short, 2);
    eq('days worked', a.totals.days_worked, 24);
    eq('average worked minutes per worked day',
      a.totals.avg_worked_minutes_per_day,
      Math.round((22 * SHIFT_MINUTES + 2 * 240) / 24));
    eq('shortest day', a.totals.shortest_day?.minutes, 240);
    eq('longest day', a.totals.longest_day?.minutes, SHIFT_MINUTES);
    eq('standing', a.standing, 'counted');

    // ---- the bug this all started from -------------------------------------
    console.log('\n— a Sunday is a week off, not a missed holiday —');
    const sunday = a.days.find(d => d.date === '2026-09-06')!;
    eq('Sunday kind', sunday.kind, 'week_off');
    eq('Sunday requires nothing', sunday.required_minutes, 0);
    eq('Sunday produces no shortage', sunday.shortage_minutes, 0);
    const holiday = a.days.find(d => d.date === HOLIDAY)!;
    eq('holiday kind', holiday.kind, 'holiday');
    eq('holiday produces no shortage', holiday.shortage_minutes, 0);
    const leaveDay = a.days.find(d => d.date === '2026-09-08')!;
    eq('leave day kind', leaveDay.kind, 'leave');
    eq('leave day produces no shortage', leaveDay.shortage_minutes, 0);
    check('no non-working day produces a shortage',
      a.days.filter(d => d.kind !== 'working').every(d => d.shortage_minutes === 0));

    // ---- per-day detail ----------------------------------------------------
    console.log('\n— per-day shortage is itemised —');
    const half = a.days.find(d => d.date === '2026-09-02')!;
    eq('half day required', half.required_minutes, SHIFT_MINUTES);
    eq('half day worked', half.worked_minutes, 240);
    eq('half day shortage', half.shortage_minutes, 300);
    check('day shortages sum to the total',
      a.days.reduce((s, d) => s + d.shortage_minutes, 0) === a.totals.shortage_minutes);
    check('day requirements sum to the total',
      a.days.reduce((s, d) => s + (d.required_minutes ?? 0), 0) === a.totals.required_minutes);

    // ---- the lunch-break unfairness ---------------------------------------
    console.log('\n— the employee who clocks out for lunch —');
    const b = (await buildHoursLedger({ employeeId: f.lunchOut, fromDate: FROM, toDate: TO }))!;
    eq('required minutes', b.totals.required_minutes, WORKING_DAYS * SHIFT_MINUTES);
    eq('worked minutes (8h x 25 days)', b.totals.worked_minutes, WORKING_DAYS * 480);
    eq('derived break minutes (1h x 25 days)', b.totals.break_minutes, WORKING_DAYS * 60);
    eq('shortage with NO break policy set', b.totals.shortage_minutes, WORKING_DAYS * 60);
    check('a warning explains the recorded break is costing them hours',
      b.warnings.some(w => w.includes('unpaid-break allowance')), b.warnings.join(' | '));

    // ---- the policy, once chosen ------------------------------------------
    console.log('\n— setting a 60-minute unpaid break makes the two comparable —');
    await query(`UPDATE shifts SET unpaid_break_minutes = 60 WHERE id = ?`, [f.shiftId]);
    const b2 = (await buildHoursLedger({ employeeId: f.lunchOut, fromDate: FROM, toDate: TO }))!;
    eq('required drops by exactly 60 per working day',
      b2.totals.required_minutes, WORKING_DAYS * (SHIFT_MINUTES - 60));
    eq('shortage is now nil', b2.totals.shortage_minutes, 0);
    eq('policy reports the deduction', b2.policy.unpaid_break_minutes, 60);
    eq('policy reports the gross span', b2.policy.gross_minutes_per_day, SHIFT_MINUTES);
    eq('policy reports the net requirement', b2.policy.net_minutes_per_day, SHIFT_MINUTES - 60);

    // The colleague who never clocks out is now slightly ahead rather than level,
    // which is the unavoidable benefit of the doubt for an unrecorded break.
    const a2 = (await buildHoursLedger({ employeeId: f.onTarget, fromDate: FROM, toDate: TO }))!;
    eq('full-day colleague now has overtime', a2.totals.overtime_minutes, 22 * 60);
    check('the two are no longer judged differently for the same work',
      b2.totals.shortage_minutes < b.totals.shortage_minutes,
      `${b.totals.shortage_minutes} → ${b2.totals.shortage_minutes}`);

    // The existing aggregate engine must move in step, or the Reports page and
    // the statement would quote different requirements for the same month.
    const shiftMap2 = await shiftsForEmployees([f.onTarget], TO);
    eq('the existing engine agrees after the policy change',
      expectedMinutesFor(shiftMap2.get(f.onTarget)!, counts, hols),
      WORKING_DAYS * (SHIFT_MINUTES - 60));

    await query(`UPDATE shifts SET unpaid_break_minutes = NULL WHERE id = ?`, [f.shiftId]);
    const b3 = (await buildHoursLedger({ employeeId: f.lunchOut, fromDate: FROM, toDate: TO }))!;
    eq('clearing the policy restores the original figures',
      b3.totals.required_minutes, WORKING_DAYS * SHIFT_MINUTES);

    // ---- standing ---------------------------------------------------------
    console.log('\n— who is counted —');
    const d = (await buildHoursLedger({ employeeId: f.dormant, fromDate: FROM, toDate: TO }))!;
    eq('rostered but never clocked in', d.standing, 'dormant');
    check('dormant has a stated reason', Boolean(d.standing_reason), d.standing_reason ?? '');
    const n = (await buildHoursLedger({ employeeId: f.noRoster, fromDate: FROM, toDate: TO }))!;
    eq('no roster', n.standing, 'excluded');
    eq('no roster demands nothing', n.totals.required_minutes, 0);

    const admin = await queryOne<{ id: number }>(
      `SELECT id FROM employees WHERE role = 'super_admin' AND is_active = 1 LIMIT 1`,
    );
    if (admin) {
      const s = (await buildHoursLedger({ employeeId: admin.id, fromDate: FROM, toDate: TO }))!;
      eq('a super_admin is excluded', s.standing, 'excluded');
    }

    const missing = await buildHoursLedger({ employeeId: 99_999_999, fromDate: FROM, toDate: TO });
    eq('an unknown employee returns null, not an empty ledger', missing, null);

    // ---- the stated standard ----------------------------------------------
    console.log('\n— roster figure against the stated norm —');
    eq('stated standard', a.standard.stated_minutes, STANDARD_MONTHLY_MINUTES);
    eq('roster requirement for a full month', b3.standard.roster_minutes, WORKING_DAYS * SHIFT_MINUTES);
    eq('the two agree for September 2026', b3.standard.difference_minutes, 0);
  } finally {
    await cleanup(f);
    const left = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM employees WHERE emp_id LIKE '__LT%'`,
    );
    check('fixture cleaned up', Number(left?.n ?? 0) === 0, `${left?.n} rows left`);
    console.log(`\n${passed} passed, ${failed} failed`);
  }
}

main()
  .catch(err => {
    console.error(err);
    failed += 1;
  })
  .finally(async () => {
    await pool.end();
    process.exit(failed === 0 ? 0 : 1);
  });

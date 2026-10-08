/**
 * scripts/verify-holiday-working.ts — somebody who works on a holiday.
 *
 *   npx tsx --env-file=.env.local scripts/verify-holiday-working.ts
 *
 * A policy may roster every day of the month, so a government holiday is still
 * a day somebody turns up. The question that matters for pay is what the ledger
 * then says: a holiday asks for nothing, so if work on it were credited against
 * a requirement of zero and then discarded, the hours would simply vanish.
 *
 * What is proved here:
 *   - the day is still labelled as the holiday it is, not silently reclassified
 *   - the hours actually worked are recorded and credited
 *   - no shortage is raised against a day that asked for nothing
 *   - the work lands in overtime, which is where unrequired hours belong
 *   - it is visible in the day list, so somebody can be paid for it
 *
 * Everything it creates is prefixed ZZHW and removed at the end.
 */

import { buildHoursLedger } from '../lib/hoursLedger';
import { query, queryOne, pool } from '../lib/db';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

// Both in the PAST: a future day correctly asks for nothing, which would
// make the ordinary day beside the holiday look like a holiday too.
const HOLIDAY = '2026-09-16';
const NORMAL = '2026-09-17';

async function cleanup() {
  await query(
    `DELETE a FROM attendance a JOIN employees e ON e.id = a.employee_id
      WHERE e.emp_id LIKE 'ZZHW%'`);
  await query(
    `DELETE es FROM employee_schedules es JOIN employees e ON e.id = es.employee_id
      WHERE e.emp_id LIKE 'ZZHW%'`);
  await query(`DELETE FROM employees WHERE emp_id LIKE 'ZZHW%'`);
  await query(`DELETE FROM shifts WHERE name LIKE 'ZZhw_%'`);
  await query(
    `DELETE FROM leave_records
      WHERE employee_id IS NULL AND leave_type = 'holiday' AND leave_date = ?
        AND notes = 'ZZHW fixture'`, [HOLIDAY]);
}

function at(date: string, hhmm: string) {
  // IST is UTC+5:30, and the DB pool reads and writes UTC.
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.parse(`${date}T00:00:00Z`) + ((h - 5) * 60 + (m - 30)) * 60_000);
}

async function main() {
  try {
    await cleanup();

    // A seven-day roster: the "30 days working" case, where a holiday is not
    // already excluded by being a week off.
    const shiftId = ((await query(
      `INSERT INTO shifts (name, type, start_time, end_time, required_hours, grace_minutes, working_days)
       VALUES ('ZZhw_everyday', 'fixed', '09:00:00', '18:00:00', NULL, 10,
               '["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]')`,
    )) as unknown as { insertId: number }).insertId;

    const empId = ((await query(
      `INSERT INTO employees (emp_id, name, pin_hash, role, is_active)
       VALUES ('ZZHW1', 'ZZ Holiday Worker', 'x', 'employee', 1)`,
    )) as unknown as { insertId: number }).insertId;
    await query(
      `INSERT INTO employee_schedules (employee_id, shift_id, effective_from)
       VALUES (?, ?, '2019-01-01')`, [empId, shiftId]);

    // A company-wide holiday, the same shape the holiday calendar writes.
    await query(
      `INSERT INTO leave_records (employee_id, location_id, leave_type, leave_date, notes)
       VALUES (NULL, NULL, 'holiday', ?, 'ZZHW fixture')`, [HOLIDAY]);

    // Worked a full day on the holiday, and a normal day after it for contrast.
    for (const d of [HOLIDAY, NORMAL]) {
      await query(
        `INSERT INTO attendance (employee_id, work_date, status, clock_in_utc, first_clock_in_utc,
                                 clock_out_utc, total_minutes, session_count, banked_minutes)
         VALUES (?, ?, 'present', ?, ?, ?, 480, 1, 0)`,
        [empId, d, at(d, '09:00'), at(d, '09:00'), at(d, '17:00')],
      );
    }

    const led = (await buildHoursLedger({
      employeeId: empId, fromDate: HOLIDAY, toDate: NORMAL,
    }))!;
    const hol = led.days.find(d => d.date === HOLIDAY)!;
    const norm = led.days.find(d => d.date === NORMAL)!;

    console.log('\n— the day is still a holiday —');
    eq('it is labelled as a holiday, not reclassified as working', hol.kind, 'holiday');
    check('and carries the holiday name', Boolean(hol.kind_label), String(hol.kind_label));
    eq('a holiday asks for no hours', hol.required_minutes, 0);

    console.log('\n— but the work is NOT lost —');
    eq('the hours worked are recorded', hol.worked_minutes, 480);
    eq('and credited in full', hol.credited_minutes, 480);
    check('the day appears in the record at all', Boolean(hol), 'present in days[]');
    eq('the clock-in is kept', typeof hol.clock_in_utc, 'string');

    console.log('\n— and no shortage is invented —');
    eq('no shortage against a day that asked for nothing', hol.shortage_minutes, 0);
    eq('the hours land in overtime, where unrequired work belongs', hol.overtime_minutes, 480);

    console.log('\n— the ordinary day beside it is unaffected —');
    eq('a normal day still asks for its hours', norm.required_minutes, 540);
    eq('and is short by the hour not worked', norm.shortage_minutes, 60);

    console.log('\n— the month totals carry it —');
    check('worked minutes include the holiday',
      led.totals.worked_minutes === 960, String(led.totals.worked_minutes));
    eq('the holiday is counted as a holiday', led.totals.holiday_days, 1);
    check('and it is not counted as a scheduled working day',
      led.totals.working_days === 1, String(led.totals.working_days));

    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    await cleanup();
  }
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });

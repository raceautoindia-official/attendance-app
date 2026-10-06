/**
 * scripts/verify-late-not-measured.ts — a zero that means "not tracked".
 *
 *   npx tsx --env-file=.env.local scripts/verify-late-not-measured.ts
 *
 * The reported bug: asked how many days Arun was late in September, the
 * assistant said "0 late days. No late records were found" — while the
 * day-by-day table plainly showed him arriving at 11:20, 14:37 and so on
 * against a 10:00 start.
 *
 * The data was not wrong. `lateMinutes()` returns null for a flexible shift,
 * because "work your hours whenever" has no late, so nobody on one is ever
 * marked late. The fault was presentation: a count of zero was reported as
 * punctuality when it meant the measurement does not exist. A zero that means
 * two different things has to say which one it means.
 *
 * Builds a fixture of one flexible and one fixed employee and removes it.
 */

import { getLateArrivals } from '../lib/chat/tools/attendance';
import { buildHoursLedger } from '../lib/hoursLedger';
import { findExceptions } from '../lib/exceptions';
import { SYSTEM_PROMPT } from '../lib/chat/prompt';
import type { ChatContext } from '../lib/chat/types';
import { query, queryOne, pool } from '../lib/db';

const CTX: ChatContext = { employeeId: 1, role: 'super_admin' };
const FROM = '2019-04-01';
const TO = '2019-04-30';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.parse(`${date}T00:00:00Z`) + (h * 60 + m - 330) * 60_000)
    .toISOString().slice(0, 19).replace('T', ' ');
};

interface Fixture { flexShift: number; fixedShift: number; flexEmp: number; fixedEmp: number; }

async function seed(): Promise<Fixture> {
  // Exactly production's shape: flexible, but carrying a start time and grace.
  const flexShift = ((await query(
    `INSERT INTO shifts (name, type, start_time, end_time, required_hours, grace_minutes, working_days)
     VALUES ('__lnm_flexible', 'flexible', '10:00:00', '19:00:00', 9, 10,
             '["Mon","Tue","Wed","Thu","Fri","Sat"]')`,
  )) as unknown as { insertId: number }).insertId;

  const fixedShift = ((await query(
    `INSERT INTO shifts (name, type, start_time, end_time, grace_minutes, working_days)
     VALUES ('__lnm_fixed', 'fixed', '10:00:00', '19:00:00', 10,
             '["Mon","Tue","Wed","Thu","Fri","Sat"]')`,
  )) as unknown as { insertId: number }).insertId;

  const add = async (empId: string, name: string, shiftId: number) => {
    const r = (await query(
      `INSERT INTO employees (emp_id, name, pin_hash, role, is_active) VALUES (?, ?, 'x', 'employee', 1)`,
      [empId, name],
    )) as unknown as { insertId: number };
    await query(
      `INSERT INTO employee_schedules (employee_id, shift_id, effective_from) VALUES (?, ?, '2019-01-01')`,
      [r.insertId, shiftId],
    );
    return r.insertId;
  };

  const flexEmp = await add('__LNM1', '__Late Flexible', flexShift);
  const fixedEmp = await add('__LNM2', '__Late Fixed', fixedShift);

  // Both arrive at 11:20 — an hour and twenty minutes after the start time.
  for (const d of ['02', '03', '04', '05']) {
    const date = `2019-04-${d}`;
    for (const [emp, status] of [[flexEmp, 'present'], [fixedEmp, 'late']] as const) {
      await query(
        `INSERT INTO attendance (employee_id, work_date, status, clock_in_utc, first_clock_in_utc,
                                 clock_out_utc, total_minutes, session_count, banked_minutes)
         VALUES (?, ?, ?, ?, ?, ?, 480, 1, 0)`,
        [emp, date, status, at(date, '11:20'), at(date, '11:20'), at(date, '19:20')],
      );
    }
  }
  return { flexShift, fixedShift, flexEmp, fixedEmp };
}

async function cleanup(f: Fixture | null) {
  if (!f) return;
  const ids = [f.flexEmp, f.fixedEmp].filter(Boolean);
  if (ids.length) {
    const list = ids.map(() => '?').join(',');
    await query(`DELETE FROM attendance WHERE employee_id IN (${list})`, ids);
    await query(`DELETE FROM employee_schedules WHERE employee_id IN (${list})`, ids);
    await query(`DELETE FROM employees WHERE id IN (${list})`, ids);
  }
  for (const s of [f.flexShift, f.fixedShift]) {
    if (s) await query(`DELETE FROM shifts WHERE id = ?`, [s]);
  }
}

async function main() {
  let f: Fixture | null = null;
  try {
    const db = process.env.DB_NAME ?? '';
    if (/prod/i.test(db) || db === 'attendance_db') {
      console.log(`REFUSED: DB_NAME is "${db}" — this script writes.`);
      failed += 1;
      return;
    }
    f = await seed();

    console.log('\n— the fixed-shift employee is caught, as always —');
    const fixedOnly = await getLateArrivals(CTX, {
      from_date: FROM, to_date: TO, employee_ids: [f.fixedEmp],
    });
    eq('they appear in the late list', fixedOnly.count, 1);
    eq('with four late days', fixedOnly.rows[0]?.day_count, 4);
    check('and no caveat is attached, because none is needed',
      !(fixedOnly.notes ?? []).some(n => /not measured/i.test(n)),
      (fixedOnly.notes ?? []).join(' | '));

    console.log('\n— the flexible employee arrived just as late and is NOT caught —');
    const flexOnly = await getLateArrivals(CTX, {
      from_date: FROM, to_date: TO, employee_ids: [f.flexEmp],
    });
    eq('they do not appear', flexOnly.count, 0);
    check('BUT the result says lateness is not measured for them',
      (flexOnly.notes ?? []).some(n => /not measured/i.test(n)),
      (flexOnly.notes ?? []).join(' | ').slice(0, 150));
    check('…names them, so the answer can be specific',
      (flexOnly.notes ?? []).some(n => n.includes('__Late Flexible')));
    check('…and says zero means not tracked, not punctual',
      (flexOnly.notes ?? []).some(n => /not tracked, not punctual/i.test(n)));
    check('…and points at what CAN be reported instead',
      (flexOnly.notes ?? []).some(n => /get_attendance_detail/i.test(n)));
    check('…and flags the contradictory start time on the shift',
      (flexOnly.notes ?? []).some(n => /should be set to "fixed"/i.test(n)),
      (flexOnly.notes ?? []).join(' | ').slice(-150));

    console.log('\n— the caveat appears even when the list is NOT empty —');
    const both = await getLateArrivals(CTX, {
      from_date: FROM, to_date: TO, employee_ids: [f.flexEmp, f.fixedEmp],
    });
    eq('one of the two is listed', both.count, 1);
    check('and the omission of the other is still declared',
      (both.notes ?? []).some(n => /not measured/i.test(n) && n.includes('__Late Flexible')),
      'a list that silently omits people misleads even when it has rows');

    console.log('\n— the hours ledger says the same —');
    const led = (await buildHoursLedger({ employeeId: f.flexEmp, fromDate: FROM, toDate: TO }))!;
    eq('late minutes total zero', led.totals.late_minutes, 0);
    check('and a warning explains why that zero is not punctuality',
      led.warnings.some(w => /not measured on a flexible shift/i.test(w)),
      led.warnings.join(' | ').slice(0, 140));
    const ledFixed = (await buildHoursLedger({ employeeId: f.fixedEmp, fromDate: FROM, toDate: TO }))!;
    check('the fixed-shift employee gets no such warning',
      !ledFixed.warnings.some(w => /not measured/i.test(w)));
    check('…and does accrue late minutes', ledFixed.totals.late_minutes > 0,
      `${ledFixed.totals.late_minutes} min`);

    console.log('\n— the configuration contradiction reaches Month Review —');
    const exc = await findExceptions(FROM, TO);
    const cfg = exc.exceptions.find(e => e.type === 'shift_config' && e.id.includes('__lnm_flexible'));
    check('the flexible-shift-with-a-start-time is flagged', Boolean(cfg),
      cfg ? cfg.title : exc.exceptions.map(e => e.type).join(', '));
    check('…as something to decide, not a fault',
      Boolean(cfg && /administrator|If that start time is meant/i.test(cfg.action + cfg.detail)),
      cfg?.action.slice(0, 110) ?? '');

    console.log('\n— the prompt tells the model to check what a zero means —');
    check('it warns that zero can mean "not measured"',
      /not measured/i.test(SYSTEM_PROMPT) && /never report a zero without checking/i.test(SYSTEM_PROMPT));
    check('…with the flexible-shift case named',
      /flexible shift does not measure lateness/i.test(SYSTEM_PROMPT));
  } finally {
    await cleanup(f);
    const left = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM employees WHERE emp_id LIKE '__LNM%'`,
    );
    check('fixture cleaned up', Number(left?.n ?? 0) === 0, `${left?.n} left`);
    console.log(`\n${passed} passed, ${failed} failed`);
  }
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });

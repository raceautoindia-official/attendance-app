/**
 * scripts/verify-performance.ts — scoring, and what it refuses to score.
 *
 *   npx tsx --env-file=.env.local scripts/verify-performance.ts
 *
 * Two things here matter more than the arithmetic.
 *
 * Approved leave must NOT lower a score. It is an entitlement the company
 * grants and an administrator approves, and the figure gets used in
 * conversations about pay. A silent penalty for taking approved sick leave is
 * the kind of thing nobody notices until somebody is harmed by it.
 *
 * An unmeasurable component must have its weight redistributed, not treated as
 * zero. Punctuality does not exist on a flexible shift; scoring somebody out of
 * 70 and ranking them against people scored out of 100 would be invisible on a
 * leaderboard and indefensible once spotted.
 *
 * Builds its own month and removes it, including on failure.
 */

import { scoreEmployee, rankPerformance } from '../lib/performance';
import { createPolicy, assignPolicy } from '../lib/policy';
import { query, queryOne, pool } from '../lib/db';

const FROM = '2019-08-01';
const TO = '2019-08-31';

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

const workingDates = () => {
  const out: string[] = [];
  for (let d = 1; d <= 31; d++) {
    const date = `2019-08-${String(d).padStart(2, '0')}`;
    if (new Date(`${date}T00:00:00Z`).getUTCDay() !== 0) out.push(date);
  }
  return out;
};

interface Fixture {
  fixedShift: number; flexShift: number;
  perfect: number; leaveTaker: number; absentee: number; flexible: number; latecomer: number;
}

async function seed(): Promise<Fixture> {
  const mk = async (name: string, type: string) => ((await query(
    `INSERT INTO shifts (name, type, start_time, end_time, required_hours, grace_minutes, working_days)
     VALUES (?, ?, '09:00:00', '18:00:00', ?, 10, '["Mon","Tue","Wed","Thu","Fri","Sat"]')`,
    [name, type, type === 'flexible' ? 9 : null],
  )) as unknown as { insertId: number }).insertId;

  const fixedShift = await mk('ZZperf_fixed', 'fixed');
  const flexShift = await mk('ZZperf_flex', 'flexible');

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

  const f: Fixture = {
    fixedShift, flexShift,
    perfect: await add('ZZPF1', 'ZZ Perfect', fixedShift),
    leaveTaker: await add('ZZPF2', 'ZZ Leave Taker', fixedShift),
    absentee: await add('ZZPF3', 'ZZ Absentee', fixedShift),
    flexible: await add('ZZPF4', 'ZZ Flexible', flexShift),
    latecomer: await add('ZZPF5', 'ZZ Latecomer', fixedShift),
  };

  const full = (emp: number, date: string, start = '09:00') => query(
    `INSERT INTO attendance (employee_id, work_date, status, clock_in_utc, first_clock_in_utc,
                             clock_out_utc, total_minutes, session_count, banked_minutes)
     VALUES (?, ?, 'present', ?, ?, ?, 540, 1, 0)`,
    [emp, date, at(date, start), at(date, start), at(date, '18:00')],
  );

  const dates = workingDates();
  for (const d of dates) {
    await full(f.perfect, d);
    await full(f.flexible, d, '11:30');   // very late, but on a flexible shift
    await full(f.latecomer, d, '09:45');  // 35 minutes late, past a 10-minute grace
  }

  // Leave taker: five days of APPROVED leave, perfect on every other day.
  const leaveDays = dates.slice(0, 5);
  for (const d of dates) {
    if (leaveDays.includes(d)) {
      await query(
        `INSERT INTO leave_records (employee_id, leave_date, leave_type, notes)
         VALUES (?, ?, 'sick', 'ZZperf fixture')`, [f.leaveTaker, d],
      );
      continue;
    }
    await full(f.leaveTaker, d);
  }

  // Absentee: five days simply absent, perfect on every other day.
  for (const [i, d] of dates.entries()) {
    if (i < 5) {
      await query(
        `INSERT INTO attendance (employee_id, work_date, status, total_minutes, session_count, banked_minutes)
         VALUES (?, ?, 'absent', NULL, 1, 0)`, [f.absentee, d],
      );
      continue;
    }
    await full(f.absentee, d);
  }
  return f;
}

async function cleanup(f: Fixture | null) {
  if (!f) return;
  const ids = [f.perfect, f.leaveTaker, f.absentee, f.flexible, f.latecomer].filter(Boolean);
  if (ids.length) {
    const list = ids.map(() => '?').join(',');
    await query(`DELETE FROM employee_policies WHERE employee_id IN (${list})`, ids);
    await query(`DELETE FROM attendance WHERE employee_id IN (${list})`, ids);
    await query(`DELETE FROM leave_records WHERE employee_id IN (${list})`, ids);
    await query(`DELETE FROM employee_schedules WHERE employee_id IN (${list})`, ids);
    await query(`DELETE FROM employees WHERE id IN (${list})`, ids);
  }
  for (const s of [f.fixedShift, f.flexShift]) {
    if (s) await query(`DELETE FROM shifts WHERE id = ?`, [s]);
  }
  await query(`DELETE FROM policies WHERE code LIKE 'ZZPERF%'`);
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
    await query(`DELETE FROM policies WHERE code LIKE 'ZZPERF%'`);
    f = await seed();

    const score = (id: number) => scoreEmployee(id, FROM, TO);

    console.log('\n— somebody who did everything right —');
    const perfect = (await score(f.perfect))!;
    eq('attendance is full', perfect.components.attendance.value, 100);
    eq('punctuality is full', perfect.components.punctuality.value, 100);
    eq('hours are full', perfect.components.hours.value, 100);
    eq('so the total is 100', perfect.total, 100);

    console.log('\n— APPROVED LEAVE MUST NOT LOWER A SCORE —');
    const leaver = (await score(f.leaveTaker))!;
    eq('attendance is still full — leave never asked for them',
      leaver.components.attendance.value, 100);
    eq('hours are still full — the requirement dropped with the leave',
      leaver.components.hours.value, 100);
    eq('so the score matches somebody who took none', leaver.total, perfect.total);
    eq('…and the leave is still reported, so it is visible', leaver.facts.leave_days, 5);
    check('their working days are fewer, which is why nothing was lost',
      leaver.facts.working_days < perfect.facts.working_days,
      `${leaver.facts.working_days} vs ${perfect.facts.working_days}`);

    console.log('\n— ABSENCE, which is a different fact, does lower it —');
    const absent = (await score(f.absentee))!;
    check('attendance is down', (absent.components.attendance.value ?? 100) < 100,
      String(absent.components.attendance.value));
    check('the total is below the perfect one', (absent.total ?? 100) < (perfect.total ?? 0),
      `${absent.total} vs ${perfect.total}`);
    eq('and the absences are reported', absent.facts.days_absent, 5);
    check('an absentee scores below somebody who took the same number of leave days',
      (absent.total ?? 0) < (leaver.total ?? 0),
      'leave is granted; absence is not — the score has to tell them apart');

    console.log('\n— lateness lowers punctuality, nothing else —');
    const late = (await score(f.latecomer))!;
    eq('attendance is untouched', late.components.attendance.value, 100);
    eq('hours are untouched', late.components.hours.value, 100);
    eq('punctuality is zero — late every single day', late.components.punctuality.value, 0);
    check('so the total falls by exactly the punctuality weight',
      Math.abs((late.total ?? 0) - (100 - late.components.punctuality.weight)) < 0.05,
      `${late.total} with punctuality weighted ${late.components.punctuality.weight}%`);

    console.log('\n— AN UNMEASURABLE COMPONENT IS REDISTRIBUTED, NOT ZEROED —');
    const flex = (await score(f.flexible))!;
    eq('punctuality cannot be measured', flex.components.punctuality.value, null);
    eq('…so it carries no weight', flex.components.punctuality.weight, 0);
    check('and the remaining weights still add to 100',
      Math.abs(flex.components.attendance.weight + flex.components.hours.weight - 100) < 0.05,
      `${flex.components.attendance.weight} + ${flex.components.hours.weight}`);
    eq('so somebody arriving at 11:30 daily still scores 100 on a flexible shift', flex.total, 100);
    check('…and the result says why, rather than implying punctuality',
      flex.notes.some(n => /could not be measured/i.test(n)),
      flex.notes.join(' | ').slice(0, 110));
    check('which is the honest outcome: a flexible shift is not judged on a start time',
      flex.total === perfect.total);

    // The fixture arrives at 11:30 EVERY day. Reporting that as '0 late days'
    // beside a card already saying punctuality could not be measured is the
    // same contradiction twice on one screen, and it reads as a clean record.
    eq('late days are NOT reported as zero when nothing was measured', flex.facts.late_days, null);
    check('and the note does not claim the shift has no start time, since it has one',
      !flex.notes.some(n => /no start time to be late against/i.test(n)),
      flex.notes.join(' | ').slice(0, 120));
    check('it points at the thing that would actually change it',
      flex.notes.some(n => /Schedules/i.test(n)),
      flex.notes.join(' | ').slice(0, 120));

    // A fixed shift still counts, or the null above would be hiding a real
    // regression rather than reporting a real absence of measurement.
    const stillCounted = (await score(f.latecomer))!;
    check('a measurable shift still reports a real late count',
      typeof stillCounted.facts.late_days === 'number' && stillCounted.facts.late_days > 0,
      String(stillCounted.facts.late_days));

    console.log('\n— policy weights change the marking —');
    const adminId = (await queryOne<{ id: number }>(
      `SELECT id FROM employees WHERE role = 'super_admin' LIMIT 1`))!.id;
    const punctualityHeavy = await createPolicy({
      name: 'ZZ Punctuality First', code: 'ZZPERF-P',
      score_weight_attendance: 10, score_weight_punctuality: 80, score_weight_hours: 10,
    }, adminId);
    await assignPolicy({
      employeeId: f.latecomer, policyId: punctualityHeavy.id,
      effectiveFrom: '2019-01-01', by: adminId,
    });

    const reweighted = (await score(f.latecomer))!;
    eq('the policy weight is applied', reweighted.components.punctuality.weight, 80);
    check('so the same behaviour now scores far lower',
      (reweighted.total ?? 100) < (late.total ?? 0),
      `${reweighted.total} under a punctuality-heavy policy vs ${late.total} under the default`);
    eq('and the policy is named on the score', reweighted.policy?.code, 'ZZPERF-P');

    console.log('\n— the ranking —');
    const report = await rankPerformance({ fromDate: FROM, toDate: TO });
    check('the fixture employees are ranked',
      report.ranked.some(s => s.employee.emp_id === 'ZZPF1'), `${report.ranked.length} ranked`);
    check('the ranking is in descending order',
      report.ranked.every((s, i) => i === 0 || (report.ranked[i - 1].total ?? 0) >= (s.total ?? 0)));
    check('nobody unrankable is in the league table',
      report.ranked.every(s => s.standing === 'counted' && s.total !== null));
    check('people with nothing to score are listed separately',
      report.unranked.every(s => s.standing !== 'counted' || s.total === null));
    check('a mixed-policy ranking says it is comparing different marking schemes',
      report.notes.some(n => /different policies/i.test(n)) || report.ranked.length < 2,
      report.notes.join(' | ').slice(0, 110));

    const scoped = await rankPerformance({ fromDate: FROM, toDate: TO, policyId: punctualityHeavy.id });
    eq('filtering to one policy narrows it to that policy', scoped.ranked.length, 1);
    eq('…to the right person', scoped.ranked[0]?.employee.emp_id, 'ZZPF5');
  } finally {
    await cleanup(f);
    const left = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM employees WHERE emp_id LIKE 'ZZPF%'`,
    );
    check('fixture cleaned up', Number(left?.n ?? 0) === 0, `${left?.n} left`);
    console.log(`\n${passed} passed, ${failed} failed`);
  }
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });

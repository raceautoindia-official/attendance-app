/**
 * scripts/verify-policy-effect.ts — what a policy actually DOES to the figures.
 *
 *   npx tsx --env-file=.env.local scripts/verify-policy-effect.ts
 *
 * Phase A proved a policy could be created and assigned without moving a single
 * number. This proves the opposite half: that once assigned, it moves exactly
 * the numbers it should and no others — and that removing it puts everything
 * back where it was.
 *
 * Builds its own month and removes it, including on failure.
 */

import { buildHoursLedger } from '../lib/hoursLedger';
import { buildPayrollPack } from '../lib/payrollExport';
import { createPolicy, assignPolicy, endAssignment, resolvePolicyFor } from '../lib/policy';
import { query, queryOne, pool } from '../lib/db';

const FROM = '2019-06-01';
const TO = '2019-06-30';
const MONTH = '2019-06';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
const hm = (m: number) => `${Math.floor(m / 60)}h ${m % 60}m`;

const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.parse(`${date}T00:00:00Z`) + (h * 60 + m - 330) * 60_000)
    .toISOString().slice(0, 19).replace('T', ' ');
};

interface Fixture { shiftId: number; employeeId: number; adminId: number; }

async function seed(adminId: number): Promise<Fixture> {
  const shift = (await query(
    `INSERT INTO shifts (name, type, start_time, end_time, grace_minutes, working_days)
     VALUES ('ZZpol_shift', 'fixed', '09:00:00', '18:00:00', 10,
             '["Mon","Tue","Wed","Thu","Fri","Sat"]')`,
  )) as unknown as { insertId: number };

  const e = (await query(
    `INSERT INTO employees (emp_id, name, pin_hash, role, is_active)
     VALUES ('ZZPOL1', 'ZZ Policy Subject', 'x', 'employee', 1)`,
  )) as unknown as { insertId: number };

  await query(
    `INSERT INTO employee_schedules (employee_id, shift_id, effective_from) VALUES (?, ?, '2019-01-01')`,
    [e.insertId, shift.insertId],
  );

  // A full June: 9h every Mon–Sat, arriving at 09:30 so lateness is measurable.
  for (let d = 1; d <= 30; d++) {
    const date = `2019-06-${String(d).padStart(2, '0')}`;
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) continue;
    await query(
      `INSERT INTO attendance (employee_id, work_date, status, clock_in_utc, first_clock_in_utc,
                               clock_out_utc, total_minutes, session_count, banked_minutes)
       VALUES (?, ?, 'present', ?, ?, ?, 540, 1, 0)`,
      [e.insertId, date, at(date, '09:30'), at(date, '09:30'), at(date, '18:30')],
    );
  }
  return { shiftId: shift.insertId, employeeId: e.insertId, adminId };
}

async function cleanup(f: Fixture | null) {
  if (!f) return;
  await query(`DELETE FROM employee_policies WHERE employee_id = ?`, [f.employeeId]);
  await query(`DELETE FROM attendance WHERE employee_id = ?`, [f.employeeId]);
  await query(`DELETE FROM employee_schedules WHERE employee_id = ?`, [f.employeeId]);
  await query(`DELETE FROM employees WHERE id = ?`, [f.employeeId]);
  if (f.shiftId) await query(`DELETE FROM shifts WHERE id = ?`, [f.shiftId]);
  await query(`DELETE FROM policies WHERE code LIKE 'ZZEFF%'`);
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
    await query(`DELETE FROM policies WHERE code LIKE 'ZZEFF%'`);

    const admin = await queryOne<{ id: number }>(
      `SELECT id FROM employees WHERE role = 'super_admin' AND is_active = 1 LIMIT 1`,
    );
    if (!admin) { check('a super_admin exists', false); return; }
    f = await seed(admin.id);

    // June 2019: 30 days, Sundays on 2/9/16/23/30 → 25 Mon–Sat working days.
    const WORKING = 25;
    const ROSTER_REQUIRED = WORKING * 540;

    console.log('\n— with no policy, nothing has changed —');
    const bare = (await buildHoursLedger({ employeeId: f.employeeId, fromDate: FROM, toDate: TO }))!;
    eq('required is roster-derived', bare.totals.required_minutes, ROSTER_REQUIRED);
    eq('working days', bare.totals.working_days, WORKING);
    eq('no policy is reported', bare.assigned_policy, null);
    check('the stated standard is the global default',
      bare.standard.stated_minutes > 0, hm(bare.standard.stated_minutes));
    eq('late minutes accrue against the shift grace of 10',
      bare.totals.late_minutes, WORKING * 20);

    console.log('\n— a ROSTER policy changes the stated norm, not the requirement —');
    const roster = await createPolicy({
      name: 'ZZ Effect Roster', code: 'ZZEFF-R', monthly_hours: 200,
      pf_applicable: true, esi_applicable: true, professional_tax_applicable: true,
      casual_leave_days: 12,
    }, admin.id);
    await assignPolicy({
      employeeId: f.employeeId, policyId: roster.id, effectiveFrom: '2019-01-01', by: admin.id,
    });

    const withRoster = (await buildHoursLedger({ employeeId: f.employeeId, fromDate: FROM, toDate: TO }))!;
    eq('the REQUIREMENT is untouched — the roster still decides',
      withRoster.totals.required_minutes, ROSTER_REQUIRED);
    eq('but the stated standard is now the policy figure',
      withRoster.standard.stated_minutes, 200 * 60);
    eq('so the difference against the norm is visible',
      withRoster.standard.difference_minutes, ROSTER_REQUIRED - 200 * 60);
    eq('the policy is reported', withRoster.assigned_policy?.code, 'ZZEFF-R');
    check('with its statutory flags',
      withRoster.assigned_policy?.statutory.join(',') === 'PF,ESI,Professional Tax',
      withRoster.assigned_policy?.statutory.join(', ') ?? '');
    eq('and its leave entitlement', withRoster.assigned_policy?.leave_entitlement.casual, 12);
    eq('worked minutes are of course unchanged',
      withRoster.totals.worked_minutes, bare.totals.worked_minutes);

    console.log('\n— a grace override changes lateness —');
    const graced = await createPolicy({
      name: 'ZZ Effect Grace', code: 'ZZEFF-G', late_grace_minutes: 45,
    }, admin.id);
    await assignPolicy({
      employeeId: f.employeeId, policyId: graced.id, effectiveFrom: '2019-01-01', by: admin.id,
    });
    const withGrace = (await buildHoursLedger({ employeeId: f.employeeId, fromDate: FROM, toDate: TO }))!;
    eq('arriving 30 minutes late is within a 45-minute grace, so nobody is late',
      withGrace.totals.late_minutes, 0);
    eq('…and the requirement is still untouched',
      withGrace.totals.required_minutes, ROSTER_REQUIRED);

    console.log('\n— a FIXED-MONTHLY policy replaces the requirement —');
    const fixed = await createPolicy({
      name: 'ZZ Effect Fixed', code: 'ZZEFF-F',
      hours_basis: 'fixed_monthly', monthly_hours: 200,
    }, admin.id);
    await assignPolicy({
      employeeId: f.employeeId, policyId: fixed.id, effectiveFrom: '2019-01-01', by: admin.id,
    });
    const withFixed = (await buildHoursLedger({ employeeId: f.employeeId, fromDate: FROM, toDate: TO }))!;
    eq('the month now requires exactly the policy figure',
      withFixed.totals.required_minutes, 200 * 60);
    check('which is LESS than the roster would have asked',
      withFixed.totals.required_minutes < ROSTER_REQUIRED,
      `${hm(withFixed.totals.required_minutes)} vs ${hm(ROSTER_REQUIRED)}`);

    // The invariant the whole restructure existed to protect.
    eq('the day requirements still sum to the month exactly',
      withFixed.days.reduce((n, d) => n + (d.required_minutes ?? 0), 0),
      withFixed.totals.required_minutes);
    eq('day shortages still sum to the total',
      withFixed.days.reduce((n, d) => n + d.shortage_minutes, 0),
      withFixed.totals.shortage_minutes);
    check('no week off or holiday was given a requirement',
      withFixed.days.filter(d => d.kind !== 'working').every(d => (d.required_minutes ?? 0) === 0));
    check('a warning explains the figure is fixed rather than derived',
      withFixed.warnings.some(w => /fixed .*a month/i.test(w)),
      withFixed.warnings.join(' | ').slice(0, 120));

    const perDay = withFixed.days.filter(d => d.kind === 'working').map(d => d.required_minutes ?? 0);
    check('the spread is even, give or take the rounding remainder',
      Math.max(...perDay) - Math.min(...perDay) <= 1,
      `${Math.min(...perDay)}–${Math.max(...perDay)} minutes a day`);

    console.log('\n— a week-off mismatch is flagged, never corrected —');
    const weekoff = await createPolicy({
      name: 'ZZ Effect WeekOff', code: 'ZZEFF-W', week_offs_per_month: 8,
    }, admin.id);
    await assignPolicy({
      employeeId: f.employeeId, policyId: weekoff.id, effectiveFrom: '2019-01-01', by: admin.id,
    });
    const withWeekoff = (await buildHoursLedger({ employeeId: f.employeeId, fromDate: FROM, toDate: TO }))!;
    check('the mismatch is reported',
      withWeekoff.warnings.some(w => /week off/i.test(w) && /expects 8/.test(w)),
      withWeekoff.warnings.find(w => /week off/i.test(w)) ?? 'none');
    eq('the roster still decides how many there actually were',
      withWeekoff.totals.week_off_days, bare.totals.week_off_days);

    console.log('\n— the payroll pack carries which rules applied —');
    const pack = await buildPayrollPack(MONTH);
    const row = pack.rows.find(r => r.emp_id === 'ZZPOL1');
    check('the row names the policy', Boolean(row?.policy.includes('ZZEFF-W')), row?.policy ?? 'missing');
    const beforeChecksum = pack.checksum;
    // Renaming a policy must not make an already-filed pack look falsified.
    await query(`UPDATE policies SET name = 'ZZ Renamed' WHERE code = 'ZZEFF-W'`);
    const repack = await buildPayrollPack(MONTH);
    eq('renaming a policy does NOT change the checksum', repack.checksum, beforeChecksum);
    check('…though the pack shows the new name',
      Boolean(repack.rows.find(r => r.emp_id === 'ZZPOL1')?.policy.includes('ZZ Renamed')));

    console.log('\n— removing the policy restores the original figures exactly —');
    await endAssignment({ employeeId: f.employeeId, effectiveTo: '2018-12-31', by: admin.id });
    eq('no policy resolves any more',
      await resolvePolicyFor(f.employeeId, '2019-06-15'), null);
    const after = (await buildHoursLedger({ employeeId: f.employeeId, fromDate: FROM, toDate: TO }))!;
    eq('required is back to roster-derived', after.totals.required_minutes, ROSTER_REQUIRED);
    eq('late minutes are back', after.totals.late_minutes, bare.totals.late_minutes);
    eq('the stated standard is the global one again',
      after.standard.stated_minutes, bare.standard.stated_minutes);
    check('the whole ledger matches the pre-policy state',
      JSON.stringify(after) === JSON.stringify(bare),
      'a policy is fully reversible, which is what makes it safe to try one');
  } finally {
    await cleanup(f);
    const left = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM employees WHERE emp_id = 'ZZPOL1'`,
    );
    check('fixture cleaned up', Number(left?.n ?? 0) === 0);
    console.log(`\n${passed} passed, ${failed} failed`);
  }
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });

/**
 * scripts/verify-policy-shift.ts — a policy that moves somebody's shift.
 *
 *   npx tsx --env-file=.env.local scripts/verify-policy-shift.ts
 *
 * Assigning a policy can also put the employee on the shift that policy names.
 * The thing being proved is that it does so by writing a REAL dated row in
 * employee_schedules, because:
 *
 *  - clock-in, clock-out, today and day all read that table, and the mobile app
 *    calls them. A shift that existed only in the web ledger would mean the
 *    phone and the website disagreed about the same person on the same day.
 *  - shift lookup is date-ranged, so a past month resolves the shift in force
 *    THEN. A policy that decided the shift while figures were calculated would
 *    rewrite what somebody worked in a month already closed and paid.
 *
 * Everything it creates is prefixed ZZPS and removed at the end.
 */

import {
  assignPolicy, previewPolicyShiftMoves, createPolicy, syncPolicyDefaultShift,
} from '../lib/policy';
import { shiftsForDay } from '../lib/shifts';
import { query, queryOne, pool } from '../lib/db';
import { NextRequest } from 'next/server';
import { POST as createEmployeeRoute } from '../app/api/employees/route';
import { POST as assignRoute } from '../app/api/policies/assign/route';
import { signAccessToken, currentTokenVersion } from '../lib/auth';
import { resolvePolicyFor } from '../lib/policy';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

async function cleanup() {
  await query(
    `DELETE es FROM employee_schedules es JOIN employees e ON e.id = es.employee_id
      WHERE e.emp_id LIKE 'ZZPS%'`);
  await query(
    `DELETE ep FROM employee_policies ep JOIN employees e ON e.id = ep.employee_id
      WHERE e.emp_id LIKE 'ZZPS%'`);
  await query(`DELETE FROM employees WHERE emp_id LIKE 'ZZPS%'`);
  await query(`DELETE FROM policies WHERE code LIKE 'ZZPS-%'`);
  await query(`DELETE FROM shifts WHERE name LIKE 'ZZps_%'`);
}

async function main() {
  try {
    await cleanup();

    const mkShift = async (name: string, type: string) => ((await query(
      `INSERT INTO shifts (name, type, start_time, end_time, required_hours, grace_minutes, working_days)
       VALUES (?, ?, '09:00:00', '18:00:00', ?, 10, '["Mon","Tue","Wed","Thu","Fri","Sat"]')`,
      [name, type, type === 'flexible' ? 9 : null],
    )) as unknown as { insertId: number }).insertId;

    const flexShift = await mkShift('ZZps_flex', 'flexible');
    const fixedShift = await mkShift('ZZps_fixed', 'fixed');

    // A location and geofencing on the ORIGINAL schedule row: both live on the
    // schedule, not on the employee, so a careless move silently drops them.
    const loc = await queryOne<{ id: number }>(`SELECT id FROM locations LIMIT 1`);
    const mkEmp = async (empId: string, name: string, shiftId: number) => {
      const r = (await query(
        `INSERT INTO employees (emp_id, name, pin_hash, role, is_active) VALUES (?, ?, 'x', 'employee', 1)`,
        [empId, name],
      )) as unknown as { insertId: number };
      await query(
        `INSERT INTO employee_schedules
           (employee_id, shift_id, location_id, geofencing_enabled, effective_from)
         VALUES (?, ?, ?, 1, '2019-01-01')`,
        [r.insertId, shiftId, loc?.id ?? null],
      );
      return r.insertId;
    };

    const mover = await mkEmp('ZZPS1', 'ZZ Mover', flexShift);
    const already = await mkEmp('ZZPS2', 'ZZ Already There', fixedShift);

    const withShift = await createPolicy(
      { name: 'ZZ With Shift', code: 'ZZPS-SHIFT', default_shift_id: fixedShift } as never, 1,
    );
    const noShift = await createPolicy(
      { name: 'ZZ No Shift', code: 'ZZPS-NONE' } as never, 1,
    );

    const FROM = '2026-10-15';

    console.log('\n— the preview changes nothing —');
    const preview = await previewPolicyShiftMoves({
      employeeIds: [mover, already], policyId: withShift.id, effectiveFrom: FROM,
    });
    eq('only the employee actually on another shift is listed', preview.length, 1);
    eq('…and it is the right one', preview[0]?.employee_id, mover);
    eq('from the shift they are really on', preview[0]?.from_shift_name, 'ZZps_flex');
    eq('to the one the policy names', preview[0]?.to_shift_name, 'ZZps_fixed');
    const stillFlex = await shiftsForDay(mover, FROM);
    eq('and nobody has moved yet', stillFlex[0]?.name, 'ZZps_flex');

    console.log('\n— a policy with no default shift moves nobody —');
    const none = await previewPolicyShiftMoves({
      employeeIds: [mover], policyId: noShift.id, effectiveFrom: FROM,
    });
    eq('nothing to preview', none.length, 0);

    console.log('\n— assigning WITHOUT the flag still changes no shift —');
    await assignPolicy({ employeeId: mover, policyId: withShift.id, effectiveFrom: FROM, by: 1 });
    const unmoved = await shiftsForDay(mover, FROM);
    eq('the shift is untouched', unmoved[0]?.name, 'ZZps_flex');

    // The case that matters most: the policy is already assigned and the
    // mismatch is noticed afterwards. Assignment refuses a duplicate, so sync
    // is the only route - and it has to work without one.
    console.log('\n— syncing an ALREADY-assigned employee moves them —');
    const dup = await assignPolicy({
      employeeId: mover, policyId: withShift.id, effectiveFrom: '2026-10-16',
      by: 1, applyDefaultShift: true,
    }).then(() => null).catch((e: Error) => e.message);
    check('re-assigning the same policy is still refused', Boolean(dup), String(dup));

    // Put the already-correct employee on the policy too, so the sync has a
    // policy to read and the 'nothing to do' answer is the real one.
    await assignPolicy({
      employeeId: already, policyId: withShift.id, effectiveFrom: '2026-10-01', by: 1,
    });

    const synced = await syncPolicyDefaultShift({
      employeeIds: [mover, already], effectiveFrom: '2026-10-16', by: 1,
    });
    eq('the mismatched employee is moved',
      synced.find(r => r.employee_id === mover)?.moved, true);
    eq('somebody already on the shift is reported, not moved',
      synced.find(r => r.employee_id === already)?.moved, false);
    eq('…and says why', synced.find(r => r.employee_id === already)?.reason, 'Already on that shift.');
    const moved = await shiftsForDay(mover, '2026-10-16');
    eq('the employee is on the policy shift', moved[0]?.name, 'ZZps_fixed');
    eq('exactly one shift is in force', moved.length, 1);

    // The whole point: the row is real, so everything reading that table sees it.
    const row = await queryOne<{ shift_id: number; location_id: number | null; geofencing_enabled: number }>(
      `SELECT shift_id, location_id, geofencing_enabled FROM employee_schedules
        WHERE employee_id = ? AND effective_from = '2026-10-16'`, [mover]);
    check('a row exists in employee_schedules, which the mobile app reads', Boolean(row));
    eq('…pointing at the right shift', row?.shift_id, fixedShift);
    eq('…keeping the location from the previous row', row?.location_id, loc?.id ?? null);
    eq('…and keeping geofencing on', Number(row?.geofencing_enabled), 1);

    console.log('\n— the past is left alone —');
    const before = await shiftsForDay(mover, '2026-10-14');
    eq('the day before the move still reads the OLD shift', before[0]?.name, 'ZZps_flex');
    const old = await queryOne<{ effective_to: Date | string | null }>(
      `SELECT effective_to FROM employee_schedules
        WHERE employee_id = ? AND effective_from = '2019-01-01'`, [mover]);
    check('the old row was closed rather than deleted', Boolean(old?.effective_to),
      String(old?.effective_to));

    console.log('\n— somebody already on that shift is not churned —');
    const rows = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM employee_schedules WHERE employee_id = ?`, [already]);
    eq('no second schedule row was written', Number(rows[0]?.n), 1);

    // The real-world batch: most people are new to the policy, one is already
    // on it. Assignment rejects the duplicate, and if that also skipped the
    // shift move, the one person whose shift most needed fixing would be the
    // only one left behind - while the screen said 'assigned' and looked fine.
    console.log('\n— a mixed batch: some new to the policy, one already on it —');
    {
      const fresh = await mkEmp('ZZPS3', 'ZZ Fresh', flexShift);
      const admin = await queryOne<{ id: number }>(
        `SELECT id FROM employees WHERE role = 'super_admin' AND is_active = 1 LIMIT 1`);
      const tv = await currentTokenVersion(admin!.id);
      const token = signAccessToken(
        { id: admin!.id, emp_id: 'x', role: 'super_admin', tv } as never);

      // `mover` is already on withShift from the sync above; `fresh` is not.
      const res = await assignRoute(new NextRequest('http://localhost:3000/api/policies/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `access_token=${token}` },
        body: JSON.stringify({
          employee_ids: [fresh, mover], policy_id: withShift.id,
          effective_from: '2026-10-25', apply_default_shift: true,
        }),
      }));
      eq('the batch succeeds', res.status, 200);
      const d = (await res.json()).data as {
        assigned: number[]; skipped: Array<{ employee_id: number }>; shift_synced: number[];
      };
      eq('the new one is assigned', d.assigned.includes(fresh), true);
      eq('the duplicate is still reported as skipped', d.skipped.length, 1);

      // Both must end up on the policy's shift, however they got there.
      const freshShift = await shiftsForDay(fresh, '2026-10-25');
      eq('the newly assigned one moved', freshShift[0]?.name, 'ZZps_fixed');
      await query(
        `UPDATE employee_schedules SET shift_id = ? WHERE employee_id = ? AND effective_to IS NULL`,
        [flexShift, mover]);
      const res2 = await assignRoute(new NextRequest('http://localhost:3000/api/policies/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `access_token=${token}` },
        body: JSON.stringify({
          employee_ids: [mover], policy_id: withShift.id,
          effective_from: '2026-10-26', apply_default_shift: true,
        }),
      }));
      const d2 = (await res2.json()).data as { shift_synced: number[] };
      eq('the already-assigned one has their shift synced', d2.shift_synced.includes(mover), true);
      const moverShift = await shiftsForDay(mover, '2026-10-26');
      eq('…and really is on the policy shift', moverShift[0]?.name, 'ZZps_fixed');
    }

    console.log('\n— a new employee created ON a policy —');
    {
      const admin = await queryOne<{ id: number }>(
        `SELECT id FROM employees WHERE role = 'super_admin' AND is_active = 1 LIMIT 1`);
      const tv = await currentTokenVersion(admin!.id);
      const token = signAccessToken(
        { id: admin!.id, emp_id: 'x', role: 'super_admin', tv } as never);
      const res = await createEmployeeRoute(new NextRequest('http://localhost:3000/api/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `access_token=${token}` },
        body: JSON.stringify({
          emp_id: 'ZZPS9', name: 'ZZ New Starter', pin: '1234', role: 'employee',
          policy_id: withShift.id, schedule_effective_from: '2026-10-20',
        }),
      }));
      eq('the employee is created', res.status, 201);
      const created = (await res.json()).data as { id: number; notes?: string[] };

      // No shift was chosen, so the policy's own shift is the one they get -
      // otherwise a new starter has a policy, no roster, and no required hours.
      const sh = await shiftsForDay(created.id, '2026-10-20');
      eq('they are rostered on the shift the policy names', sh[0]?.name, 'ZZps_fixed');
      check('and the response says where that shift came from',
        (created.notes ?? []).some(n => /from policy/i.test(n)),
        (created.notes ?? []).join(' | '));

      const assigned = await resolvePolicyFor(created.id, '2026-10-20');
      eq('and the policy is actually assigned', assigned?.code, 'ZZPS-SHIFT');
    }

    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    await cleanup();
  }
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });

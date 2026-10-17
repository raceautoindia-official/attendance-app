/**
 * scripts/verify-employee-department.ts — department chosen, not typed.
 *
 *   npx tsx --env-file=.env.local scripts/verify-employee-department.ts
 *
 * The employee forms used to take the department as free text, and this
 * database shows what that produced: an employee id and a phone number stored
 * as department names across five people, while sixteen were in no department
 * at all in the org chart that access control actually reads.
 *
 * So the create and update endpoints now accept `department_id`, derive the
 * legacy name from it, and PLACE the person. Three things have to hold, and
 * each has already been wrong once in development:
 *
 *   The legacy name column still gets written, because the mobile app reads it.
 *   A chosen department produces a dated org placement, so nobody who was
 *     given a department is in the unplaced queue.
 *   Saving an unrelated field does NOT write a second placement - assignments
 *     are dated history, and a duplicate row per save makes it unreadable.
 *
 * It also proves what is NOT accepted: an id that does not exist comes back as
 * a message, not a 500, and not silence.
 */

import { NextRequest } from 'next/server';
import { POST as createEmployee } from '../app/api/employees/route';
import { PUT as updateEmployee } from '../app/api/employees/[id]/route';
import { POST as deptPost } from '../app/api/org/departments/route';
import { signAccessToken, currentTokenVersion } from '../lib/auth';
import { listAssignments } from '../lib/org';
import { getWorkDateIST } from '../lib/attendance';
import { query, queryOne, pool } from '../lib/db';

let passed = 0;
let failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`); }
};
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

const EMPLOYEES = 'http://localhost:3000/api/employees';
const DEPTS = 'http://localhost:3000/api/org/departments';

function post(token: string, body: unknown, url = EMPLOYEES) {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `access_token=${token}` },
    body: JSON.stringify(body),
  });
}

function put(token: string, id: number, body: unknown) {
  return new NextRequest(`${EMPLOYEES}/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: `access_token=${token}` },
    body: JSON.stringify(body),
  });
}

const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

async function adminToken() {
  const e = await queryOne<{ id: number; emp_id: string; role: string }>(
    `SELECT id, emp_id, role FROM employees WHERE role = 'super_admin' AND is_active = 1 LIMIT 1`);
  if (!e) throw new Error('no active super_admin to act as');
  const tv = await currentTokenVersion(e.id);
  return signAccessToken({ id: e.id, emp_id: e.emp_id, role: e.role, tv } as never);
}

async function cleanup() {
  await query(
    `DELETE a FROM employee_org_assignments a JOIN employees e ON e.id = a.employee_id
      WHERE e.emp_id LIKE 'ZZDEP%'`);
  await query(`DELETE FROM employee_schedules WHERE employee_id IN (SELECT id FROM employees WHERE emp_id LIKE 'ZZDEP%')`);
  await query(`DELETE FROM employees WHERE emp_id LIKE 'ZZDEP%'`);
  await query(`DELETE FROM departments WHERE code LIKE 'ZZDEP%' ORDER BY depth DESC`);
}

async function main() {
  try {
    await cleanup();
    const admin = await adminToken();

    // Two departments to move somebody between.
    const first = await (await deptPost(post(admin, { name: 'ZZDEP First', code: 'ZZDEP1' }, DEPTS))).json();
    const second = await (await deptPost(post(admin, { name: 'ZZDEP Second', code: 'ZZDEP2' }, DEPTS))).json();
    const firstId = first?.data?.department?.id as number;
    const secondId = second?.data?.department?.id as number;
    check('two departments to move between', Boolean(firstId && secondId), `${firstId}, ${secondId}`);

    console.log('\n— creating somebody in a department —');
    const created = await createEmployee(post(admin, {
      emp_id: 'ZZDEP001', name: 'ZZDEP Person', pin: '4821',
      role: 'employee', department_id: firstId,
    }));
    eq('the employee is created', created.status, 201);
    const createdBody = await created.json();
    const employeeId = createdBody?.data?.id as number;
    check('an id came back', Boolean(employeeId), String(employeeId));

    const row = await queryOne<{ department: string | null }>(
      'SELECT department FROM employees WHERE id = ?', [employeeId]);
    eq('the legacy name column is written from the chosen department',
      row?.department, 'ZZDEP First');

    const today = getWorkDateIST();
    const placed = await listAssignments({ employeeId, onDate: today });
    eq('exactly one placement exists', placed.length, 1);
    eq('and it is the department that was chosen', placed[0]?.department_id, firstId);

    console.log('\n— moving them —');
    const moved = await updateEmployee(put(admin, employeeId, {
      department: 'ZZDEP Second', department_id: secondId,
    }), ctx(employeeId));
    eq('the update succeeds', moved.status, 200);

    const afterMove = await queryOne<{ department: string | null }>(
      'SELECT department FROM employees WHERE id = ?', [employeeId]);
    eq('the name column follows', afterMove?.department, 'ZZDEP Second');

    const movedPlacement = await listAssignments({ employeeId, onDate: today });
    eq('still one CURRENT placement', movedPlacement.length, 1);
    eq('now in the second department', movedPlacement[0]?.department_id, secondId);

    // Two corrections on the SAME day leave one row, not two: a day with two
    // open placements has no answer to "which department were they in".
    const sameDay = await query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM employee_org_assignments WHERE employee_id = ?', [employeeId]);
    eq('a same-day correction replaces rather than stacks', Number(sameDay[0]?.n), 1);

    console.log('\n— moving them on a later day —');
    // Backdate the current placement, then move them through the API today.
    // History is the whole point of dating these: last month's reports must
    // keep reporting last month's department.
    await query(
      `UPDATE employee_org_assignments SET effective_from = DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        WHERE employee_id = ? AND effective_to IS NULL`, [employeeId]);
    const movedAgain = await updateEmployee(put(admin, employeeId, {
      department: 'ZZDEP First', department_id: firstId,
    }), ctx(employeeId));
    eq('the later move succeeds', movedAgain.status, 200);

    const rows = await query<{ department_id: number; effective_to: string | null }>(
      `SELECT department_id, effective_to FROM employee_org_assignments
        WHERE employee_id = ? ORDER BY effective_from`, [employeeId]);
    eq('the old placement is kept beside the new one', rows.length, 2);
    eq('the old one is closed', rows[0]?.effective_to !== null, true);
    eq('and it still says where they were', rows[0]?.department_id, secondId);
    eq('the open one is where they are now', rows[1]?.department_id, firstId);
    eq('and it is open', rows[1]?.effective_to, null);

    const todayOnly = await listAssignments({ employeeId, onDate: today });
    eq('today reads as one placement', todayOnly.length, 1);
    eq('the current one', todayOnly[0]?.department_id, firstId);

    console.log('\n— saving something else —');
    const before = Number((await query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM employee_org_assignments WHERE employee_id = ?', [employeeId]))[0]?.n);
    const renamed = await updateEmployee(put(admin, employeeId, {
      name: 'ZZDEP Person Renamed', department: 'ZZDEP First', department_id: firstId,
    }), ctx(employeeId));
    eq('the unrelated edit succeeds', renamed.status, 200);
    const after = Number((await query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM employee_org_assignments WHERE employee_id = ?', [employeeId]))[0]?.n);
    eq('no second placement is written for the same department', after, before);

    console.log('\n— what is refused —');
    const bogus = await updateEmployee(put(admin, employeeId, { department_id: 999_999 }), ctx(employeeId));
    eq('an unknown department is a 400, not a 500', bogus.status, 400);
    eq('and it says so', (await bogus.json())?.error, 'No such department');

    const bogusCreate = await createEmployee(post(admin, {
      emp_id: 'ZZDEP002', name: 'ZZDEP Nobody', pin: '4821',
      role: 'employee', department_id: 999_999,
    }));
    eq('creating into an unknown department is refused too', bogusCreate.status, 400);
    const stillAbsent = await queryOne<{ id: number }>(
      `SELECT id FROM employees WHERE emp_id = 'ZZDEP002'`);
    check('and the employee was not created anyway', stillAbsent === null || stillAbsent === undefined);

    console.log('\n— a department the forms no longer offer —');
    // Legacy rows must still round-trip: the five people filed under a phone
    // number can be edited without the save being rejected.
    const legacy = await updateEmployee(put(admin, employeeId, {
      department: '7305408577',
    }), ctx(employeeId));
    eq('a free-text name with no id still saves', legacy.status, 200);
    const legacyRow = await queryOne<{ department: string | null }>(
      'SELECT department FROM employees WHERE id = ?', [employeeId]);
    eq('and is stored as given', legacyRow?.department, '7305408577');
    const unchanged = await listAssignments({ employeeId, onDate: today });
    eq('without disturbing the placement', unchanged[0]?.department_id, firstId);
  } finally {
    await cleanup();
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });

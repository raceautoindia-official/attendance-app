/**
 * scripts/verify-access-enforcement.ts — the scope, applied to a real endpoint.
 *
 *   npx tsx --env-file=.env.local scripts/verify-access-enforcement.ts
 *
 * verify-access.ts proves the arithmetic: given a role and a tree, who should
 * be visible. This proves the part that actually protects anybody — that the
 * employees endpoint narrows its SQL accordingly.
 *
 * The two outcomes that matter are opposites, and both are easy to get wrong:
 *
 *   WITH an explicit role, the list must be narrowed. A scope that is computed
 *   and then not used is worse than none, because it reads as protection.
 *
 *   WITHOUT one, nothing must change. Every current user is on the legacy
 *   fallback, so enforcing against that would silently re-scope the whole
 *   company the moment this shipped.
 *
 * Everything it creates is prefixed ZZEN and removed at the end.
 */

import { NextRequest } from 'next/server';
import { GET as employeesGet } from '../app/api/employees/route';
import { saveDepartment, assignToOrg } from '../lib/org';
import { narrowToVisible } from '../lib/accessFilter';
import { signAccessToken, currentTokenVersion } from '../lib/auth';
import { query, queryOne, pool } from '../lib/db';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

async function tokenForId(id: number) {
  const e = (await queryOne<{ id: number; emp_id: string; role: string }>(
    `SELECT id, emp_id, role FROM employees WHERE id = ?`, [id]))!;
  const tv = await currentTokenVersion(e.id);
  return signAccessToken({ id: e.id, emp_id: e.emp_id, role: e.role, tv } as never);
}

function listReq(token: string) {
  return new NextRequest('http://localhost:3000/api/employees?limit=300', {
    headers: { Cookie: `access_token=${token}` },
  });
}

async function cleanup() {
  await query(`DELETE er FROM employee_roles er JOIN employees e ON e.id = er.employee_id WHERE e.emp_id LIKE 'ZZEN%'`);
  await query(`DELETE a FROM employee_org_assignments a JOIN employees e ON e.id = a.employee_id WHERE e.emp_id LIKE 'ZZEN%'`);
  await query(`UPDATE employees SET manager_id = NULL WHERE emp_id LIKE 'ZZEN%'`);
  await query(`UPDATE departments SET head_employee_id = NULL WHERE code LIKE 'ZZEN%'`);
  await query(`DELETE FROM employees WHERE emp_id LIKE 'ZZEN%'`);
  await query(`DELETE FROM departments WHERE code LIKE 'ZZEN%' ORDER BY depth DESC`);
  await query(`DELETE rp FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code LIKE 'ZZEN%'`);
  await query(`DELETE FROM roles WHERE code LIKE 'ZZEN%'`);
}

async function main() {
  const ACTOR = (await queryOne<{ id: number }>(
    `SELECT id FROM employees WHERE role = 'super_admin' AND is_active = 1 LIMIT 1`))!.id;
  try {
    await cleanup();

    const mk = async (empId: string, name: string, role = 'employee') => ((await query(
      `INSERT INTO employees (emp_id, name, pin_hash, role, is_active) VALUES (?, ?, 'x', ?, 1)`,
      [empId, name, role])) as unknown as { insertId: number }).insertId;

    const mgr = await mk('ZZEN1', 'ZZEN Manager', 'manager');
    const inside = await mk('ZZEN2', 'ZZEN Inside');
    const below = await mk('ZZEN3', 'ZZEN Below');
    const outside = await mk('ZZEN4', 'ZZEN Outside');

    const dept = await saveDepartment({ name: 'ZZEN Dept', code: 'ZZEN-D' }, ACTOR);
    const sub = await saveDepartment({ name: 'ZZEN Sub', code: 'ZZEN-S', parent_id: dept.id }, ACTOR);
    const other = await saveDepartment({ name: 'ZZEN Other', code: 'ZZEN-O' }, ACTOR);
    await saveDepartment({ id: dept.id, name: 'ZZEN Dept', code: 'ZZEN-D',
      head_employee_id: mgr }, ACTOR);

    await assignToOrg({ employeeId: inside, departmentId: dept.id, effectiveFrom: '2026-01-01', by: ACTOR });
    await assignToOrg({ employeeId: below, departmentId: sub.id, effectiveFrom: '2026-01-01', by: ACTOR });
    await assignToOrg({ employeeId: outside, departmentId: other.id, effectiveFrom: '2026-01-01', by: ACTOR });

    console.log('\n— before any role is granted, nothing changes —');
    const beforeNarrow = await narrowToVisible(mgr, 'employee.view', 'e.id');
    eq('no narrowing is applied', beforeNarrow.applied, false);
    eq('and the fragment restricts nothing', beforeNarrow.sql, '1 = 1');

    const mgrToken = await tokenForId(mgr);
    const before = await employeesGet(listReq(mgrToken));
    eq('the endpoint still answers', before.status, 200);
    const beforeRows = (await before.json()).data.employees as Array<{ id: number }>;
    // The legacy rule is "direct reports", and nobody reports to them, so the
    // list is empty. The point is that it is the OLD behaviour, unchanged.
    check('the legacy manager rule still governs it',
      !beforeRows.some(r => r.id === outside), `${beforeRows.length} rows`);

    console.log('\n— granting a department-scoped role changes what they see —');
    const roleId = ((await query(
      `INSERT INTO roles (code, name, is_system) VALUES ('ZZEN-DEPT', 'ZZEN Dept Viewer', FALSE)`,
    )) as unknown as { insertId: number }).insertId;
    await query(
      `INSERT INTO role_permissions (role_id, permission_id, scope)
       SELECT ?, id, 'department' FROM permissions WHERE perm_key = 'employee.view'`, [roleId]);
    await query(`INSERT INTO employee_roles (employee_id, role_id) VALUES (?, ?)`, [mgr, roleId]);

    const narrowed = await narrowToVisible(mgr, 'employee.view', 'e.id');
    eq('narrowing is now applied', narrowed.applied, true);
    check('and it is a real id list, not a pass-through',
      narrowed.sql.includes('IN (') && narrowed.params.length > 0,
      `${narrowed.params.length} ids`);
    check('with a note saying the list is limited',
      Boolean(narrowed.note) && /department/i.test(narrowed.note!), narrowed.note ?? '');

    const after = await employeesGet(listReq(mgrToken));
    const rows = (await after.json()).data.employees as Array<{ id: number; name: string }>;
    const ids = rows.map(r => r.id);

    check('they see somebody in their department', ids.includes(inside), `[${ids}]`);
    check('and somebody in a department below it', ids.includes(below));
    check('and themselves', ids.includes(mgr));
    // The one that matters. A scope computed but not applied would show this.
    check('but NOT somebody in another department', !ids.includes(outside),
      ids.includes(outside) ? 'LEAKED' : 'correctly hidden');

    console.log('\n— a role granting nothing sees nothing, not everything —');
    const emptyRoleId = ((await query(
      `INSERT INTO roles (code, name, is_system) VALUES ('ZZEN-NONE', 'ZZEN No Grants', FALSE)`,
    )) as unknown as { insertId: number }).insertId;
    await query(`INSERT INTO employee_roles (employee_id, role_id) VALUES (?, ?)`, [inside, emptyRoleId]);

    const nothing = await narrowToVisible(inside, 'employee.view', 'e.id');
    eq('narrowing applies', nothing.applied, true);
    // The direction a mistake must fail in: no rows, never all rows.
    eq('and it matches no rows at all', nothing.sql, '1 = 0');

    console.log('\n— a super admin is never narrowed —');
    const sa = await narrowToVisible(ACTOR, 'employee.view', 'e.id');
    eq('no narrowing', sa.applied, false);
    eq('and no note, because nothing is hidden', sa.note, null);

    console.log('\n— everybody else is still on the old behaviour —');
    const untouched = await narrowToVisible(outside, 'employee.view', 'e.id');
    eq('somebody with no explicit role is not narrowed', untouched.applied, false);
    check('which is what makes this safe to ship before the org chart is filled in',
      untouched.sql === '1 = 1');

    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    await cleanup();
  }
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });

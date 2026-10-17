/**
 * scripts/verify-access.ts — who can see whom.
 *
 *   npx tsx --env-file=.env.local scripts/verify-access.ts
 *
 * The department scope walks the org tree, and getting it wrong does not throw
 * — it quietly returns somebody else's people. So this suite does not check
 * that a manager can see their team. It checks that they CANNOT see anybody
 * else, from every direction it can think of:
 *
 *   - a sibling department, which is the obvious leak
 *   - a PARENT department, which is the one people get wrong: seeing downward
 *     must not mean seeing upward
 *   - somebody unplaced, who belongs to no department at all
 *   - a manager who is themselves unplaced, where the tempting shortcut
 *     ("no department filter") would return the whole company
 *
 * It also pins the two defaults that make this safe to ship: no grant means no
 * rows rather than no filter, and an employee with no explicit role behaves
 * exactly as they did before the tables existed.
 *
 * Everything it creates is prefixed ZZAC and removed at the end.
 */

import {
  resolveAccess, can, scopeOf, visibleEmployeeIds, employeeScopeSql,
  assertCan, ForbiddenError, listRoles, listPermissions,
} from '../lib/access';
import { saveDepartment, assignToOrg, saveTeam } from '../lib/org';
import { query, queryOne, pool } from '../lib/db';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

async function cleanup() {
  await query(`DELETE er FROM employee_roles er JOIN employees e ON e.id = er.employee_id WHERE e.emp_id LIKE 'ZZAC%'`);
  await query(`DELETE a FROM employee_org_assignments a JOIN employees e ON e.id = a.employee_id WHERE e.emp_id LIKE 'ZZAC%'`);
  await query(`UPDATE employees SET manager_id = NULL WHERE emp_id LIKE 'ZZAC%'`);
  await query(`UPDATE departments SET head_employee_id = NULL WHERE code LIKE 'ZZAC%'`);
  await query(`UPDATE teams SET lead_employee_id = NULL WHERE code LIKE 'ZZAC%'`);
  await query(`DELETE FROM employees WHERE emp_id LIKE 'ZZAC%'`);
  await query(`DELETE FROM teams WHERE code LIKE 'ZZAC%'`);
  await query(`DELETE FROM departments WHERE code LIKE 'ZZAC%' ORDER BY depth DESC`);
  await query(`DELETE rp FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code LIKE 'ZZAC%'`);
  await query(`DELETE FROM roles WHERE code LIKE 'ZZAC%'`);
}

async function main() {
  const ACTOR = (await queryOne<{ id: number }>(
    `SELECT id FROM employees WHERE role = 'super_admin' AND is_active = 1 LIMIT 1`))!.id;
  try {
    await cleanup();

    // Ops
    //  +-- Plant   <- the manager heads this
    //  |     +-- Night
    //  +-- Yard    <- a sibling: must stay invisible
    const ops = await saveDepartment({ name: 'ZZAC Ops', code: 'ZZAC-OPS' }, ACTOR);
    const plant = await saveDepartment({ name: 'ZZAC Plant', code: 'ZZAC-PLANT', parent_id: ops.id }, ACTOR);
    const night = await saveDepartment({ name: 'ZZAC Night', code: 'ZZAC-NIGHT', parent_id: plant.id }, ACTOR);
    const yard = await saveDepartment({ name: 'ZZAC Yard', code: 'ZZAC-YARD', parent_id: ops.id }, ACTOR);

    const mk = async (empId: string, name: string, role = 'employee') => ((await query(
      `INSERT INTO employees (emp_id, name, pin_hash, role, is_active) VALUES (?, ?, 'x', ?, 1)`,
      [empId, name, role])) as unknown as { insertId: number }).insertId;

    const manager = await mk('ZZAC1', 'ZZAC Manager', 'manager');
    const inPlant = await mk('ZZAC2', 'ZZAC Plant Worker');
    const inNight = await mk('ZZAC3', 'ZZAC Night Worker');
    const inYard = await mk('ZZAC4', 'ZZAC Yard Worker');
    const inOps = await mk('ZZAC5', 'ZZAC Ops Boss');
    const nowhere = await mk('ZZAC6', 'ZZAC Unplaced');
    const lonely = await mk('ZZAC7', 'ZZAC Unplaced Manager', 'manager');

    await saveDepartment({ id: plant.id, name: 'ZZAC Plant', code: 'ZZAC-PLANT',
      parent_id: ops.id, head_employee_id: manager }, ACTOR);

    for (const [emp, dept] of [[inPlant, plant.id], [inNight, night.id],
                               [inYard, yard.id], [inOps, ops.id]] as const) {
      await assignToOrg({ employeeId: emp, departmentId: dept, effectiveFrom: '2026-01-01', by: ACTOR });
    }

    console.log('\n— an employee with no explicit role behaves exactly as before —');
    const plain = await resolveAccess(inPlant);
    check('the fallback was used, not an explicit grant', plain.explicit === false);
    check('and it gave them the employee role grants', can(plain, 'attendance.view'));
    eq('scoped to themselves', scopeOf(plain, 'attendance.view'), 'self');
    const plainSees = await visibleEmployeeIds(plain, 'attendance.view');
    check('so they see only themselves',
      Array.isArray(plainSees) && plainSees.length === 1 && plainSees[0] === inPlant,
      JSON.stringify(plainSees));

    console.log('\n— a permission nobody granted means NO ROWS, not no filter —');
    const notGranted = await visibleEmployeeIds(plain, 'payroll.export');
    check('an ungranted permission returns an empty list',
      Array.isArray(notGranted) && notGranted.length === 0, JSON.stringify(notGranted));
    const frag = await employeeScopeSql(plain, 'payroll.export', 'a.employee_id');
    eq('and its SQL fragment matches nothing', frag.sql, '1 = 0');
    check('assertCan refuses it', (() => {
      try { assertCan(plain, 'payroll.export'); return false; }
      catch (e) { return e instanceof ForbiddenError; }
    })());

    console.log('\n— a department manager sees down the tree, and no further —');
    const mgr = await resolveAccess(manager);
    eq('their scope is the department', scopeOf(mgr, 'attendance.view'), 'department');
    const seen = await visibleEmployeeIds(mgr, 'attendance.view') as number[];

    check('they see their own department', seen.includes(inPlant), `[${seen}]`);
    check('and everything nested below it', seen.includes(inNight));
    check('and themselves', seen.includes(manager));

    // The three that matter.
    check('NOT a sibling department', !seen.includes(inYard), `yard worker ${inYard} in [${seen}]`);
    check('NOT the parent department above them', !seen.includes(inOps), `ops boss ${inOps} in [${seen}]`);
    check('NOT somebody placed nowhere at all', !seen.includes(nowhere));

    console.log('\n— an unplaced manager reaches themselves, not everybody —');
    // The tempting shortcut is "no department, so no filter", which returns the
    // whole company to somebody who has been given a role and not yet a desk.
    const lonelyCtx = await resolveAccess(lonely);
    eq('they do hold the permission', scopeOf(lonelyCtx, 'attendance.view'), 'department');
    const lonelySees = await visibleEmployeeIds(lonelyCtx, 'attendance.view');
    check('but it resolves to only themselves',
      Array.isArray(lonelySees) && lonelySees.length === 1 && lonelySees[0] === lonely,
      JSON.stringify(lonelySees));

    console.log('\n— a team lead sees the team they LEAD —');
    await saveTeam({ department_id: yard.id, name: 'ZZAC Yard Team', code: 'ZZAC-T1',
      lead_employee_id: inYard }, ACTOR);
    const teamId = (await queryOne<{ id: number }>(`SELECT id FROM teams WHERE code = 'ZZAC-T1'`))!.id;
    await assignToOrg({ employeeId: inPlant, departmentId: yard.id, teamId,
      effectiveFrom: '2026-02-01', by: ACTOR });

    const teamRole = (await query(
      `INSERT INTO roles (code, name, is_system) VALUES ('ZZAC-LEAD', 'ZZAC Team Lead', FALSE)`,
    )) as unknown as { insertId: number };
    await query(
      `INSERT INTO role_permissions (role_id, permission_id, scope)
       SELECT ?, id, 'team' FROM permissions WHERE perm_key = 'attendance.view'`,
      [teamRole.insertId]);
    await query(`INSERT INTO employee_roles (employee_id, role_id) VALUES (?, ?)`,
      [inYard, teamRole.insertId]);

    const lead = await resolveAccess(inYard);
    check('an explicit role overrides the fallback', lead.explicit === true);
    eq('with the team scope', scopeOf(lead, 'attendance.view'), 'team');
    const ledSees = await visibleEmployeeIds(lead, 'attendance.view', '2026-06-01') as number[];
    check('they see somebody on their team', ledSees.includes(inPlant), `[${ledSees}]`);
    check('and themselves', ledSees.includes(inYard));
    check('but not somebody in the same department on no team', !ledSees.includes(inNight));

    console.log('\n— widest scope wins when two roles grant the same thing —');
    const wideRole = (await query(
      `INSERT INTO roles (code, name, is_system) VALUES ('ZZAC-WIDE', 'ZZAC Wide', FALSE)`,
    )) as unknown as { insertId: number };
    await query(
      `INSERT INTO role_permissions (role_id, permission_id, scope)
       SELECT ?, id, 'department' FROM permissions WHERE perm_key = 'attendance.view'`,
      [wideRole.insertId]);
    await query(`INSERT INTO employee_roles (employee_id, role_id) VALUES (?, ?)`,
      [inYard, wideRole.insertId]);
    // Adding a role must never take access away: narrowest-wins would mean a
    // grant could demote somebody, which is not what the word means.
    eq('adding a wider role widens, never narrows',
      scopeOf(await resolveAccess(inYard), 'attendance.view'), 'department');

    console.log('\n— super admin keeps a hard bypass —');
    const sa = await resolveAccess(ACTOR);
    check('flagged as super admin', sa.isSuperAdmin);
    check('can do something nobody granted explicitly', can(sa, 'roles.manage'));
    eq('at the widest scope', scopeOf(sa, 'payroll.export'), 'all');
    eq('and sees everybody', await visibleEmployeeIds(sa, 'attendance.view'), 'all');
    const saFrag = await employeeScopeSql(sa, 'attendance.view', 'a.employee_id');
    eq('whose SQL fragment narrows nothing', saFrag.sql, '1 = 1');

    console.log('\n— the catalogue the Roles page reads —');
    const perms = await listPermissions();
    check('permissions are listed', perms.length >= 20, `${perms.length}`);
    check('company-wide ones are marked unscopable',
      perms.filter(p => !p.scopable).length > 0,
      `${perms.filter(p => !p.scopable).length} unscopable`);
    const roles = await listRoles();
    const sysCodes = roles.filter(r => r.is_system).map(r => r.code).sort();
    check('the three system roles exist',
      ['employee', 'manager', 'super_admin'].every(c => sysCodes.includes(c)), sysCodes.join(','));
    check('and each carries its grants',
      (roles.find(r => r.code === 'manager')?.grants.length ?? 0) > 0);

    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    await cleanup();
  }
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });

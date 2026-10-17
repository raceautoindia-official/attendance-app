/**
 * scripts/verify-org.ts — the department tree, grades, teams and placements.
 *
 *   npx tsx --env-file=.env.local scripts/verify-org.ts
 *
 * The two cycle checks are the reason this suite exists. A department that is
 * its own ancestor, or a reporting line that loops, makes "everything below
 * this node" recurse until the process dies — and both are reachable with two
 * ordinary edits by somebody who meant no harm. They will also be the thing a
 * `department` permission scope walks, so a loop here becomes an outage on
 * every page at once.
 *
 * Everything it creates is prefixed ZZORG and removed at the end.
 */

import {
  listDepartments, buildDepartmentTree, saveDepartment, deactivateDepartment,
  departmentSubtreeIds, listGrades, saveGrade, listTeams, saveTeam,
  assignToOrg, listAssignments, unplacedEmployees, OrgError,
} from '../lib/org';
import { query, queryOne, pool } from '../lib/db';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` - ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

async function refused(label: string, fn: () => Promise<unknown>) {
  try { await fn(); check(label, false, 'it was allowed'); }
  catch (e) { check(label, e instanceof OrgError, (e as Error).message.slice(0, 80)); }
}

async function cleanup() {
  await query(`DELETE a FROM employee_org_assignments a JOIN employees e ON e.id = a.employee_id WHERE e.emp_id LIKE 'ZZORG%'`);
  await query(`DELETE a FROM employee_org_assignments a JOIN departments d ON d.id = a.department_id WHERE d.code LIKE 'ZZORG%'`);
  await query(`UPDATE employees SET manager_id = NULL WHERE emp_id LIKE 'ZZORG%'`);
  await query(`DELETE FROM employees WHERE emp_id LIKE 'ZZORG%'`);
  await query(`DELETE FROM teams WHERE code LIKE 'ZZORG%'`);
  // Deepest first: a parent cannot be deleted while a child still points at it.
  await query(`DELETE FROM departments WHERE code LIKE 'ZZORG%' ORDER BY depth DESC`);
  await query(`DELETE FROM grades WHERE code LIKE 'ZZORG%'`);
}

async function main() {
  const ACTOR = (await queryOne<{ id: number }>(
    `SELECT id FROM employees WHERE role = 'super_admin' AND is_active = 1 LIMIT 1`))!.id;
  try {
    await cleanup();

    console.log('\n- a tree, not a list -');
    const ops = await saveDepartment({ name: 'ZZ Operations', code: 'ZZORG-OPS' }, ACTOR);
    const wash = await saveDepartment({ name: 'ZZ Wash Plant', code: 'ZZORG-WASH', parent_id: ops.id }, ACTOR);
    const night = await saveDepartment({ name: 'ZZ Night Shift', code: 'ZZORG-NIGHT', parent_id: wash.id }, ACTOR);
    eq('a department with no parent is level 1', ops.depth, 0);
    eq('its child is level 2', wash.depth, 1);
    eq('and nesting keeps going', night.depth, 2);

    const tree = buildDepartmentTree((await listDepartments()).filter(d => d.code.startsWith('ZZORG')));
    eq('the tree has one root', tree.length, 1);
    eq('with one child', tree[0].children.length, 1);
    eq('and one grandchild', tree[0].children[0].children.length, 1);

    console.log('\n- the subtree walk, which permission scopes will use -');
    const subtree = await departmentSubtreeIds(ops.id);
    check('it reaches every level below', [ops.id, wash.id, night.id].every(id => subtree.includes(id)),
      `${subtree.length} ids`);
    const leaf = await departmentSubtreeIds(night.id);
    eq('a leaf resolves to only itself', leaf.length, 1);

    console.log('\n- a department cannot contain itself -');
    await refused('it refuses to be its own parent',
      () => saveDepartment({ id: ops.id, name: 'ZZ Operations', code: 'ZZORG-OPS', parent_id: ops.id }, ACTOR));
    await refused('it refuses to move under its own child',
      () => saveDepartment({ id: ops.id, name: 'ZZ Operations', code: 'ZZORG-OPS', parent_id: wash.id }, ACTOR));
    await refused('or under its own grandchild',
      () => saveDepartment({ id: ops.id, name: 'ZZ Operations', code: 'ZZORG-OPS', parent_id: night.id }, ACTOR));
    // The walk must still terminate afterwards, which is the point of refusing.
    const stillFine = await departmentSubtreeIds(ops.id);
    eq('and the subtree walk still terminates', stillFine.length, 3);

    console.log('\n- moving a branch re-levels everything under it -');
    const sales = await saveDepartment({ name: 'ZZ Sales', code: 'ZZORG-SALES' }, ACTOR);
    await saveDepartment({ id: wash.id, name: 'ZZ Wash Plant', code: 'ZZORG-WASH', parent_id: sales.id }, ACTOR);
    const afterMove = await listDepartments();
    eq('the moved node takes its new level',
      afterMove.find(d => d.id === wash.id)?.depth, 1);
    eq('and its child follows it down',
      afterMove.find(d => d.id === night.id)?.depth, 2);
    await saveDepartment({ id: wash.id, name: 'ZZ Wash Plant', code: 'ZZORG-WASH', parent_id: ops.id }, ACTOR);

    console.log('\n- grades are a separate thing from departments -');
    await saveGrade({ code: 'ZZORG-L1', name: 'ZZ Junior', rank_order: 10 }, ACTOR);
    await saveGrade({ code: 'ZZORG-L9', name: 'ZZ Senior', rank_order: 90 }, ACTOR);
    const grades = (await listGrades()).filter(g => g.code.startsWith('ZZORG'));
    eq('both exist', grades.length, 2);
    // rank_order, not the code: 'ZZORG-L9' sorts before 'ZZORG-L1' as a string
    // only by luck, and 'L10' before 'L2' always.
    check('they sort by rank, not alphabetically',
      grades[0].rank_order < grades[1].rank_order, `${grades[0].code} then ${grades[1].code}`);

    console.log('\n- teams belong to exactly one department -');
    await saveTeam({ department_id: wash.id, name: 'ZZ Shift A', code: 'ZZORG-TA' }, ACTOR);
    const teams = (await listTeams()).filter(t => t.code.startsWith('ZZORG'));
    eq('the team is created', teams.length, 1);
    eq('under the right department', teams[0].department_id, wash.id);
    const teamId = teams[0].id;

    console.log('\n- placing people, with dates -');
    const mk = async (empId: string, name: string) => ((await query(
      `INSERT INTO employees (emp_id, name, pin_hash, role, is_active) VALUES (?, ?, 'x', 'employee', 1)`,
      [empId, name])) as unknown as { insertId: number }).insertId;
    const boss = await mk('ZZORG1', 'ZZ Boss');
    const worker = await mk('ZZORG2', 'ZZ Worker');

    await assignToOrg({ employeeId: boss, departmentId: wash.id, gradeId: grades[1].id,
      effectiveFrom: '2026-01-01', by: ACTOR });
    await assignToOrg({ employeeId: worker, departmentId: wash.id, teamId,
      gradeId: grades[0].id, reportsTo: boss, effectiveFrom: '2026-01-01', by: ACTOR });

    const current = await listAssignments({ employeeId: worker });
    eq('one open placement', current.filter(a => a.effective_to === null).length, 1);
    eq('in the right department', current[0].department_name, 'ZZ Wash Plant');
    eq('reporting to the right person', current[0].reports_to_name, 'ZZ Boss');

    // The rest of the app already reads employees.manager_id. If the org
    // structure were a second, disagreeing answer, it would repeat exactly the
    // mistake employees.department made.
    const emp = await queryOne<{ manager_id: number | null }>(
      `SELECT manager_id FROM employees WHERE id = ?`, [worker]);
    eq('employees.manager_id is kept in step', Number(emp?.manager_id), boss);

    console.log('\n- a move keeps the history -');
    await assignToOrg({ employeeId: worker, departmentId: sales.id,
      effectiveFrom: '2026-06-01', by: ACTOR });
    const history = await listAssignments({ employeeId: worker });
    eq('there are now two rows', history.length, 2);
    eq('exactly one is open', history.filter(a => a.effective_to === null).length, 1);
    const closed = history.find(a => a.effective_to !== null)!;
    eq('the old one ends the day before the new one starts', closed.effective_to, '2026-05-31');

    // A transfer must not quietly delete things nobody asked to change.
    const openNow = history.find(a => a.effective_to === null)!;
    eq('a department move keeps the reporting line', openNow.reports_to_name, 'ZZ Boss');
    eq('and keeps the grade', openNow.grade_code, 'ZZORG-L1');
    check('but drops the team, which belonged to the old department',
      openNow.team_id === null, String(openNow.team_id));

    const inMarch = await listAssignments({ employeeId: worker, onDate: '2026-03-15' });
    eq('March still reports the old department', inMarch[0]?.department_name, 'ZZ Wash Plant');
    const inJuly = await listAssignments({ employeeId: worker, onDate: '2026-07-15' });
    eq('July reports the new one', inJuly[0]?.department_name, 'ZZ Sales');

    console.log('\n- a reporting line cannot loop -');
    await refused('nobody reports to themselves',
      () => assignToOrg({ employeeId: boss, reportsTo: boss, effectiveFrom: '2026-07-01', by: ACTOR }));
    await refused('and not to somebody who reports to them',
      () => assignToOrg({ employeeId: boss, reportsTo: worker, effectiveFrom: '2026-07-01', by: ACTOR }));

    console.log('\n- a team must match its department -');
    await refused('a team from another department is refused',
      () => assignToOrg({ employeeId: boss, departmentId: sales.id, teamId,
        effectiveFrom: '2026-07-01', by: ACTOR }));

    console.log('\n- closing a department that still has people in it -');
    // On a LEAF: wash.id has a child, so its sub-department check fires first
    // and would mask whether the people check works at all.
    await assignToOrg({ employeeId: boss, departmentId: night.id,
      effectiveFrom: '2026-08-01', by: ACTOR });
    await refused('refused while somebody is still placed there',
      () => deactivateDepartment(night.id, ACTOR));
    await refused('and refused while it still has sub-departments',
      () => deactivateDepartment(ops.id, ACTOR));

    console.log('\n- who still needs placing -');
    const unplaced = await unplacedEmployees();
    check('the queue is reported', Array.isArray(unplaced), `${unplaced.length} unplaced`);
    check('and it does not list anybody already placed',
      !unplaced.some(u => u.id === worker || u.id === boss));

    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    await cleanup();
  }
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });

/**
 * scripts/verify-org-api.ts — the Organisation endpoints, end to end.
 *
 *   npx tsx --env-file=.env.local scripts/verify-org-api.ts
 *
 * verify-org.ts proves the library. This proves the HTTP surface on top of it:
 * that a manager can read the structure but not reshape it, that a rule broken
 * in the library comes back as a message an administrator can act on rather
 * than a 500, and — the one most likely to regress — that omitting a field
 * through the API keeps its value instead of clearing it.
 */

import { NextRequest } from 'next/server';
import { GET as deptGet, POST as deptPost, DELETE as deptDelete } from '../app/api/org/departments/route';
import { POST as gradePost } from '../app/api/org/grades/route';
import { POST as teamPost } from '../app/api/org/teams/route';
import { GET as assignGet, POST as assignPost } from '../app/api/org/assignments/route';
import { POST as companyPost } from '../app/api/org/companies/route';
import { signAccessToken, currentTokenVersion } from '../lib/auth';
import { query, queryOne, pool } from '../lib/db';

let passed = 0;
let failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`); }
};
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

const DEPTS = 'http://localhost:3000/api/org/departments';
const GRADES = 'http://localhost:3000/api/org/grades';
const TEAMS = 'http://localhost:3000/api/org/teams';
const ASSIGN = 'http://localhost:3000/api/org/assignments';
const COMPANIES = 'http://localhost:3000/api/org/companies';

function req(token: string, body?: unknown, url = DEPTS) {
  return new NextRequest(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `access_token=${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function tokenFor(role: 'super_admin' | 'employee') {
  const e = await queryOne<{ id: number; emp_id: string; role: string }>(
    `SELECT id, emp_id, role FROM employees WHERE role = ? AND is_active = 1 LIMIT 1`, [role]);
  if (!e) return null;
  const tv = await currentTokenVersion(e.id);
  return signAccessToken({ id: e.id, emp_id: e.emp_id, role: e.role, tv } as never);
}

async function cleanup() {
  await query(`DELETE a FROM employee_org_assignments a JOIN employees e ON e.id = a.employee_id WHERE e.emp_id LIKE 'ZZAPI%'`);
  await query(`UPDATE employees SET manager_id = NULL WHERE emp_id LIKE 'ZZAPI%'`);
  await query(`DELETE FROM employees WHERE emp_id LIKE 'ZZAPI%'`);
  await query(`DELETE FROM teams WHERE code LIKE 'ZZAPI%'`);
  await query(`DELETE FROM departments WHERE code LIKE 'ZZAPI%' ORDER BY depth DESC`);
  await query(`DELETE FROM grades WHERE code LIKE 'ZZAPI%'`);
  await query(`DELETE FROM companies WHERE legal_name LIKE 'ZZAPI%'`);
}

async function main() {
  try {
    await cleanup();
    const admin = (await tokenFor('super_admin'))!;
    const staff = await tokenFor('employee');

    console.log('\n— who may reshape the organisation —');
    eq('an admin may read it', (await deptGet(req(admin))).status, 200);
    if (staff) {
      const r = await deptGet(req(staff));
      check('an employee may not read it', r.status === 401 || r.status === 403, `got ${r.status}`);
      const w = await deptPost(req(staff, { name: 'ZZAPI Sneak', code: 'ZZAPI-X' }));
      check('and certainly may not create one', w.status === 401 || w.status === 403, `got ${w.status}`);
    }

    console.log('\n— creating the structure —');
    const made = await deptPost(req(admin, { name: 'ZZAPI Ops', code: 'ZZAPI-OPS' }));
    eq('a department is created', made.status, 201);
    const dept = (await made.json()).data.department as { id: number; depth: number };
    eq('at level 1', dept.depth, 0);

    const child = await deptPost(req(admin, { name: 'ZZAPI Plant', code: 'ZZAPI-PLANT', parent_id: dept.id }));
    const childId = (await child.json()).data.department.id as number;

    const dup = await deptPost(req(admin, { name: 'ZZAPI Again', code: 'ZZAPI-OPS' }));
    eq('a duplicate code is refused', dup.status, 400);
    check('with a message about the code, not a stack trace',
      /already in use/i.test((await dup.json()).error), 'readable');

    console.log('\n— a rule broken in the library reaches the browser as a message —');
    const loop = await deptPost(req(admin, {
      id: dept.id, name: 'ZZAPI Ops', code: 'ZZAPI-OPS', parent_id: childId,
    }));
    eq('a cycle is refused, not a 500', loop.status, 400);
    check('and it says what is wrong', /inside itself/i.test((await loop.json()).error), 'explained');

    console.log('\n— placing somebody, then moving them —');
    await gradePost(req(admin, { code: 'ZZAPI-G1', name: 'ZZAPI Junior', rank_order: 10 }, GRADES));
    const gradeId = (await queryOne<{ id: number }>(`SELECT id FROM grades WHERE code = 'ZZAPI-G1'`))!.id;
    await teamPost(req(admin, { department_id: childId, name: 'ZZAPI Shift', code: 'ZZAPI-T1' }, TEAMS));
    const teamId = (await queryOne<{ id: number }>(`SELECT id FROM teams WHERE code = 'ZZAPI-T1'`))!.id;

    const mk = async (e: string, n: string) => ((await query(
      `INSERT INTO employees (emp_id, name, pin_hash, role, is_active) VALUES (?, ?, 'x', 'employee', 1)`,
      [e, n])) as unknown as { insertId: number }).insertId;
    const boss = await mk('ZZAPI1', 'ZZAPI Boss');
    const worker = await mk('ZZAPI2', 'ZZAPI Worker');

    eq('a placement is accepted', (await assignPost(req(admin, {
      employee_id: worker, department_id: childId, team_id: teamId,
      grade_id: gradeId, reports_to: boss, effective_from: '2026-02-01',
    }, ASSIGN))).status, 200);

    // The bug this guards: a transfer that silently deletes the manager and
    // the grade purely because they were not re-sent.
    eq('a department-only move is accepted', (await assignPost(req(admin, {
      employee_id: worker, department_id: dept.id, effective_from: '2026-07-01',
    }, ASSIGN))).status, 200);

    const after = await assignGet(req(admin, undefined, `${ASSIGN}?employee_id=${worker}`));
    const rows = (await after.json()).data.assignments as Array<{
      effective_to: string | null; department_name: string;
      reports_to_name: string | null; grade_code: string | null; team_name: string | null;
    }>;
    const open = rows.find(r => r.effective_to === null)!;
    eq('the department changed', open.department_name, 'ZZAPI Ops');
    eq('the reporting line survived', open.reports_to_name, 'ZZAPI Boss');
    eq('the grade survived', open.grade_code, 'ZZAPI-G1');
    eq('but the team went with its department', open.team_name, null);
    eq('and the old placement was closed, not deleted',
      rows.filter(r => r.effective_to !== null).length, 1);

    console.log('\n— closing a department that is still in use —');
    const busy = await deptDelete(req(admin, undefined, `${DEPTS}?id=${dept.id}`));
    eq('refused', busy.status, 400);
    check('with a reason an administrator can act on',
      /employee|sub-department/i.test((await busy.json()).error), 'explained');

    console.log('\n— the unplaced queue —');
    const withUnplaced = await assignGet(req(admin, undefined, `${ASSIGN}?with_unplaced=1`));
    const unplaced = (await withUnplaced.json()).data.unplaced as Array<{ id: number }>;
    check('it comes back alongside, not as a second request',
      Array.isArray(unplaced), `${unplaced.length} unplaced`);
    check('and excludes the person just placed', !unplaced.some(u => u.id === worker));

    console.log('\n— the company profile —');
    eq('a company is created',
      (await companyPost(req(admin, { legal_name: 'ZZAPI Holdings Pvt Ltd', pan: 'AAAAA0000A' }, COMPANIES))).status, 201);
    eq('and a second is allowed, for group structures',
      (await companyPost(req(admin, { legal_name: 'ZZAPI Subsidiary Pvt Ltd' }, COMPANIES))).status, 201);
    const blank = await companyPost(req(admin, { legal_name: '' }, COMPANIES));
    eq('a nameless company is refused', blank.status, 400);
    check('naming the field that was wrong',
      /legal_name/i.test((await blank.json()).error), 'named');

    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    await cleanup();
  }
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });

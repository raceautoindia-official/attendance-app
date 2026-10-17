/**
 * scripts/verify-access-api.ts — the Roles & Access endpoints.
 *
 *   npx tsx --env-file=.env.local scripts/verify-access-api.ts
 *
 * verify-access.ts proves the scope arithmetic. This proves the surface that
 * CHANGES it, where the dangerous mistakes are different in kind:
 *
 *   - a built-in role being renamed or deleted, which silently strips
 *     permissions from everybody relying on the fallback
 *   - a company-wide permission stored with a team scope, recording a limit
 *     nothing can honour
 *   - the last grant of "manage roles" being removed, after which the only
 *     way back is a database prompt
 *
 * Everything it creates is prefixed ZZRA and removed at the end.
 */

import { NextRequest } from 'next/server';
import { GET as rolesGet, POST as rolesPost, DELETE as rolesDelete } from '../app/api/access/roles/route';
import { GET as assignGet, POST as assignPost } from '../app/api/access/assignments/route';
import { GET as meGet } from '../app/api/access/me/route';
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

const ROLES = 'http://localhost:3000/api/access/roles';
const ASSIGN = 'http://localhost:3000/api/access/assignments';

function req(token: string, body?: unknown, url = ROLES, method?: string) {
  return new NextRequest(url, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
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
  await query(`DELETE er FROM employee_roles er JOIN roles r ON r.id = er.role_id WHERE r.code LIKE 'ZZRA%'`);
  await query(`DELETE er FROM employee_roles er JOIN employees e ON e.id = er.employee_id WHERE e.emp_id LIKE 'ZZRA%'`);
  await query(`DELETE rp FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code LIKE 'ZZRA%'`);
  await query(`DELETE FROM roles WHERE code LIKE 'ZZRA%'`);
  await query(`DELETE FROM employees WHERE emp_id LIKE 'ZZRA%'`);
}

async function main() {
  try {
    await cleanup();
    const admin = (await tokenFor('super_admin'))!;
    const staff = await tokenFor('employee');

    console.log('\n— gated on the permission, not the legacy role —');
    eq('an admin may read the catalogue', (await rolesGet(req(admin))).status, 200);
    if (staff) {
      const r = await rolesGet(req(staff));
      check('an employee may not', r.status === 401 || r.status === 403, `got ${r.status}`);
    }

    const listed = await (await rolesGet(req(admin))).json();
    const permissions = listed.data.permissions as Array<{ id: number; perm_key: string; scopable: boolean }>;
    const attendanceView = permissions.find(p => p.perm_key === 'attendance.view')!;
    const holidayManage = permissions.find(p => p.perm_key === 'holiday.manage')!;
    const rolesManage = permissions.find(p => p.perm_key === 'roles.manage')!;
    check('the catalogue marks company-wide permissions', holidayManage.scopable === false);

    console.log('\n— a company-wide permission cannot be narrowed —');
    const narrowed = await rolesPost(req(admin, {
      code: 'ZZRA-BAD', name: 'ZZRA Bad', grants: [{ permission_id: holidayManage.id, scope: 'team' }],
    }));
    eq('refused', narrowed.status, 400);
    check('and says why, rather than silently storing it',
      /whole company/i.test((await narrowed.json()).error), 'explained');

    console.log('\n— creating a role —');
    const created = await rolesPost(req(admin, {
      code: 'ZZRA-LEAD', name: 'ZZRA Shift Lead', description: 'ZZRA test',
      grants: [{ permission_id: attendanceView.id, scope: 'team' }],
    }));
    eq('accepted', created.status, 200);
    const roleId = (await created.json()).data.id as number;

    const dup = await rolesPost(req(admin, {
      code: 'ZZRA-LEAD', name: 'ZZRA Again', grants: [],
    }));
    eq('a duplicate code is refused', dup.status, 400);

    console.log('\n— grants are replaced, not merged —');
    // A matrix editor sends what the screen shows. Merging would leave a
    // permission unticked on screen still granted in the database.
    await rolesPost(req(admin, {
      id: roleId, code: 'ZZRA-LEAD', name: 'ZZRA Shift Lead', grants: [],
    }));
    const afterClear = await (await rolesGet(req(admin))).json();
    const cleared = (afterClear.data.roles as Array<{ id: number; grants: unknown[] }>)
      .find(r => r.id === roleId)!;
    eq('unticking everything really removes it', cleared.grants.length, 0);

    await rolesPost(req(admin, {
      id: roleId, code: 'ZZRA-LEAD', name: 'ZZRA Shift Lead',
      grants: [{ permission_id: attendanceView.id, scope: 'department' }],
    }));

    console.log('\n— built-in roles are protected —');
    const builtin = (afterClear.data.roles as Array<{ id: number; code: string; is_system: boolean }>)
      .find(r => r.code === 'manager')!;
    const recode = await rolesPost(req(admin, {
      id: builtin.id, code: 'manager-renamed', name: 'Manager', grants: [],
    }));
    eq('re-coding one is refused', recode.status, 400);
    check('because the fallback finds it by code',
      /falls back to it by code/i.test((await recode.json()).error), 'explained');

    const delBuiltin = await rolesDelete(req(admin, undefined, `${ROLES}?id=${builtin.id}`, 'DELETE'));
    eq('deleting one is refused', delBuiltin.status, 400);

    console.log('\n— granting and revoking —');
    const emp = ((await query(
      `INSERT INTO employees (emp_id, name, pin_hash, role, is_active) VALUES ('ZZRA1','ZZRA Person','x','employee',1)`,
    )) as unknown as { insertId: number }).insertId;

    eq('a role can be given', (await assignPost(req(admin,
      { employee_id: emp, role_id: roleId, action: 'grant' }, ASSIGN))).status, 200);

    const holders = await (await assignGet(req(admin, undefined, ASSIGN))).json();
    const mine = (holders.data.holders as Array<{ employee_id: number; roles: unknown[]; legacy_role: string }>)
      .find(h => h.employee_id === emp)!;
    eq('and shows against that person', mine.roles.length, 1);

    // People with no explicit role are the point of this list today: they must
    // appear, with their legacy role, not be filtered out as "no access".
    const noRole = (holders.data.holders as Array<{ roles: unknown[]; legacy_role: string }>)
      .filter(h => h.roles.length === 0);
    check('people with no explicit role are still listed', noRole.length > 0, `${noRole.length}`);
    check('with the legacy role their access actually comes from',
      noRole.every(h => Boolean(h.legacy_role)));

    eq('a role can be taken away', (await assignPost(req(admin,
      { employee_id: emp, role_id: roleId, action: 'revoke' }, ASSIGN))).status, 200);

    console.log('\n— a role somebody holds cannot be deleted —');
    await assignPost(req(admin, { employee_id: emp, role_id: roleId, action: 'grant' }, ASSIGN));
    const held = await rolesDelete(req(admin, undefined, `${ROLES}?id=${roleId}`, 'DELETE'));
    eq('refused while held', held.status, 400);
    check('and says how many hold it',
      /still hold this role/i.test((await held.json()).error), 'explained');
    await assignPost(req(admin, { employee_id: emp, role_id: roleId, action: 'revoke' }, ASSIGN));
    eq('and allowed once nobody does',
      (await rolesDelete(req(admin, undefined, `${ROLES}?id=${roleId}`, 'DELETE'))).status, 200);

    console.log('\n— the lockout guard —');
    // With a super admin present there is always a way back, so revoking is
    // allowed. The guard only bites when that is not true.
    const lockRole = await rolesPost(req(admin, {
      code: 'ZZRA-ADMIN', name: 'ZZRA Access Admin',
      grants: [{ permission_id: rolesManage.id, scope: 'all' }],
    }));
    const lockId = (await lockRole.json()).data.id as number;
    await assignPost(req(admin, { employee_id: emp, role_id: lockId, action: 'grant' }, ASSIGN));
    const revoked = await assignPost(req(admin,
      { employee_id: emp, role_id: lockId, action: 'revoke' }, ASSIGN));
    eq('revoking is allowed while a super admin exists', revoked.status, 200);
    check('a super admin is the way back the guard looks for',
      Number((await queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM employees WHERE role = 'super_admin' AND is_active = TRUE`))?.n) > 0);

    console.log('\n— what the navigation asks about itself —');
    // The rail reads this to decide what to show. It has to answer for an
    // ordinary employee too, or their own pages render with no menu at all.
    const ME = 'http://localhost:3000/api/access/me';
    const myAccess = await meGet(req(admin, undefined, ME));
    eq('an admin may read their own access', myAccess.status, 200);
    const myAccessBody = await myAccess.json();
    eq('and is flagged as a super admin', myAccessBody.data.isSuperAdmin, true);
    eq('who holds no explicit role', myAccessBody.data.explicit, false);
    check('grants serialise as an object, not an empty Map',
      typeof myAccessBody.data.grants === 'object' && myAccessBody.data.grants !== null);

    const staffToken = await tokenFor('employee');
    if (staffToken) {
      const theirs = await meGet(req(staffToken, undefined, ME));
      eq('an employee may read their own access too', theirs.status, 200);
      const theirsBody = await theirs.json();
      eq('and is not a super admin', theirsBody.data.isSuperAdmin, false);
      eq('with the legacy role reported', theirsBody.data.legacyRole, 'employee');
    }

    const anonymous = await meGet(new NextRequest(ME));
    eq('without a token it is refused', anonymous.status, 401);

    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    await cleanup();
  }
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });

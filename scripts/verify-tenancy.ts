/**
 * scripts/verify-tenancy.ts — the tenant boundary.
 *
 *   npx tsx --env-file=.env.local scripts/verify-tenancy.ts
 *
 * This is the suite that matters most in the whole project. Everything else
 * being wrong produces a bad figure; this being wrong discloses one customer's
 * employees - names, Aadhaar numbers, bank accounts, live location - to
 * another.
 *
 * So it does not test that the happy path works. It tries to break out:
 *
 *   - work with no tenant must THROW, never quietly read somebody
 *   - two tenants reading "the same" table must see different rows
 *   - a context must not leak across an await, a timer, or a parallel branch
 *   - an ambiguous login must ask, never guess
 *   - a wrong tenant code must look identical to an unknown user
 *
 * It builds two throwaway tenant databases and a throwaway registry, and
 * removes them. It never touches `attendance`.
 */

import mysql from 'mysql2/promise';
import {
  runInTenant, requireTenant, currentTenant, hasTenant, NoTenantError,
  type TenantContext,
} from '../lib/tenancy/context';
import { poolForTenant, closeAllTenantPools, openPoolStats } from '../lib/tenancy/pools';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` - ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

const DB_A = 'zz_tenant_a';
const DB_B = 'zz_tenant_b';
const REG = 'zz_registry';

const TENANT_A: TenantContext = { id: 901, code: 'zz-a', dbName: DB_A, dbHost: null, dbPort: null };
const TENANT_B: TenantContext = { id: 902, code: 'zz-b', dbName: DB_B, dbHost: null, dbPort: null };

function adminPool() {
  return mysql.createPool({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    waitForConnections: true, connectionLimit: 2, queueLimit: 0,
  });
}

async function main() {
  const admin = adminPool();
  try {
    for (const db of [DB_A, DB_B, REG]) {
      await admin.query(`DROP DATABASE IF EXISTS \`${db}\``);
      await admin.query(`CREATE DATABASE \`${db}\``);
    }
    // Same table name in both, different rows. If the boundary is real, a read
    // in one can never see the other's.
    for (const [db, who] of [[DB_A, 'Alice at Company A'], [DB_B, 'Bob at Company B']] as const) {
      await admin.query(`CREATE TABLE \`${db}\`.staff (id INT PRIMARY KEY, name VARCHAR(80))`);
      await admin.query(`INSERT INTO \`${db}\`.staff VALUES (1, ?)`, [who]);
    }

    console.log('\n- no tenant means no query, not a default -');
    check('requireTenant throws outside any context',
      (() => { try { requireTenant(); return false; } catch (e) { return e instanceof NoTenantError; } })());
    check('hasTenant is false outside any context', hasTenant() === false);
    check('currentTenant is null rather than a guess', currentTenant() === null);
    {
      let threw = false;
      try { await poolForTenant(requireTenant()); } catch { threw = true; }
      check('asking for a pool with no tenant throws', threw);
    }

    console.log('\n- two tenants, the same query, different data -');
    const readStaff = async () => {
      const pool = await poolForTenant(requireTenant());
      const [rows] = await pool.query('SELECT name FROM staff WHERE id = 1');
      return (rows as Array<{ name: string }>)[0]?.name;
    };
    const aSaw = await runInTenant(TENANT_A, readStaff);
    const bSaw = await runInTenant(TENANT_B, readStaff);
    eq('tenant A sees its own row', aSaw, 'Alice at Company A');
    eq('tenant B sees its own row', bSaw, 'Bob at Company B');
    check('and neither saw the other', aSaw !== bSaw);

    console.log('\n- context survives awaits and does not leak past them -');
    const deep = async () => {
      await new Promise(r => setTimeout(r, 5));
      await Promise.resolve();
      return requireTenant().code;
    };
    eq('a tenant survives timers and awaits', await runInTenant(TENANT_A, deep), 'zz-a');
    check('and is gone again afterwards', !hasTenant());

    console.log('\n- parallel tenants do not bleed into each other -');
    // The failure this catches: a module-level "current tenant" variable, which
    // works perfectly until two requests overlap and then silently serves one
    // customer another's data.
    const [r1, r2, r3] = await Promise.all([
      runInTenant(TENANT_A, readStaff),
      runInTenant(TENANT_B, readStaff),
      runInTenant(TENANT_A, readStaff),
    ]);
    eq('first concurrent read is A', r1, 'Alice at Company A');
    eq('second, running at the same time, is B', r2, 'Bob at Company B');
    eq('third is A again, unaffected by B', r3, 'Alice at Company A');

    console.log('\n- nesting resolves to the innermost, and restores -');
    const nested = await runInTenant(TENANT_A, async () => {
      const outer = requireTenant().code;
      const inner = await runInTenant(TENANT_B, async () => requireTenant().code);
      return [outer, inner, requireTenant().code].join(',');
    });
    eq('outer, inner, then outer again', nested, 'zz-a,zz-b,zz-a');

    console.log('\n- pools are reused, capped, and keyed to the database -');
    const p1 = await runInTenant(TENANT_A, async () => poolForTenant(requireTenant()));
    const p2 = await runInTenant(TENANT_A, async () => poolForTenant(requireTenant()));
    check('the same tenant reuses one pool', p1 === p2);
    const stats = openPoolStats();
    check('the per-tenant limit is small enough for a fleet',
      stats.perPool <= 5, `${stats.perPool} per pool, cap ${stats.cap} pools`);
    check('budget stays under MySQL max_connections',
      stats.perPool * stats.cap < 151, `${stats.perPool * stats.cap} vs 151`);
    // A tenant moved to another database keeps its id, so a cached pool would
    // quietly keep talking to the old place.
    const moved = { ...TENANT_A, dbName: DB_B };
    const p3 = await poolForTenant(moved);
    check('a tenant moved to another database gets a new pool', p3 !== p1);

    console.log('\n- login routing asks rather than guesses -');
    process.env.REGISTRY_DB_NAME = REG;
    // A single connection bound to the registry database. On a POOL, `USE db`
    // and the next statement can land on different connections, so the USE
    // silently applies to one and the CREATE runs somewhere else.
    const regConn = await mysql.createConnection({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: REG,
      multipleStatements: true,
    });
    const regSql = (await import('fs')).readFileSync('database/registry/001_registry.sql', 'utf8');
    await regConn.query(regSql);
    await regConn.query(
      `INSERT INTO tenants (id, code, name, db_name, status)
       VALUES (901,'zz-a','Company A',?, 'active'), (902,'zz-b','Company B',?, 'active')`,
      [DB_A, DB_B]);
    await regConn.query(
      `INSERT INTO tenant_login_directory (tenant_id, id_type, identifier, employee_id)
       VALUES (901,'emp_id','SHARED001',11), (902,'emp_id','SHARED001',22), (901,'emp_id','ONLYA',33)`);
    await regConn.end();
    const { routeLogin, closeRegistryPool } = await import('../lib/tenancy/registry');

    const unique = await routeLogin({ idType: 'emp_id', identifier: 'ONLYA' });
    eq('an identifier in one tenant signs straight in', unique.kind, 'one');
    check('...at the right tenant',
      unique.kind === 'one' && unique.tenant.code === 'zz-a');

    const clash = await routeLogin({ idType: 'emp_id', identifier: 'SHARED001' });
    eq('the same emp_id at two companies asks which', clash.kind, 'choose');
    check('...and offers both', clash.kind === 'choose' && clash.options.length === 2);

    const coded = await routeLogin({ idType: 'emp_id', identifier: 'SHARED001', tenantCode: 'zz-b' });
    check('a tenant code settles it outright',
      coded.kind === 'one' && coded.tenant.code === 'zz-b');

    // Answering 'choose' here would confirm which companies this person works
    // for to somebody who guessed a code - so a wrong code is indistinguishable
    // from an unknown user.
    const wrongCode = await routeLogin({ idType: 'emp_id', identifier: 'SHARED001', tenantCode: 'zz-nope' });
    eq('a wrong tenant code looks exactly like an unknown user', wrongCode.kind, 'none');

    const missing = await routeLogin({ idType: 'emp_id', identifier: 'NOBODY' });
    eq('an unknown identifier is none', missing.kind, 'none');

    await closeRegistryPool();
    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    await closeAllTenantPools();
    for (const db of [DB_A, DB_B, REG]) {
      await admin.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => {});
    }
    await admin.end();
  }
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(() => process.exit(failed === 0 ? 0 : 1));

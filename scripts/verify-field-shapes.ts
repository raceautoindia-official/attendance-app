/**
 * scripts/verify-field-shapes.ts — the API refusing its own output.
 *
 *   npx tsx --env-file=.env.local scripts/verify-field-shapes.ts
 *
 * WHAT WENT WRONG
 * ---------------
 * Saving a company answered:
 *
 *     is_active: Invalid input: expected boolean, received number
 *
 * Nothing was wrong with the request. mysql2 returns TINYINT(1) as the NUMBER
 * 1, every flag in this schema is a TINYINT(1) (31 columns), and an edit form
 * seeds itself from the row it is editing and posts that row back. So the app
 * handed out a 1, was given the same 1 back, and rejected it.
 *
 * TypeScript cannot see this. `query<Company>` asserts the shape rather than
 * checking it, so a field declared `boolean` holding a number type-checks
 * everywhere, all the way to the schema that finally looks.
 *
 * SO THIS CHECKS BOTH ENDS
 * ------------------------
 *  - what goes out: the rows the organisation screen edits carry real
 *    booleans, which is what `listDepartments`, `listTeams` and `listGrades`
 *    always did and `listCompanies` did not;
 *  - what comes back: every flag the API accepts goes through `zBool`, so a
 *    client echoing the 1 it was given is understood rather than refused. That
 *    half matters most for the phone app, which is released separately and
 *    cannot be fixed by deploying this.
 *
 * The last test is the exact request that failed, posted to the real handler.
 */

import { NextRequest } from 'next/server';
import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { zBool, zNum } from '../lib/zodFields';
import { POST as companiesPost } from '../app/api/org/companies/route';
import { listCompanies, listDepartments, listGrades, listTeams } from '../lib/org';
import { signAccessToken, currentTokenVersion } from '../lib/auth';
import { query, queryOne, pool } from '../lib/db';

let passed = 0;
let failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`); }
};

/**
 * Reads that still hand out a raw TINYINT, each with the reason it has not
 * been changed. These are the long-standing endpoints the PHONE APP reads;
 * changing the shape of their JSON is a compatibility change for a client
 * released on its own schedule, so it is a decision rather than a tidy-up.
 * `zBool` means nothing breaks either way.
 *
 * Listed by file so the list cannot quietly outlive the files it describes.
 */
const KNOWN_RAW: Record<string, string> = {
  'app/api/employees/route.ts': 'the phone app reads this list',
  'app/api/employees/[id]/route.ts': 'the phone app reads this record',
  'app/api/locations/route.ts': 'the phone app reads sites for the fence',
  'app/api/locations/[id]/route.ts': 'the phone app reads sites for the fence',
  'app/api/profile/route.ts': 'the phone app reads its own profile',
  'app/api/attendance/route.ts': 'the phone app reads attendance',
  'app/api/attendance/today/route.ts': 'the phone app reads today',
  'app/api/attendance/[id]/route.ts': 'the phone app reads a day',
  'app/api/attendance/clock-in/route.ts': 'the phone app clocks in',
  'app/api/attendance/clock-out/route.ts': 'the phone app clocks out',
  'app/api/live-tracking/ping/route.ts': 'the phone app pings',
  'app/api/live-tracking/start/route.ts': 'the phone app starts tracking',
  'app/api/live-tracking/stop/route.ts': 'the phone app stops tracking',
  'app/api/live-tracking/status/route.ts': 'the phone app reads its own state',
  'app/api/schedules/assign/route.ts': 'rosters are read by the phone app',
  'app/api/schedules/assignments/route.ts': 'rosters are read by the phone app',
  'app/api/permissions/route.ts': 'the phone app raises permission requests',
  'app/api/permissions/[id]/route.ts': 'the phone app reads its own requests',
  'app/api/employees/[id]/exemption/route.ts': 'an admin act on a phone-read record',
  'app/api/auth/login/route.ts': 'the web and phone share this response',
  'app/api/auth/webauthn/authenticate-verify/route.ts': 'the web and phone share this response',
};

function routeFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === 'route.ts') out.push(full.replace(/\\/g, '/'));
  }
  return out;
}

async function main() {
  console.log('\nFIELD SHAPES\n');

  // --- the helper itself ---------------------------------------------------
  const parse = (v: unknown) => zBool.safeParse(v);
  check('zBool takes a real boolean', parse(true).success && parse(true).data === true);
  check('zBool reads the 1 the database hands out as true',
    parse(1).success && parse(1).data === true);
  check('zBool reads 0 as false', parse(0).success && parse(0).data === false);
  check('zBool still refuses a number that means nothing', !parse(2).success);
  check('zBool still refuses a string', !parse('true').success);
  check('zBool still refuses null', !parse(null).success);
  // z.coerce.boolean() would have said true to all three above, which is why
  // this is a union and not a coercion.

  check('zNum reads the string a DECIMAL column returns',
    zNum.safeParse('12.50').success && zNum.safeParse('12.50').data === 12.5);
  check('zNum refuses text', !zNum.safeParse('twelve').success);

  // --- what the API accepts ------------------------------------------------
  const files = routeFiles(join('app', 'api'));
  const rawBooleans = files.filter(f => readFileSync(f, 'utf8').includes('z.boolean()'));
  check('every flag the API accepts goes through zBool', rawBooleans.length === 0,
    rawBooleans.join(', ') || `${files.length} routes checked`);

  const stale = Object.keys(KNOWN_RAW).filter(f => !existsSync(f));
  check('the phone-facing list names files that exist', stale.length === 0,
    stale.join(', ') || 'none');

  // --- what the API hands out ----------------------------------------------
  console.log('\n— rows the organisation screen edits and posts back —');
  const [companies, departments, teams, grades] = await Promise.all([
    listCompanies(true), listDepartments(true), listTeams({ includeInactive: true }),
    listGrades(true),
  ]);

  const flagIsBoolean = (label: string, rows: Array<{ is_active: unknown }>) => {
    if (rows.length === 0) { check(`${label}: nothing to check`, true, 'no rows'); return; }
    const wrong = rows.filter(r => typeof r.is_active !== 'boolean');
    check(`${label} carry a real boolean`, wrong.length === 0,
      wrong.length ? `${wrong.length} of ${rows.length} are ${typeof wrong[0].is_active}` : `${rows.length} rows`);
  };
  flagIsBoolean('companies', companies);
  flagIsBoolean('departments', departments);
  flagIsBoolean('teams', teams);
  flagIsBoolean('grades', grades);

  // --- the request that actually failed ------------------------------------
  console.log('\n— the save that was refused —');
  const admin = await queryOne<{ id: number; emp_id: string; role: string }>(
    `SELECT id, emp_id, role FROM employees
      WHERE role = 'super_admin' AND is_active = TRUE LIMIT 1`);
  if (!admin) {
    check('a super admin to sign in as', false, 'none found');
  } else {
    // The same claims the login route signs. A token missing emp_id or tv is
    // rejected as a stale session, which looks like a permission bug and is not.
    const token = signAccessToken({
      id: admin.id, emp_id: admin.emp_id, role: admin.role,
      tv: await currentTokenVersion(admin.id),
    } as never);
    const made = await query(
      `INSERT INTO companies (legal_name, country_code, fy_start_month, timezone, is_active)
       VALUES ('ZZFS Shape Test', 'IN', 4, 'Asia/Kolkata', TRUE)`,
    ) as unknown as { insertId: number };
    const id = made.insertId;

    try {
      // Exactly what the edit form sends: the row it was given, flag and all.
      const row = (await listCompanies(true)).find(c => c.id === id)!;
      const res = await companiesPost(new NextRequest(
        'http://localhost:3000/api/org/companies',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: `access_token=${token}` },
          body: JSON.stringify({ ...row, legal_name: 'ZZFS Shape Test Renamed' }),
        },
      ));
      const body = await res.json();
      check('a company edit round-trips', res.status === 200,
        res.status === 200 ? 'saved' : `${res.status}: ${body.error}`);

      // And the raw shape a client may still be holding from an older build.
      const raw = await companiesPost(new NextRequest(
        'http://localhost:3000/api/org/companies',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: `access_token=${token}` },
          body: JSON.stringify({ id, legal_name: 'ZZFS Shape Test Raw', is_active: 1 }),
        },
      ));
      const rawBody = await raw.json();
      check('and so does a literal is_active: 1', raw.status === 200,
        raw.status === 200 ? 'accepted' : `${raw.status}: ${rawBody.error}`);

      const stored = await queryOne<{ is_active: number }>(
        'SELECT is_active FROM companies WHERE id = ?', [id]);
      check('which is stored as true, not mangled', Number(stored?.is_active) === 1,
        `is_active=${stored?.is_active}`);

      const off = await companiesPost(new NextRequest(
        'http://localhost:3000/api/org/companies',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: `access_token=${token}` },
          body: JSON.stringify({ id, legal_name: 'ZZFS Shape Test Raw', is_active: 0 }),
        },
      ));
      const offStored = await queryOne<{ is_active: number }>(
        'SELECT is_active FROM companies WHERE id = ?', [id]);
      check('a 0 retires it rather than being read as true',
        off.status === 200 && Number(offStored?.is_active) === 0,
        `is_active=${offStored?.is_active}`);
    } finally {
      await query('DELETE FROM companies WHERE id = ?', [id]);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async e => {
  console.error('\nverification crashed:', e);
  await pool.end();
  process.exit(1);
});

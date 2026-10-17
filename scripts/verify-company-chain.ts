/**
 * scripts/verify-company-chain.ts — company, work site, department, person.
 *
 *   npx tsx --env-file=.env.local scripts/verify-company-chain.ts
 *
 * THE CHAIN WAS ALREADY IN THE SCHEMA AND NONE OF IT WAS CONNECTED
 * ----------------------------------------------------------------
 * `locations.company_id` and `departments.company_id` both existed before this
 * test did - the first added this week, the second since the org migration -
 * and nothing in the application ever set either. So six work sites belonged
 * to no company, three departments belonged to no company, and seventeen
 * people were rostered at a site while one was placed in a department. Every
 * screen looked fine.
 *
 * What is asserted here is each hop, in both directions, plus the two things
 * that go wrong quietly:
 *
 *   A GAP. Something attached to nothing. Reported rather than hidden, because
 *   a screen that shows only what IS connected cannot tell anybody what is
 *   missing - and missing is the normal state of a chain nobody could see.
 *
 *   A DISAGREEMENT. Somebody rostered at one company's site while placed in
 *   another company's department. Both halves are deliberate acts, so this is
 *   reported and not refused: a group company moving somebody between two of
 *   its own entities is a real arrangement.
 */

import { NextRequest } from 'next/server';
import { GET as companiesGet, POST as companiesPost } from '../app/api/org/companies/route';
import { POST as departmentsPost } from '../app/api/org/departments/route';
import { POST as linksPost } from '../app/api/org/companies/links/route';
import { POST as locationsPost } from '../app/api/locations/route';
import { POST as employeesPost } from '../app/api/employees/route';
import { companyChain, chainGaps, companyLocations, listDepartments } from '../lib/org';
import { signAccessToken, currentTokenVersion } from '../lib/auth';
import { query, queryOne, pool } from '../lib/db';

let passed = 0;
let failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`); }
};
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, JSON.stringify(a) === JSON.stringify(b),
    `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

const COMPANIES = 'http://localhost:3000/api/org/companies';
const DEPARTMENTS = 'http://localhost:3000/api/org/departments';
const LINKS = 'http://localhost:3000/api/org/companies/links';
const LOCATIONS = 'http://localhost:3000/api/locations';
const EMPLOYEES = 'http://localhost:3000/api/employees';

const get = (token: string, url: string) =>
  new NextRequest(url, { headers: { Cookie: `access_token=${token}` } });
const post = (token: string, url: string, body: unknown) =>
  new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `access_token=${token}` },
    body: JSON.stringify(body),
  });

async function adminToken() {
  const e = await queryOne<{ id: number; emp_id: string; role: string }>(
    `SELECT id, emp_id, role FROM employees WHERE role = 'super_admin' AND is_active = 1 LIMIT 1`);
  if (!e) throw new Error('no active super_admin');
  const tv = await currentTokenVersion(e.id);
  return { token: signAccessToken({ id: e.id, emp_id: e.emp_id, role: e.role, tv } as never), id: e.id };
}

async function cleanup() {
  await query(
    `DELETE a FROM employee_org_assignments a JOIN employees e ON e.id = a.employee_id
      WHERE e.emp_id LIKE 'ZZCH%'`);
  await query(
    `DELETE es FROM employee_schedules es JOIN employees e ON e.id = es.employee_id
      WHERE e.emp_id LIKE 'ZZCH%'`);
  await query(
    `DELETE at FROM attendance at JOIN employees e ON e.id = at.employee_id
      WHERE e.emp_id LIKE 'ZZCH%'`);
  await query(`UPDATE employees SET manager_id = NULL WHERE emp_id LIKE 'ZZCH%'`);
  await query(`DELETE FROM employees WHERE emp_id LIKE 'ZZCH%'`);
  await query(`UPDATE companies SET registered_location_id = NULL WHERE legal_name LIKE 'ZZCH%'`);
  await query(`DELETE FROM locations WHERE name LIKE 'ZZCH%'`);
  await query(`DELETE FROM departments WHERE code LIKE 'ZZCH%' ORDER BY depth DESC`);
  await query(`DELETE FROM companies WHERE legal_name LIKE 'ZZCH%'`);
  await query(`DELETE FROM shifts WHERE name LIKE 'ZZCH%'`);
}

async function main() {
  try {
    await cleanup();
    const admin = await adminToken();

    // -------------------------------------------------------------------
    console.log('\n— a company —');
    const madeCompany = await companiesPost(post(admin.token, COMPANIES, {
      legal_name: 'ZZCH Holdings', country_code: 'IN', fy_start_month: 4,
      timezone: 'Asia/Kolkata', is_active: true,
    }));
    eq('it is created', madeCompany.status, 201);
    const companyId = (await madeCompany.json()).data.company.id as number;
    check('with an id', Boolean(companyId), String(companyId));

    const second = await companiesPost(post(admin.token, COMPANIES, {
      legal_name: 'ZZCH Other Entity', country_code: 'IN', fy_start_month: 4,
      timezone: 'Asia/Kolkata', is_active: true,
    }));
    const otherCompanyId = (await second.json()).data.company.id as number;

    console.log('\n— a work site, belonging to it —');
    const madeSite = await locationsPost(post(admin.token, LOCATIONS, {
      name: 'ZZCH Plant A', company_id: companyId, address: '1 Industrial Road',
      latitude: 13.0827, longitude: 80.2707, radius_meters: 150,
    }));
    eq('the site is created', madeSite.status, 201);
    // This endpoint returns the location itself as `data`, not wrapped.
    const siteId = (await madeSite.json()).data.id as number;

    const otherSite = await locationsPost(post(admin.token, LOCATIONS, {
      name: 'ZZCH Plant B', company_id: otherCompanyId,
      latitude: 12.9716, longitude: 77.5946, radius_meters: 150,
    }));
    const otherSiteId = (await otherSite.json()).data.id as number;

    const orphanSite = await locationsPost(post(admin.token, LOCATIONS, {
      name: 'ZZCH Orphan Site', latitude: 11.0, longitude: 77.0, radius_meters: 100,
    }));
    eq('a site with no company is still allowed', orphanSite.status, 201);

    const sites = await companyLocations(companyId);
    check('the company sees its own site',
      sites.some(l => l.id === siteId && l.company_id === companyId),
      `${sites.length} offered`);

    console.log('\n— the registered office points back at the site —');
    const linked = await companiesPost(post(admin.token, COMPANIES, {
      id: companyId, legal_name: 'ZZCH Holdings', registered_location_id: siteId,
    }));
    eq('the company accepts it', linked.status, 200);
    const withOffice = (await (await companiesGet(get(admin.token, COMPANIES))).json())
      .data.companies.find((c: { id: number }) => c.id === companyId);
    eq('and reports the site by name', withOffice.registered_location_name, 'ZZCH Plant A');

    console.log('\n— a department, belonging to it —');
    const madeDept = await departmentsPost(post(admin.token, DEPARTMENTS, {
      name: 'ZZCH Operations', code: 'ZZCH-OPS', company_id: companyId,
    }));
    eq('the department is created', madeDept.status, 201);
    const deptId = (await madeDept.json()).data.department.id as number;

    const otherDept = await departmentsPost(post(admin.token, DEPARTMENTS, {
      name: 'ZZCH Other Ops', code: 'ZZCH-OTH', company_id: otherCompanyId,
    }));
    const otherDeptId = (await otherDept.json()).data.department.id as number;

    await departmentsPost(post(admin.token, DEPARTMENTS, {
      name: 'ZZCH Unowned', code: 'ZZCH-NONE',
    }));

    const departments = await listDepartments();
    const ours = departments.find(d => d.id === deptId);
    eq('and it knows its company', ours?.company_id, companyId);

    console.log('\n— a person, at the site and in the department —');
    await query(
      `INSERT INTO shifts (name, type, start_time, end_time, working_days, grace_minutes)
       VALUES ('ZZCH Day', 'fixed', '09:00:00', '18:00:00',
               JSON_ARRAY('Mon','Tue','Wed','Thu','Fri','Sat'), 10)`);
    const shiftId = Number((await queryOne<{ id: number }>(
      `SELECT id FROM shifts WHERE name = 'ZZCH Day'`))?.id);

    const madePerson = await employeesPost(post(admin.token, EMPLOYEES, {
      emp_id: 'ZZCH001', name: 'ZZCH Joined Up', pin: '4821', role: 'employee',
      department_id: deptId, shift_id: shiftId, location_id: siteId,
      schedule_effective_from: '2026-01-01',
    }));
    eq('the employee is created', madePerson.status, 201);
    const personBody = await madePerson.json();
    const personId = personBody.data.id as number;
    eq('with no complaint about the chain',
      (personBody.data.notes ?? []).filter((n: string) => n.includes('different company')), []);

    // Each hop, walked in SQL rather than trusted.
    const walk = await queryOne<{
      person: string; site: string; site_company: string;
      department: string; dept_company: string;
    }>(
      `SELECT e.name AS person, l.name AS site, lc.legal_name AS site_company,
              d.name AS department, dc.legal_name AS dept_company
         FROM employees e
         JOIN employee_schedules es ON es.employee_id = e.id
         JOIN locations l ON l.id = es.location_id
         JOIN companies lc ON lc.id = l.company_id
         JOIN employee_org_assignments a ON a.employee_id = e.id
         JOIN departments d ON d.id = a.department_id
         JOIN companies dc ON dc.id = d.company_id
        WHERE e.id = ?`,
      [personId]);
    check('the whole chain resolves in one join', walk !== null && walk !== undefined,
      walk ? `${walk.person} -> ${walk.site} -> ${walk.site_company}` : 'broken');
    eq('the site belongs to the company', walk?.site_company, 'ZZCH Holdings');
    eq('and so does the department', walk?.dept_company, 'ZZCH Holdings');

    console.log('\n— the chain, counted —');
    const chain = (await companyChain()).find(c => c.company_id === companyId);
    check('the company appears', Boolean(chain), JSON.stringify(chain));
    eq('one site', chain?.sites, 1);
    eq('one department', chain?.departments, 1);
    eq('one person by department', chain?.people_by_department, 1);
    eq('one person by work site', chain?.people_by_site, 1);
    check('and the two agree, which is the point',
      chain?.people_by_department === chain?.people_by_site);

    console.log('\n— what is attached to nothing —');
    const gaps = await chainGaps();
    check('the orphan site is named',
      gaps.sites_without_company.some(x => x.name === 'ZZCH Orphan Site'),
      `${gaps.sites_without_company.length} sites with no company`);
    check('the unowned department is named',
      gaps.departments_without_company.some(x => x.name === 'ZZCH Unowned'),
      `${gaps.departments_without_company.length} departments with no company`);

    console.log('\n— a person in two companies at once —');
    // Rostered at this company's site, placed in the other company's
    // department. Both are legal acts; the disagreement is what gets said.
    const crossed = await employeesPost(post(admin.token, EMPLOYEES, {
      emp_id: 'ZZCH002', name: 'ZZCH Split Person', pin: '4821', role: 'employee',
      department_id: otherDeptId, shift_id: shiftId, location_id: siteId,
      schedule_effective_from: '2026-01-01',
    }));
    eq('they are still created', crossed.status, 201);
    const crossedBody = await crossed.json();
    const warning = (crossedBody.data.notes ?? [])
      .find((n: string) => n.includes('different company'));
    check('and warned about, not refused', Boolean(warning), warning ?? 'no warning');
    check('the warning names the site and the department',
      Boolean(warning?.includes('ZZCH Plant A') && warning?.includes('ZZCH Other Ops')),
      warning ?? '');

    const afterCross = await chainGaps();
    check('the disagreement is on the list too',
      afterCross.people_in_two_companies.some(x => x.emp_id === 'ZZCH002'),
      `${afterCross.people_in_two_companies.length} split`);

    console.log('\n— a site that belongs to nobody raises nothing —');
    const neutral = await employeesPost(post(admin.token, EMPLOYEES, {
      emp_id: 'ZZCH003', name: 'ZZCH Neutral', pin: '4821', role: 'employee',
      department_id: deptId, shift_id: shiftId,
      schedule_effective_from: '2026-01-01',
      location_id: (await queryOne<{ id: number }>(
        `SELECT id FROM locations WHERE name = 'ZZCH Orphan Site'`))?.id,
    }));
    const neutralNotes = (await neutral.json()).data.notes ?? [];
    eq('no warning when there is nothing to compare',
      neutralNotes.filter((n: string) => n.includes('different company')), []);

    console.log('\n— what belongs to a company, set from the company —');
    // The two links were only settable from the other end, so a company said
    // it had nothing and the fix was on another screen. A list REPLACES the
    // set: anything listed is attached, anything attached and not listed is
    // detached, and leaving a side out leaves that side alone.
    const companyOf = async (table: 'locations' | 'departments', id: number) =>
      (await queryOne<{ company_id: number | null }>(
        `SELECT company_id FROM ${table} WHERE id = ?`, [id]))?.company_id ?? null;

    const bothSites = await linksPost(post(admin.token, LINKS, {
      company_id: companyId, location_ids: [siteId, otherSiteId],
    }));
    eq('the links endpoint answers', bothSites.status, 200);
    // The counts are what belongs to the company NOW, not what this call
    // changed - the fixture department was attached when it was created, and a
    // call that never mentioned departments still reports it.
    eq('and says what belongs to it now',
      (await bothSites.json()).data, { sites: 2, departments: 1 });
    eq('a site moves to the company that claimed it',
      Number(await companyOf('locations', otherSiteId)), companyId);

    // The same call again with only one: the other must be let go.
    await linksPost(post(admin.token, LINKS, {
      company_id: companyId, location_ids: [siteId],
    }));
    eq('a list replaces the set, so what is left out is detached',
      await companyOf('locations', otherSiteId), null);
    eq('and what is listed stays', Number(await companyOf('locations', siteId)), companyId);

    // Departments were not mentioned, so they must be untouched.
    await linksPost(post(admin.token, LINKS, {
      company_id: companyId, department_ids: [deptId],
    }));
    eq('a department can be attached from the company',
      Number(await companyOf('departments', deptId)), companyId);
    eq('and leaving sites out of that call left them alone',
      Number(await companyOf('locations', siteId)), companyId);

    // An empty list is a statement, not a no-op: nothing belongs here.
    await linksPost(post(admin.token, LINKS, {
      company_id: companyId, department_ids: [],
    }));
    eq('an empty list detaches everything on that side',
      await companyOf('departments', deptId), null);

    // Put the fixture back the way the rest of the run expects it.
    await linksPost(post(admin.token, LINKS, {
      company_id: otherCompanyId, location_ids: [otherSiteId],
    }));
    await linksPost(post(admin.token, LINKS, {
      company_id: companyId, department_ids: [deptId],
    }));

    const refused = await linksPost(post(admin.token, LINKS, {
      company_id: 0, location_ids: [],
    }));
    eq('a company id of zero is refused', refused.status, 400);

    console.log('\n— and through the API —');
    const res = await companiesGet(get(admin.token, COMPANIES));
    eq('the companies endpoint answers', res.status, 200);
    const body = await res.json();
    check('with the chain', Array.isArray(body.data.chain) && body.data.chain.length > 0);
    check('the gaps', typeof body.data.gaps === 'object' && body.data.gaps !== null);
    check('and the sites to choose a registered office from',
      Array.isArray(body.data.locations) && body.data.locations.length > 0,
      `${body.data.locations?.length} sites`);
    const listed = body.data.locations.find((l: { id: number }) => l.id === otherSiteId);
    eq('each site knows its company', listed?.company_id, otherCompanyId);
  } finally {
    await cleanup();
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });

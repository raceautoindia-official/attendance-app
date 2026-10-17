/**
 * scripts/verify-nav.ts — the navigation definition.
 *
 *   npx tsx scripts/verify-nav.ts
 *
 * No database: lib/nav.ts is plain data and pure functions, which is why it was
 * written that way. What this guards is the two failure modes the old
 * hand-maintained menu actually hit:
 *
 *   A PAGE WITH NO ENTRY. `/review` and `/regularisations` existed, worked, and
 *   appeared in no menu, so two finished features could only be reached by
 *   typing the URL. The filesystem check below makes that a failing test rather
 *   than a discovery months later.
 *
 *   ACCESS QUIETLY REMOVED. The rail now asks the permission system instead of
 *   a hard-coded `superAdminOnly` flag. Nobody holds a role yet, so if it asked
 *   permissions alone it would hide pages managers use today. The regression
 *   block asserts that every page a manager could open before is still offered.
 */

import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import {
  SECTIONS, canSee, visibleSections, sectionHref, sectionForPath, itemForPath,
  allVisibleItems, titleForPath, type NavAccess,
} from '../lib/nav';

let passed = 0;
let failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`); }
};
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, JSON.stringify(a) === JSON.stringify(b),
    `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

const superAdmin: NavAccess = {
  isSuperAdmin: true, explicit: false, legacyRole: 'super_admin', grants: {},
};
const legacyManager: NavAccess = {
  isSuperAdmin: false, explicit: false, legacyRole: 'manager', grants: {},
};
const legacyEmployee: NavAccess = {
  isSuperAdmin: false, explicit: false, legacyRole: 'employee', grants: {},
};
/** Somebody who has been given a real role, granting two things. */
const rolled: NavAccess = {
  isSuperAdmin: false, explicit: true, legacyRole: 'manager',
  grants: { 'attendance.view': 'department', 'reports.view': 'department' },
};
/** A role that grants nothing, which must mean nothing. */
const emptyRole: NavAccess = {
  isSuperAdmin: false, explicit: true, legacyRole: 'super_admin', grants: {},
};

const hrefsOf = (a: NavAccess) => allVisibleItems(a).map(i => i.href);

console.log('shape');
check('six sections', SECTIONS.length === 6, `${SECTIONS.length}`);
const allHrefs = SECTIONS.flatMap(s => s.items.map(i => i.href));
eq('no page appears in two sections', allHrefs.length, new Set(allHrefs).size);
check('every section has at least one page', SECTIONS.every(s => s.items.length > 0));
check('every section has an icon', SECTIONS.every(s => s.icon.length > 0));
check('exactly one section carries the badge',
  SECTIONS.filter(s => s.badge).length === 1);
check('every item has a hint for the palette',
  SECTIONS.flatMap(s => s.items).every(i => (i.hint ?? '').length > 0));
check('every href is absolute', allHrefs.every(h => h.startsWith('/')));

console.log('\nevery admin page is reachable from the menu');
// The bug this exists for: a page that exists and is in no menu.
const adminDir = join(process.cwd(), 'app', '(admin)');

/** Every page under (admin), including nested ones like /pay/statutory. */
function findPages(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // Route groups and dynamic segments are not destinations.
    if (entry.name.startsWith('(') || entry.name.startsWith('[')) continue;
    const here = `${prefix}/${entry.name}`;
    if (existsSync(join(dir, entry.name, 'page.tsx'))) out.push(here);
    out.push(...findPages(join(dir, entry.name), here));
  }
  return out;
}
const pageDirs = findPages(adminDir);
check('the admin pages were found on disk', pageDirs.length > 10, `${pageDirs.length} pages`);

// `/hours` is the one deliberate exemption: it only forwards to /reports, and
// an entry for it would be a second door to the same room.
const EXEMPT = ['/hours'];
const missing = pageDirs.filter(p => !allHrefs.includes(p) && !EXEMPT.includes(p));
eq('no page is missing from the menu', missing, []);
const dangling = allHrefs.filter(h => !pageDirs.includes(h));
eq('no menu entry points at a page that does not exist', dangling, []);

console.log('\nwho sees what');
eq('a super admin sees every page', hrefsOf(superAdmin).length, allHrefs.length);
check('an employee sees nothing in the admin rail',
  hrefsOf(legacyEmployee).length === 0, `${hrefsOf(legacyEmployee).length}`);
check('a role that grants nothing sees only the pages that need no permission',
  hrefsOf(emptyRole).every(h => {
    const item = SECTIONS.flatMap(s => s.items).find(i => i.href === h);
    return item?.perm === null;
  }), hrefsOf(emptyRole).join(', '));
check('a granted role sees exactly what it was granted, plus the unguarded pages',
  hrefsOf(rolled).every(h => {
    const item = SECTIONS.flatMap(s => s.items).find(i => i.href === h);
    return item?.perm === null || item?.perm === 'attendance.view' || item?.perm === 'reports.view';
  }), hrefsOf(rolled).join(', '));
check('a granted role does NOT see the settings pages',
  !hrefsOf(rolled).includes('/policies') && !hrefsOf(rolled).includes('/access'));

console.log('\nnothing a manager could open has been taken away');
// The rail before this change: eighteen entries, six of them super-admin only.
const OLD_MANAGER_PAGES = [
  '/overview', '/onboarding', '/employees', '/attendance', '/notifications',
  '/live-tracking', '/documents', '/schedules', '/leaves', '/permissions',
  '/performance', '/reports',
];
const nowVisible = hrefsOf(legacyManager);
for (const page of OLD_MANAGER_PAGES) {
  check(`a manager can still reach ${page}`, nowVisible.includes(page));
}
const OLD_SUPER_ONLY = ['/organisation', '/policies', '/holidays', '/locations', '/access', '/audit-log'];
for (const page of OLD_SUPER_ONLY) {
  check(`${page} is still super-admin only`, !nowVisible.includes(page));
}
check('and the two pages that had no entry at all now have one',
  nowVisible.includes('/review') && nowVisible.includes('/regularisations'));

console.log('\nsections');
const adminSections = visibleSections(superAdmin);
eq('a rail entry leads to the first page in its section',
  adminSections.map(s => sectionHref(s)),
  ['/overview', '/inbox', '/employees', '/attendance', '/reports', '/policies']);
eq('a manager lands on the first page they may open',
  visibleSections(legacyManager).map(s => sectionHref(s)),
  ['/overview', '/inbox', '/employees', '/attendance', '/reports']);
// Today, Inbox, People, Time, Insight. Settings is super-admin only, and Pay
// no longer exists.
check('a manager gets five sections, not six',
  visibleSections(legacyManager).length === 5,
  `${visibleSections(legacyManager).length}`);
// Work sites sit with the company profile now, and both are super-admin only.
check('and work sites are not among them',
  !hrefsOf(legacyManager).includes('/locations'));
check('a granted role without location.manage cannot see them',
  !hrefsOf(rolled).includes('/locations'));
check('one granted location.manage can',
  hrefsOf({ ...rolled, grants: { 'location.manage': 'all' } }).includes('/locations'));
check('and work sites live under People, beside the company profile',
  sectionForPath('/locations')?.key === 'people',
  sectionForPath('/locations')?.key ?? 'none');
eq('an employee gets none', visibleSections(legacyEmployee).length, 0);

console.log('\nwhich section a path belongs to');
eq('an exact page', sectionForPath('/employees')?.key, 'people');
eq('a child page highlights its parent', sectionForPath('/employees/17')?.key, 'people');
eq('the inbox', sectionForPath('/inbox')?.key, 'inbox');
eq('month review sits in the inbox', sectionForPath('/review')?.key, 'inbox');
eq('corrections too', sectionForPath('/regularisations')?.key, 'inbox');
eq('reports is insight', sectionForPath('/reports')?.key, 'insight');
eq('/hours is aliased to reports rather than going blank',
  sectionForPath('/hours')?.key, 'insight');
eq('an unknown path belongs to nothing', sectionForPath('/nowhere'), null);

console.log('\nthe active tab');
eq('exact', itemForPath('/leaves')?.label, 'Leave');
eq('child', itemForPath('/employees/17')?.label, 'Employees');
eq('alias', itemForPath('/hours')?.label, 'Reports & hours');
// '/review' must not match '/reports' or the wrong tab lights up.
eq('a shared prefix does not win', itemForPath('/review')?.label, 'Month review');
eq('unknown', itemForPath('/nope'), null);
// The longest-match rule still matters for child routes like /employees/17,
// which is asserted above. There is no nested TAB in the menu now that Pay has
// gone, and the filesystem sweep still walks nested directories so one can be
// added without the check going quiet.
eq('a child route under a tab still matches that tab',
  itemForPath('/employees/17/documents')?.label, 'Employees');

console.log('\npage titles');
eq('a titled page', titleForPath('/organisation'), 'Organisation');
eq('the inbox', titleForPath('/inbox'), 'Needs a decision');
eq('a page outside the menu falls back', titleForPath('/nope'), 'Admin');
check('no admin page is left titled "Admin"',
  pageDirs.filter(p => !EXEMPT.includes(p)).every(p => titleForPath(p) !== 'Admin'),
  pageDirs.filter(p => !EXEMPT.includes(p) && titleForPath(p) === 'Admin').join(', '));

console.log('\ncanSee, directly');
const settings = SECTIONS.find(s => s.key === 'settings')!;
const auditLog = settings.items.find(i => i.href === '/audit-log')!;
check('super admin bypass wins even with no grants', canSee(auditLog, superAdmin));
check('a legacy manager cannot see the audit log', !canSee(auditLog, legacyManager));
check('a role granting audit.view can',
  canSee(auditLog, { ...rolled, grants: { 'audit.view': 'all' } }));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

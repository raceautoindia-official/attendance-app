/**
 * scripts/verify-setup-guide.ts — the guided setup, checked end to end.
 *
 *   npx tsx --env-file=.env.local scripts/verify-setup-guide.ts
 *
 * The guide walks a new administrator through building a workspace in the order
 * it has to be built. Two things make it a flow rather than a tour, and both
 * are the sort of thing that breaks silently:
 *
 *   IT POINTS AT REAL CONTROLS. Each step names a `data-tour` anchor. If a
 *   button is renamed, moved to another page or loses its attribute, the
 *   spotlight has nothing to find and the step becomes a paragraph of text
 *   pointing at nothing. Nobody would notice until a new customer did.
 *
 *   IT READS THE WORKSPACE. A step is done when the thing EXISTS, never
 *   because a tooltip was clicked. So the counts have to be right, and the
 *   order has to be the real dependency order: an employee cannot be created
 *   before a department exists, so the guide must not ask for one first.
 *
 * It also checks the overlay stays click-through. The spotlight is a hole, not
 * a picture - the person presses the actual button. A stray `pointer-events`
 * would turn the whole guide into a wall that cannot be used, while still
 * looking perfectly correct in a screenshot.
 */

import { readFileSync, existsSync } from 'fs';
import { setupState } from '../lib/setup';
import { SECTIONS } from '../lib/nav';
import type { AccessContext, Scope } from '../lib/access';
import { query, pool } from '../lib/db';

let passed = 0;
let failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`); }
};

/** The admin pages live under a route group, which is not part of the URL. */
function pageFor(href: string): string | null {
  const path = href.split('?')[0].replace(/^\//, '');
  for (const group of ['(admin)', '(employee)', '']) {
    const file = group
      ? `app/${group}/${path}/page.tsx`
      : `app/${path}/page.tsx`;
    if (existsSync(file)) return file;
  }
  return null;
}

const superAdmin: AccessContext = {
  employeeId: 1, legacyRole: 'super_admin',
  grants: new Map<string, Scope>(), isSuperAdmin: true, explicit: false,
};

/** Somebody who may only manage people — the common second administrator. */
const peopleOnly: AccessContext = {
  employeeId: 2, legacyRole: 'manager',
  grants: new Map<string, Scope>([['employee.manage', 'department']]),
  isSuperAdmin: false, explicit: true,
};

async function main() {
  console.log('\nGUIDED SETUP\n');

  const state = await setupState(superAdmin);

  // --- the steps themselves ------------------------------------------------
  check('the guide has steps', state.steps.length > 0, `${state.steps.length}`);

  const required = state.steps.filter(s => s.required).map(s => s.key);
  const expected = ['company', 'location', 'department', 'shift', 'policy', 'employee'];
  check('the essentials are the chain, in dependency order',
    JSON.stringify(required) === JSON.stringify(expected),
    required.join(' -> '));

  const keys = state.steps.map(s => s.key);
  check('every step key is unique', new Set(keys).size === keys.length);

  for (const s of state.steps) {
    if (!s.title.trim() || !s.why.trim() || !s.action.trim()) {
      check(`${s.key} says what to do`, false, 'a field is empty');
    }
  }
  check('every step says what it is for and what to do',
    state.steps.every(s => s.title.trim() && s.why.trim() && s.action.trim()));

  // --- where each step happens ---------------------------------------------
  console.log('\n— each step points at a page that exists —');
  const missingPages = state.steps.filter(s => pageFor(s.href) === null);
  check('every step lands on a real page', missingPages.length === 0,
    missingPages.map(s => `${s.key}:${s.href}`).join(', ') || `${state.steps.length} checked`);

  console.log('\n— and at a control on that page —');
  for (const s of state.steps) {
    if (!s.anchor) continue;
    const file = pageFor(s.href);
    if (!file) continue;
    const src = readFileSync(file, 'utf8');
    const needle = `data-tour="${s.anchor}"`;
    const hits = src.split(needle).length - 1;
    check(`${s.key} -> [${s.anchor}]`, hits === 1,
      hits === 0 ? `not on ${file}` : hits > 1 ? `${hits} of them on ${file}` : file);
  }

  // Anchors that exist in the app but no step uses are not an error — the
  // setup button marks itself so a future step can point at it.
  // What IS an error is an anchor used twice across the pages a step opens.

  // --- the tour, for somebody who did not build this workspace -------------
  console.log('\n- the tour walks places, not tasks -');
  check('there is a tour at all', state.tour.length > 0, `${state.tour.length} stops`);

  const sectionKeys = new Set(SECTIONS.map(x => x.key));
  const strayStops = state.tour.filter(t =>
    t.anchor !== null && !sectionKeys.has(t.anchor.replace(/^nav-/, '')));
  check('every stop points at a section of the rail that exists',
    strayStops.length === 0,
    strayStops.map(t => `${t.key}:${t.anchor}`).join(', ') || state.tour.map(t => t.anchor).join(', '));

  const sidebar = readFileSync('components/layout/Sidebar.tsx', 'utf8');
  check('the rail carries those anchors',
    sidebar.includes('data-tour={`nav-${section.key}`}'),
    'derived from the section key, so a new section is anchored by existing');

  const stopPages = state.tour.filter(t => pageFor(t.href) === null);
  check('every stop lands on a real page', stopPages.length === 0,
    stopPages.map(t => `${t.key}:${t.href}`).join(', ') || `${state.tour.length} checked`);

  check('every stop says what the screen is for',
    state.tour.every(t => t.title.trim() && t.what.trim()));

  // The tour shows the stops AND the setup steps in one list, so a key shared
  // between the two lists would collide as a React key and make two different
  // rows the same row.
  const everyKey = [...state.tour.map(t => t.key), ...state.steps.map(x => x.key)];
  check('no stop and step share a key',
    new Set(everyKey).size === everyKey.length,
    `${everyKey.length} rows in the tour`);

  // --- the counts are read, not remembered ---------------------------------
  console.log('\n— done is read from the workspace —');
  const [real] = await query<{
    companies: number; locations: number; departments: number;
    shifts: number; policies: number; employees: number;
  }>(
    `SELECT (SELECT COUNT(*) FROM companies WHERE is_active = TRUE) AS companies,
            (SELECT COUNT(*) FROM locations WHERE is_active = TRUE) AS locations,
            (SELECT COUNT(*) FROM departments WHERE is_active = TRUE) AS departments,
            (SELECT COUNT(*) FROM shifts) AS shifts,
            (SELECT COUNT(*) FROM policies WHERE is_active = TRUE) AS policies,
            (SELECT COUNT(*) FROM employees WHERE is_active = TRUE) AS employees`,
  );
  const countOf = (k: string) => state.steps.find(s => s.key === k)?.count ?? -1;
  check('the company count is the real one', countOf('company') === Number(real.companies),
    `${countOf('company')} vs ${real.companies}`);
  check('the work site count is the real one', countOf('location') === Number(real.locations),
    `${countOf('location')} vs ${real.locations}`);
  check('the shift count is the real one', countOf('shift') === Number(real.shifts),
    `${countOf('shift')} vs ${real.shifts}`);

  const employeeStep = state.steps.find(s => s.key === 'employee')!;
  check('one employee is not "your people"',
    employeeStep.done === (Number(real.employees) > 1),
    `${real.employees} on file — the administrator is one of them`);

  const doneMatchesCount = state.steps.every(s => (s.count > 0) === s.done || s.key === 'employee' || s.key === 'roster');
  check('a step is done exactly when the thing exists', doneMatchesCount);

  check('remaining is the undone essentials, in order',
    state.remaining.every(s => s.required && !s.done)
    && state.remaining.length === state.requiredTotal - state.requiredDone,
    `${state.remaining.length} left of ${state.requiredTotal}`);

  // --- it does not offer work somebody cannot do ---------------------------
  console.log('\n— filtered to what the person may actually do —');
  const limited = await setupState(peopleOnly);
  const limitedKeys = limited.steps.map(s => s.key);
  check('a people-only manager is not told to create the company',
    !limitedKeys.includes('company'), limitedKeys.join(', ') || 'no steps');
  check('but is still told to add their people', limitedKeys.includes('employee'));
  check('and their progress counts only their own steps',
    limited.requiredTotal === limited.steps.filter(s => s.required).length,
    `${limited.requiredDone}/${limited.requiredTotal}`);

  // --- the overlay must not become a wall ----------------------------------
  console.log('\n— the spotlight is a hole, not a picture —');
  const guide = readFileSync('components/setup/SetupGuide.tsx', 'utf8');
  check('the overlay lets clicks through to the real control',
    guide.includes('pointer-events-none'),
    'without this the highlighted button cannot be pressed');
  check('the card itself is still clickable',
    guide.includes('z-[61]') && guide.includes('z-[60]'),
    'the card sits above the dim');
  check('escape closes it', guide.includes("e.key === 'Escape'"));
  check('it waits for the control instead of measuring thin air',
    guide.includes('ANCHOR_TIMEOUT'));
  check('it re-reads the workspace while open, which is how a step ticks',
    guide.includes('refetchInterval'));
  check('skipping is remembered, so it stops nagging',
    guide.includes('DISMISS_KEY'));

  // Drawers and modals sit at z-50 and the guide's dim is above them, which
  // is right while it points at a button and wrong the moment that button
  // opens a form - the fields would be behind the dim with the card over
  // them. The guide stands down instead, and that is easy to lose in a
  // refactor because the guide looks perfectly correct until a form opens.
  check('the guide stands down while a form is open',
    guide.includes('dialogUp') && guide.includes('!dialogUp'),
    'otherwise it dims the very form it told you to open');

  const drawer = readFileSync('components/ui/Drawer.tsx', 'utf8');
  const modal = readFileSync('components/ui/Modal.tsx', 'utf8');
  check('a drawer says when it is open', drawer.includes('markDialogOpen'));
  check('a modal says when it is open', modal.includes('markDialogOpen'));
  check('and both release it again',
    drawer.includes('releaseDialog()') && modal.includes('releaseDialog()'),
    'a dialog that never releases leaves the guide hidden for good');

  // A finished workspace used to show 'Setup complete' and offer no way back
  // in - which left the one person who most needs a walkthrough, somebody
  // handed a login to a company set up years ago, with nothing to click.
  console.log('\n- and there is a way in once setup is done -');
  check('the button opens a menu rather than being a label',
    guide.includes('menuOpen'), 'a dead end otherwise');
  check('the tour can be started from the beginning',
    guide.includes("start('tour')"));
  check('the setup can be walked again when nothing is missing',
    guide.includes('remaining === 0') && guide.includes("start('setup')"));
  check('a walk can be restarted from inside it',
    guide.includes('onRestart') && guide.includes('Start over'));
  check('the tour never advances by itself',
    guide.includes("mode === 'tour'") && guide.includes("!step || mode === 'tour'"),
    'there is nothing to wait for, and bouncing while reading is unusable');

  const api = readFileSync('app/api/setup/route.ts', 'utf8');
  check('the setup endpoint is read-only',
    !/export async function (POST|PUT|PATCH|DELETE)\b/.test(api),
    'there is no progress to store, so there is nothing to write');

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async e => {
  console.error('\nverification crashed:', e);
  await pool.end();
  process.exit(1);
});

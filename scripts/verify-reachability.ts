/**
 * scripts/verify-reachability.ts — features that exist only in the API.
 *
 *   npx tsx scripts/verify-reachability.ts
 *
 * A STATIC check over the source, like verify-input-contracts. It needs no
 * database and no server, because the bug it looks for is not a runtime fault:
 * the code is correct, tested, audited, and no screen calls it. A feature
 * nobody can reach is a feature nobody has.
 *
 * WHAT IT FOUND WHEN IT WAS WRITTEN
 * ---------------------------------
 *  - month close and reopen: a whole sign-off feature with an audit trail and
 *    a reopen reason, and no button. The hours ledger told people to "close the
 *    month once it has been reviewed" and nothing could.
 *  - the holiday calendar was append-only. A date typed wrong stayed for good.
 *  - `set_rule`: seven alert rules, none of which could be switched off.
 *  - `run`: evaluate the rules now, for "the administrator who has just set a
 *    threshold and reasonably expects to see whether it caught anything".
 *  - `sync-shift`: put people on the shift their policy names, whose own
 *    comment said there was otherwise "no route to fixing it".
 *  - withdrawing a correction request, removing a permission request, and
 *    resetting a forgotten PIN - all built, none linked.
 *
 * HOW IT DECIDES
 * --------------
 * For each route under app/api it works out the URL, finds the write methods
 * and any `action` discriminators, and looks for a client file that mentions
 * the path. The method must then appear as a string in that file - which is
 * deliberately loose, because the app calls through helpers like
 * `send(url, body, 'PATCH')` and `method: editing ? 'PATCH' : 'POST'`, and a
 * checker that only understood `method: 'PATCH'` would cry wolf on both.
 *
 * ENDPOINTS WITH NO WEB CALLER ON PURPOSE
 * ---------------------------------------
 * The phone app and the scheduler are clients too. Those paths are listed in
 * NOT_FROM_THE_WEB with the reason, so a new unreachable route stands out
 * instead of joining a list nobody reads.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';

let passed = 0;
let failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`); }
};

/** Paths a browser is not supposed to call, and who calls them instead. */
const NOT_FROM_THE_WEB: Record<string, string> = {
  '/api/attendance/clock-in': 'the phone app',
  '/api/attendance/clock-out': 'the phone app',
  '/api/auth/mobile/login': 'the phone app',
  '/api/auth/mobile/refresh': 'the phone app',
  '/api/live-tracking/start': 'the phone app',
  '/api/live-tracking/ping': 'the phone app',
  '/api/cron/close-sessions': 'the scheduler',
  '/api/cron/mark-absent': 'the scheduler',
  '/api/cron/month-end-summary': 'the scheduler',
  '/api/cron/live-tracking-monitor': 'the scheduler',
};

const WRITE = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

function walk(dir: string, name: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, name));
    else if (entry === name) out.push(full);
  }
  return out;
}

function clientFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { out.push(...clientFiles(full)); continue; }
    if (!/\.tsx?$/.test(entry)) continue;
    if (entry === 'route.ts') continue;
    out.push(full);
  }
  return out;
}

const routeFiles = walk(join('app', 'api'), 'route.ts');
const clients = [...clientFiles('app'), ...clientFiles('components')]
  .map(f => ({ file: f, src: readFileSync(f, 'utf8') }));

const unreachableRoutes: string[] = [];
const unreachableActions: string[] = [];
const unsentMethods: string[] = [];

for (const file of routeFiles) {
  const src = readFileSync(file, 'utf8');
  const url = '/' + file
    .replace(/\\/g, '/')
    .replace(/^app\//, '')
    .replace(/\/route\.ts$/, '')
    .replace(/\/\([^)]*\)/g, '');

  const methods = WRITE.filter(m => new RegExp(`export async function ${m}\\b`).test(src));

  const actions = new Set<string>();
  for (const m of src.matchAll(/z\.literal\('([a-z_]+)'\)/g)) actions.add(m[1]);
  for (const grp of src.matchAll(/action: z\.enum\(\[([^\]]+)\]\)/g)) {
    for (const m of grp[1].matchAll(/'([a-z_]+)'/g)) actions.add(m[1]);
  }

  if (methods.length === 0 && actions.size === 0) continue;

  // A dynamic segment is matched by the literal prefix a caller would build.
  const probe = url.split('/[')[0];
  const mentions = clients.filter(c => c.src.includes(probe));

  if (mentions.length === 0) {
    if (!NOT_FROM_THE_WEB[url]) unreachableRoutes.push(`${url} (${methods.join(',')})`);
    continue;
  }

  for (const m of methods) {
    if (m === 'POST') continue; // the default, and always via a plain fetch
    const sent = mentions.some(c => c.src.includes(`'${m}'`) || c.src.includes(`"${m}"`));
    if (!sent) unsentMethods.push(`${url} ${m}`);
  }

  for (const a of actions) {
    const sent = mentions.some(c => c.src.includes(`'${a}'`));
    if (!sent) unreachableActions.push(`${url} ${a}`);
  }
}

console.log('\nREACHABILITY\n');

check('every write route has a screen that calls it',
  unreachableRoutes.length === 0,
  unreachableRoutes.join('; ') || 'none, apart from the phone and scheduler paths');

check('every edit or remove method is sent by a screen',
  unsentMethods.length === 0,
  unsentMethods.join('; ') || 'none');

check('every action a route accepts is sent by a screen',
  unreachableActions.length === 0,
  unreachableActions.join('; ') || 'none');

// The list above only helps while it stays honest. An entry for a path that no
// longer exists hides whatever replaced it.
const stale = Object.keys(NOT_FROM_THE_WEB).filter(url => {
  const asFile = join('app', ...url.slice(1).split('/'), 'route.ts');
  return !existsSync(asFile);
});
check('the phone-and-scheduler list has no dead entries', stale.length === 0,
  stale.join(', ') || 'none');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

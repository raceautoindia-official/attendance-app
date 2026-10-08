/**
 * scripts/verify-auth-navigation.ts — leaving the login screen.
 *
 *   npx tsx --env-file=.env.local scripts/verify-auth-navigation.ts
 *
 * The reported symptom was "correct credentials but navigation not working".
 * The credentials were fine and the cookie was set; the client was replaying a
 * cached answer.
 *
 * The proxy redirects an unauthenticated page request to /login?redirect=...
 * Next.js prefetches route payloads into the Router Cache and reuses them for
 * about thirty seconds, so a route prefetched while logged out has that
 * redirect as its cached payload. router.push() straight after signing in
 * replays it, and the screen bounces back to the login form.
 *
 * This checks the two halves that can regress silently:
 *   1. no auth transition goes through router.push — a reviewer cannot see the
 *      difference by reading the diff, because router.push is right everywhere
 *      else in the app
 *   2. the ?redirect= value is only honoured when it is a safe same-site path,
 *      because the whole point of that parameter is to send somebody somewhere
 *      immediately after they have typed their password
 */

import { readFileSync } from 'fs';
import { destinationFor } from '../lib/authNavigate';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

function main() {
  console.log('\n— no auth transition uses a client-side push —');
  const login = readFileSync('app/(auth)/login/page.tsx', 'utf8');
  const enrol = readFileSync('app/(auth)/register-passkey/page.tsx', 'utf8');

  check('the login page never calls router.push',
    !/router\.push\(/.test(login),
    (login.match(/router\.push\([^)]*\)/g) ?? []).join(', ') || 'none');
  check('it navigates through navigateAfterAuthChange instead',
    /navigateAfterAuthChange\(/.test(login));
  check('every destination it sends people to goes through that helper',
    (login.match(/navigateAfterAuthChange\(/g) ?? []).length >= 4,
    `${(login.match(/navigateAfterAuthChange\(/g) ?? []).length} call sites`);

  // Enrolment ends with a session that did not exist when the page loaded, so
  // the hop out of it crosses the same boundary. The hop BACK to /login does
  // not — there is no new session to carry — so router.push is correct there.
  check('leaving passkey enrolment is a hard load',
    /navigateAfterAuthChange\(skipDest\)/.test(enrol));

  console.log('\n— the helper itself does a full page load —');
  const helper = readFileSync('lib/authNavigate.ts', 'utf8');
  check('it assigns window.location rather than routing',
    /window\.location\.assign\(/.test(helper));
  // Comments stripped first: the file explains at length WHY router.push is
  // wrong here, and matching that prose would fail the check the documentation
  // exists to support.
  const helperCode = helper
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  check('and does not fall back to a client transition',
    !/router\.(push|replace)\(/.test(helperCode));

  console.log('\n— ?redirect= is honoured only when it is safe —');
  eq('a plain path is honoured', destinationFor('manager', '/hours'), '/hours');
  eq('a nested path is honoured', destinationFor('manager', '/reports/daily'), '/reports/daily');
  eq('nothing supplied falls back by role', destinationFor('manager', null), '/overview');
  eq('an employee lands on their own page', destinationFor('employee', null), '/dashboard');

  // Each of these would send somebody to another site moments after they typed
  // their password, which is the one moment that matters most.
  eq('an absolute URL is refused', destinationFor('manager', 'https://evil.example'), '/overview');
  eq('a protocol-relative URL is refused', destinationFor('manager', '//evil.example'), '/overview');
  eq('a scheme-only value is refused', destinationFor('manager', 'javascript:alert(1)'), '/overview');
  eq('an empty value is refused', destinationFor('manager', ''), '/overview');

  // Bouncing back to the login page would loop: sign in, land on /login, sign
  // in again.
  eq('/login is refused as a destination', destinationFor('manager', '/login'), '/overview');
  eq('and so is a /login with its own query', destinationFor('manager', '/login?x=1'), '/overview');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();

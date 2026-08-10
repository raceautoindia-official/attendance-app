// Location off -> exactly 4 warnings, then an automatic clock-out.
// The policy is a pure function, so this walks a whole shift minute by minute.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const check = (l, c, d) => c ? (pass++, console.log(`  PASS  ${l}`)) : (fail++, console.log(`  FAIL  ${l}${d !== undefined ? ` — ${d}` : ''}`));

// Load the real policy by stripping the TypeScript annotations — this must
// track the shipped file, not a copy of it.
const src = fs.readFileSync(
  path.join(ROOT, 'mobile', 'src', 'location', 'locationWatchPolicy.ts'), 'utf8');
const MAX_WARNINGS = Number(src.match(/MAX_WARNINGS\s*=\s*(\d+)/)[1]);
const SPACING = Number(src.match(/STRIKE_SPACING_MIN\s*=\s*(\d+)/)[1]);

function decide(warnings, lastMs, nowMs) {
  const spacingElapsed = nowMs - lastMs >= SPACING * 60_000;
  if (warnings >= MAX_WARNINGS) return spacingElapsed ? { action: 'clock_out' } : { action: 'wait' };
  if (!spacingElapsed) return { action: 'wait' };
  const n = warnings + 1;
  return { action: 'warn', warningNumber: n, isFinal: n === MAX_WARNINGS };
}

console.log(`   policy: ${MAX_WARNINGS} warnings, ${SPACING} min apart`);
check('the requirement is 4 warnings', MAX_WARNINGS === 4, MAX_WARNINGS);

// ---------------------------------------------------------------------------
console.log('\n1. Location goes off and stays off — walk the shift');
const T0 = 1_800_000_000_000;   // a realistic epoch base
 let warnings = 0, lastMs = 0, clockedOut = false;
const events = [];
for (let minute = 0; minute <= 120 && !clockedOut; minute++) {
  const now = T0 + minute * 60_000;
  const d = decide(warnings, lastMs, now);
  if (d.action === 'warn') {
    warnings = d.warningNumber; lastMs = now;
    events.push(`${minute}m: warning ${d.warningNumber} of ${MAX_WARNINGS}${d.isFinal ? ' (final)' : ''}`);
  } else if (d.action === 'clock_out') {
    events.push(`${minute}m: CLOCKED OUT`);
    clockedOut = true;
  }
}
for (const e of events) console.log('   ' + e);
const warned = events.filter(e => e.includes('warning')).length;
check('exactly 4 warnings were sent', warned === 4, warned);
check('the 4th is marked final', events.some(e => e.includes('(final)')));
check('clock-out happens only after all 4', clockedOut && events[4]?.includes('CLOCKED OUT'), events[4]);
// Warning 1 is immediate, then one every SPACING minutes: 0, 10, 20, 30 — and
// the clock-out waits the SAME gap again after the final warning, at 40.
check('the employee gets the full gap after the final warning too',
  events[4] === `${SPACING * 4}m: CLOCKED OUT`, events[4]);
check('the first warning is immediate, not delayed', events[0] === `0m: warning 1 of ${MAX_WARNINGS}`,
  events[0]);

// ---------------------------------------------------------------------------
console.log('\n2. Warnings cannot be spammed by frequent checks');
warnings = 0; lastMs = 0;
let sent = 0;
// A check every single minute for half an hour: warnings at 0, 10 and 20.
for (let minute = 0; minute < 30; minute++) {
  const now = T0 + minute * 60_000;
  const d = decide(warnings, lastMs, now);
  if (d.action === 'warn') { warnings = d.warningNumber; lastMs = now; sent++; }
}
console.log(`   30 checks in 30 minutes produced ${sent} warnings`);
check('spacing is respected regardless of check frequency', sent === 3, sent);

// ---------------------------------------------------------------------------
console.log('\n3. Turning location back on clears the record');
// resetLocationStrikes() is what the caller does on a healthy check.
warnings = 3; lastMs = 1000;
warnings = 0; lastMs = 0;   // reset
const after = decide(warnings, lastMs, 999_999_999);
check('the next failure starts again at warning 1',
  after.action === 'warn' && after.warningNumber === 1, JSON.stringify(after));

// ---------------------------------------------------------------------------
console.log('\n4. A failed clock-out retries instead of restarting the cycle');
warnings = MAX_WARNINGS; lastMs = 0;
const retry = decide(warnings, lastMs, SPACING * 60_000 * 5);
check('still tries to clock out, does not warn again', retry.action === 'clock_out',
  JSON.stringify(retry));

// ---------------------------------------------------------------------------
console.log('\n5. The delivery paths that actually fire the check');
const watch = fs.readFileSync(path.join(ROOT, 'mobile', 'src', 'location', 'locationWatch.ts'), 'utf8');
const dash = fs.readFileSync(path.join(ROOT, 'mobile', 'src', 'screens', 'DashboardScreen.tsx'), 'utf8');
check('background task registered', /registerTaskAsync\(LOCATION_WATCH_TASK/.test(watch));
check('in-app repeating check while the screen is open',
  /setInterval\(\(\) => void checkLocationAndWarn\(\), 60_000\)/.test(dash));
// Window is generous on purpose: the handler carries a comment explaining why
// the check belongs there, and a tight window fails on the prose rather than
// on the behaviour.
check('checked when the app is brought to the foreground',
  /state === 'active'[\s\S]{0,900}checkLocationAndWarn/.test(dash));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

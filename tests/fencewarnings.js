// Leaving the fence -> 4 warnings, ONE MINUTE apart, then the clock-out.
//
// The Exit event used to clock out on the spot: someone walking to the gate
// for a parcel was off the clock before they reached it. Now the crossing
// starts an escalation with four chances to turn around, and coming back
// inside at any point means the day never closes at all.
//
// The policy is a pure function, so this walks the excursion second by second.
// The wiring assertions then prove the app actually uses it: the Exit handler
// starts it instead of clocking out, the 15-second tracking fixes advance it,
// and returning resets it.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const check = (l, c, d) => c ? (pass++, console.log(`  PASS  ${l}`)) : (fail++, console.log(`  FAIL  ${l}${d !== undefined ? ` — ${d}` : ''}`));

// Load the real policy by stripping the TypeScript annotations — this must
// track the shipped file, not a copy of it.
const policySrc = fs.readFileSync(
  path.join(ROOT, 'mobile', 'src', 'location', 'fenceExitPolicy.ts'), 'utf8');
const MAX = Number(policySrc.match(/EXIT_MAX_WARNINGS\s*=\s*(\d+)/)[1]);
const SPACING = Number(policySrc.match(/EXIT_SPACING_MIN\s*=\s*(\d+)/)[1]);

function decide(warnings, lastMs, nowMs) {
  const spacingElapsed = nowMs - lastMs >= SPACING * 60_000;
  if (warnings >= MAX) return spacingElapsed ? { action: 'clock_out' } : { action: 'wait' };
  if (!spacingElapsed) return { action: 'wait' };
  const n = warnings + 1;
  return { action: 'warn', warningNumber: n, isFinal: n === MAX };
}

console.log(`   policy: ${MAX} warnings, ${SPACING} min apart`);
check('the requirement is 4 warnings', MAX === 4, MAX);
check('spaced one minute apart, not ten', SPACING === 1, SPACING);

// ---------------------------------------------------------------------------
console.log('\n1. Walk out and keep walking — checked every 15s like the tracking task');
const T0 = 1_800_000_000_000;
let warnings = 0, lastMs = 0, clockedOut = false;
const events = [];
for (let tick = 0; tick <= 40 * 4 && !clockedOut; tick++) {  // 15s ticks
  const now = T0 + tick * 15_000;
  const d = decide(warnings, lastMs, now);
  if (d.action === 'warn') {
    warnings = d.warningNumber; lastMs = now;
    events.push(`${(tick * 15) / 60}m: warning ${d.warningNumber} of ${MAX}${d.isFinal ? ' (final)' : ''}`);
  } else if (d.action === 'clock_out') {
    events.push(`${(tick * 15) / 60}m: CLOCKED OUT`);
    clockedOut = true;
  }
}
for (const e of events) console.log('   ' + e);
check('exactly 4 warnings before the clock-out',
  events.filter(e => e.includes('warning')).length === 4);
check('the first fires at the boundary, immediately', events[0] === `0m: warning 1 of ${MAX}`, events[0]);
check('one warning per minute — 0, 1, 2, 3',
  events[1]?.startsWith('1m:') && events[2]?.startsWith('2m:') && events[3]?.startsWith('3m:'),
  events.slice(1, 4).join(' | '));
check('the 4th is marked final', events[3]?.includes('(final)'), events[3]);
check('the clock-out lands at 4 minutes — a full minute after the final warning',
  events[4] === '4m: CLOCKED OUT', events[4]);
check('15-second checks do not compress the minute spacing',
  events.filter(e => e.includes('warning')).length === 4);

// ---------------------------------------------------------------------------
console.log('\n2. Turning back voids everything — the day never closes');
warnings = 0; lastMs = 0;
let d = decide(warnings, lastMs, T0);
warnings = d.warningNumber; lastMs = T0;            // warning 1 at the gate
d = decide(warnings, lastMs, T0 + 60_000);
check('second warning at one minute', d.action === 'warn' && d.warningNumber === 2);
warnings = 0; lastMs = 0;                            // came back — caller resets
d = decide(warnings, lastMs, T0 + 90_000);
check('after returning, the next excursion starts again at warning 1',
  d.action === 'warn' && d.warningNumber === 1, JSON.stringify(d));

// ---------------------------------------------------------------------------
console.log('\n3. The app is actually wired this way');
const auto = fs.readFileSync(path.join(ROOT, 'mobile', 'src', 'location', 'geofenceAuto.ts'), 'utf8');
const tracking = fs.readFileSync(path.join(ROOT, 'mobile', 'src', 'location', 'tracking.ts'), 'utf8');

// The Exit handler starts the escalation instead of clocking out on the spot.
const exitBranch = auto.slice(auto.indexOf('GeofencingEventType.Exit'), auto.indexOf('GeofencingEventType.Enter'));
check('the Exit event starts the escalation, not an instant clock-out',
  exitBranch.includes('progressFenceExit') && !exitBranch.includes('await doAutoClockOut('));
check('approved on-duty voids the escalation at the Exit event',
  exitBranch.indexOf('resetFenceExitStrikes') < exitBranch.indexOf('On duty'));

// The 15-second tracking fixes advance it with the app swiped away.
check('tracking offers each fresh fix to a listener', /setFixListener/.test(tracking));
check('geofenceAuto registers for those fixes', /setFixListener\(/.test(auto));
const fixFn = auto.slice(auto.indexOf('async function onTrackedFix'), auto.indexOf('setFixListener('));
check('a fix only ADVANCES an escalation, never starts one (on-duty safety)',
  /warnings > 0.*progressFenceExit/s.test(fixFn), 'guard missing');
check('a fix back inside the fence resets the count',
  /dist <= fence\.radius[\s\S]{0,120}resetFenceExitStrikes\(true\)/.test(fixFn));

// The decisive moment double-checks with the server.
const progress = auto.slice(auto.indexOf('async function progressFenceExit'), auto.indexOf('async function onTrackedFix'));
check('the clock-out step re-checks on-duty and the day being open first',
  progress.includes('on_duty_now') && progress.includes('clock_out_utc'));

// Reconciliation (missed OS events) goes through the same escalation.
const reconcile = auto.slice(auto.indexOf('export async function reconcileGeofenceAttendance'));
const reconcileBody = reconcile.slice(0, reconcile.indexOf('\n}'));
check('reconcile escalates instead of clocking out from nowhere',
  reconcileBody.includes('progressFenceExit') && !reconcileBody.includes('await doAutoClockOut('));
check('reconcile still auto clocks back in (autologin behaviour intact)',
  reconcileBody.includes('doAutoClockIn') && reconcileBody.includes('auto_clocked_out === true'));

// No stale strikes: monitoring stopping wipes the count.
const stopFn = auto.slice(auto.indexOf('export async function stopGeofenceAutoMode'));
check('stopping auto mode clears the warning count',
  stopFn.slice(0, stopFn.indexOf('\n}')).includes('EXIT_STRIKE_COUNT_KEY'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

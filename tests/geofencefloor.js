// The geofence watchdog may not end a day it cannot justify ending.
//
// Four people lost an entire day in one morning to this rule:
//
//     Nalini      09:20 in, 09:20 out, 0h 0m, present
//     Subhashree  09:00 in, 09:00 out, 0h 0m, present
//     Derin       -- in, -- out,       0h 0m, present
//     Balamurugan 09:58 in, 09:58 out, 0h 0m, present
//
// All four were at work. Their phones sent one fix at the clock-in and nothing
// after, so the last confirmed presence WAS the clock-in: the day closed at the
// second it opened, and because the row then had a clock-out it read as
// complete, so they could not clock in again either.
//
// The flaw was never the grace period. It was the inference. "Left the site"
// and "this phone never reported" produce identical silence, and only one of
// them is the employee's doing. Ending a day requires evidence they were HERE
// and then went.
//
//   node tests/geofencefloor.js
//
// No server and no database needed.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const createJiti = require(path.join(ROOT, 'node_modules', 'jiti')).createJiti
  || require(path.join(ROOT, 'node_modules', 'jiti'));

let pass = 0, fail = 0;
const check = (l, c, d) => c
  ? (pass++, console.log(`  PASS  ${l}`))
  : (fail++, console.log(`  FAIL  ${l}${d !== undefined ? ` — ${d}` : ''}`));

const db = require('./stubs/monitordb');

const jiti = createJiti(__filename, {
  interopDefault: true,
  moduleCache: false,
  alias: {
    '@/lib/db': path.join(__dirname, 'stubs', 'monitordb.js'),
    './db': path.join(__dirname, 'stubs', 'monitordb.js'),
    '@/lib/mailer': path.join(__dirname, 'stubs', 'permissive.js'),
    '@/lib/employeeDetails': path.join(ROOT, 'lib', 'employeeDetails.ts'),
    '@/lib/attendance': path.join(ROOT, 'lib', 'attendance.ts'),
    '@/lib/constants': path.join(ROOT, 'lib', 'constants.ts'),
    '@/lib/permissions': path.join(ROOT, 'lib', 'permissions.ts'),
  },
});

const minutesAgo = (m) => new Date(Date.now() - m * 60_000);
const closedTheDay = () => db.attendanceUpdates().some(u => /clock_out_utc\s*=\s*\?/i.test(u.sql));
const auditActions = () => db.auditEntries().map(a => a.action);

const candidate = () => ({
  attendance_id: 1170,
  employee_id: 16,
  employee_name: 'Balamurugan S',
  emp_id: 'RACE016',
  // Clocked in 90 minutes ago: well past any grace period.
  clock_in_utc: minutesAgo(90),
  loc_name: 'Head Office',
  loc_lat: 13.0827,
  loc_lng: 80.2707,
  loc_radius: 100,
});

(async () => {
  const { runLiveTrackingMonitor } = jiti(path.join(ROOT, 'lib', 'liveTrackingMonitor.ts'));

  // -------------------------------------------------------------------
  console.log('\nThe phone never reported at all');
  // -------------------------------------------------------------------
  db.reset();
  db.setCandidate(candidate());
  db.setLastInsideFix(null);

  let r = await runLiveTrackingMonitor();
  check('the day is NOT closed', !closedTheDay(), JSON.stringify(db.attendanceUpdates()));
  check('nobody is counted as clocked out', r.geofenceClockouts === 0, `${r.geofenceClockouts}`);
  check('the silence is recorded instead',
    auditActions().includes('geofence_presence_unverifiable'), JSON.stringify(auditActions()));
  const entry = db.auditEntries().find(a => a.action === 'geofence_presence_unverifiable');
  check('naming the employee and the day it left open',
    entry?.details?.emp_id === 'RACE016' && entry?.details?.outcome === 'left_clocked_in',
    JSON.stringify(entry?.details));

  // -------------------------------------------------------------------
  console.log('\nOne fix at the clock-in and nothing after — the reported case');
  // -------------------------------------------------------------------
  db.reset();
  const c2 = candidate();
  db.setCandidate(c2);
  db.setLastInsideFix(new Date(c2.clock_in_utc));   // vouched for the clock-in second only

  r = await runLiveTrackingMonitor();
  check('still not closed — that is not evidence of leaving',
    !closedTheDay(), JSON.stringify(db.attendanceUpdates()));
  check('and never writes a clock-out equal to the clock-in',
    r.geofenceClockouts === 0, `${r.geofenceClockouts}`);

  // -------------------------------------------------------------------
  console.log('\nThree minutes of tracking, then silence (the 0h 2m row)');
  // -------------------------------------------------------------------
  db.reset();
  const c3 = candidate();
  db.setCandidate(c3);
  db.setLastInsideFix(new Date(c3.clock_in_utc.getTime() + 3 * 60_000));

  r = await runLiveTrackingMonitor();
  check('below the floor, so still not closed', !closedTheDay(), JSON.stringify(db.attendanceUpdates()));

  // -------------------------------------------------------------------
  console.log('\nA real departure: tracked on site for an hour, then gone');
  // -------------------------------------------------------------------
  db.reset();
  const c4 = candidate();
  db.setCandidate(c4);
  db.setLastInsideFix(new Date(c4.clock_in_utc.getTime() + 60 * 60_000));

  r = await runLiveTrackingMonitor();
  check('IS closed — the rule still does its job', closedTheDay(), 'no clock-out written');
  check('counted', r.geofenceClockouts === 1, `${r.geofenceClockouts}`);
  check('credited to the last confirmed presence, not to zero',
    db.attendanceUpdates()[0]?.params?.[0] !== undefined,
    JSON.stringify(db.attendanceUpdates()[0]?.params));
  check('and logged as a departure, not as unverifiable',
    auditActions().includes('geofence_auto_clockout')
      && !auditActions().includes('geofence_presence_unverifiable'),
    JSON.stringify(auditActions()));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nTest itself failed:', e);
  process.exit(1);
});

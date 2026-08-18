// A phone may not end somebody's day on a rule the company has withdrawn.
//
// Employees working until 19:00 were reported clocked out at 17:47 — with the
// fences already disarmed. Disarming stopped the SERVER's watchdog and nothing
// else. There are three automatic clock-outs in this system and two of them
// live on the phone:
//
//   1. the server's geofence watchdog  — obeys employee_schedules
//   2. the phone's fence-exit rule     — obeys a fence stored on the device
//   3. the phone's location-off rule   — obeys nothing at all
//
// (3) is the one that matches the reports. It fires after four warnings ten
// minutes apart when the phone cannot get a fix — which on Android in the
// evening means battery saver, not an employee going home. It reports that the
// PHONE could not see, and says nothing whatever about where its owner is.
//
// A fleet on mixed builds cannot be fixed by shipping an APK, so the decision
// moved to the server: a 4xx, which every existing build already treats as
// "the server understood, stop enforcing".
//
//   node tests/autologoutguard.js
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

const db = require('./stubs/clockoutdb');

const jiti = createJiti(__filename, {
  interopDefault: true,
  moduleCache: false,
  alias: {
    '@/lib/db': path.join(__dirname, 'stubs', 'clockoutdb.js'),
    './db': path.join(__dirname, 'stubs', 'clockoutdb.js'),
    '@/lib/auth': path.join(__dirname, 'stubs', 'auth.js'),
    '@/lib/deviceBinding': path.join(__dirname, 'stubs', 'permissive.js'),
    '@/lib/locationTrust': path.join(__dirname, 'stubs', 'permissive.js'),
    '@/lib/mailer': path.join(__dirname, 'stubs', 'permissive.js'),
    '@/lib/employeeDetails': path.join(ROOT, 'lib', 'employeeDetails.ts'),
    '@/lib/attendance': path.join(ROOT, 'lib', 'attendance.ts'),
    '@/lib/constants': path.join(ROOT, 'lib', 'constants.ts'),
    '@/lib/types': path.join(ROOT, 'lib', 'types.ts'),
  },
});

const post = (body) => new Request('http://localhost/api/attendance/clock-out', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'user-agent': 'okhttp/4.9.2 AttendanceApp Android',
    'x-device-id': 'phone', Authorization: 'Bearer stub',
  },
  body: JSON.stringify(body),
});

const refusedEntry = () => db.auditEntries().find(a => a.action === 'auto_clock_out_refused');
const dayEnded = () => db.attendanceUpdates().length > 0;

(async () => {
  const { POST } = jiti(path.join(ROOT, 'app', 'api', 'attendance', 'clock-out', 'route.ts'));

  // -------------------------------------------------------------------
  console.log('\nPhone says "location was off" — the 17:47 reports');
  // -------------------------------------------------------------------
  db.reset();
  let res = await POST(post({ latitude: null, longitude: null, auto: true, reason: 'location_off' }));
  check('refused', res.status === 409, `${res.status}`);
  check('the day is NOT ended', !dayEnded(), JSON.stringify(db.attendanceUpdates()));
  check('and the phone fault is recorded',
    refusedEntry()?.details?.refused_because === 'location_off_enforcement_disabled',
    JSON.stringify(refusedEntry()?.details));

  // -------------------------------------------------------------------
  console.log('\nPhone says "left the fence" while fences are disarmed');
  // -------------------------------------------------------------------
  db.reset();
  db.setFenced(0);
  res = await POST(post({ latitude: 13.1, longitude: 80.3, auto: true, reason: 'geofence_exit' }));
  check('refused — that fence was withdrawn', res.status === 409, `${res.status}`);
  check('the day is NOT ended', !dayEnded(), JSON.stringify(db.attendanceUpdates()));
  check('recorded against the withdrawn fence',
    refusedEntry()?.details?.refused_because === 'geofencing_disabled_for_employee',
    JSON.stringify(refusedEntry()?.details));

  // -------------------------------------------------------------------
  console.log('\nPhone says "left the fence" and the fence IS in force');
  // -------------------------------------------------------------------
  db.reset();
  db.setFenced(1);
  res = await POST(post({ latitude: 13.1, longitude: 80.3, auto: true, reason: 'geofence_exit' }));
  check('allowed — the rule still works where it applies',
    res.status === 200, `${res.status}`);
  check('the day is ended', dayEnded(), 'no attendance UPDATE');
  check('and nothing is recorded as refused', !refusedEntry(), JSON.stringify(refusedEntry()));

  // -------------------------------------------------------------------
  console.log('\nA person tapping Clock Out');
  // -------------------------------------------------------------------
  db.reset();
  db.setFenced(0);
  res = await POST(post({ latitude: 13.08, longitude: 80.27 }));
  check('is never touched by any of this', res.status === 200, `${res.status}`);
  check('and their day ends as asked', dayEnded(), 'no attendance UPDATE');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nTest itself failed:', e);
  process.exit(1);
});

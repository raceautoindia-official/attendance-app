// Hours SO FAR, for somebody who is still at work.
//
// The Today Attendance screen read "—" under Total Hours for every employee
// currently clocked in — the whole company, all morning — because
// total_minutes is only written at clock-out. Beside a Break column showing
// "0h 0m", that looks exactly like a system recording nothing, which is how it
// was reported: "for all it is showing 0 m here".
//
// The data was right. The screen could not show it. A day in progress now
// carries a running total, derived the same way the clock-out will derive it,
// and is labelled so nobody mistakes it for a finished figure.
//
//   node tests/runningtotal.js
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

const db = require('./stubs/dayviewdb');

const jiti = createJiti(__filename, {
  interopDefault: true,
  moduleCache: false,
  alias: {
    '@/lib/db': path.join(__dirname, 'stubs', 'dayviewdb.js'),
    './db': path.join(__dirname, 'stubs', 'dayviewdb.js'),
    '@/lib/auth': path.join(__dirname, 'stubs', 'auth.js'),
    '@/lib/employeeDetails': path.join(ROOT, 'lib', 'employeeDetails.ts'),
    '@/lib/attendance': path.join(ROOT, 'lib', 'attendance.ts'),
    '@/lib/constants': path.join(ROOT, 'lib', 'constants.ts'),
    '@/lib/permissions': path.join(ROOT, 'lib', 'permissions.ts'),
    '@/lib/shifts': path.join(ROOT, 'lib', 'shifts.ts'),
    '@/lib/types': path.join(ROOT, 'lib', 'types.ts'),
  },
});

const minutesAgo = (m) => new Date(Date.now() - m * 60_000);

(async () => {
  const attendance = jiti(path.join(ROOT, 'lib', 'attendance.ts'));
  const TODAY = attendance.getWorkDateIST();
  const { GET } = jiti(path.join(ROOT, 'app', 'api', 'attendance', 'day', 'route.ts'));

  const call = async () => {
    const req = new Request(`http://localhost/api/attendance/day?date=${TODAY}`);
    const res = await GET(Object.assign(req, { nextUrl: new URL(req.url) }));
    const body = await res.json();
    return body.data?.employees ?? [];
  };

  const base = {
    employee_id: 1, employee_name: 'Nalini Thilagar', emp_id: 'RACE001', role: 'employee',
    attendance_id: 55, status: 'present', geofence_status: null, geofencing_enabled: 0,
    location_name: 'Race Auto', location_radius_m: 100, out_of_fence_reason: null,
    banked_minutes: 0, session_count: 1, expected_today: 1,
    shift_start_time: null, shift_grace_minutes: null, shift_type: null,
    permission_minutes: 0, required_minutes: 540, leave_type: null,
    first_clock_in_utc: null, clock_out_utc: null, total_minutes: null,
  };

  // -------------------------------------------------------------------
  console.log('\nStill clocked in, two hours in');
  // -------------------------------------------------------------------
  db.reset();
  db.setRows([{ ...base, clock_in_utc: minutesAgo(120) }]);
  let [e] = await call();
  check('the hours show, instead of a dash',
    e.worked_minutes !== null, `${e.worked_minutes}`);
  check('and they are the hours actually elapsed',
    Math.abs(e.worked_minutes - 120) <= 1, `${e.worked_minutes} minutes`);
  check('flagged as still running',
    e.in_progress === true, JSON.stringify(e.in_progress));

  // -------------------------------------------------------------------
  console.log('\nBack from lunch: a banked session plus the open one');
  // -------------------------------------------------------------------
  db.reset();
  db.setRows([{ ...base, clock_in_utc: minutesAgo(30), banked_minutes: 200, session_count: 2 }]);
  [e] = await call();
  check('the morning is not thrown away',
    Math.abs(e.worked_minutes - 230) <= 1, `${e.worked_minutes} minutes`);

  // -------------------------------------------------------------------
  console.log('\nA finished day');
  // -------------------------------------------------------------------
  db.reset();
  db.setRows([{ ...base, clock_in_utc: minutesAgo(300), clock_out_utc: minutesAgo(10), total_minutes: 290 }]);
  [e] = await call();
  check('reads its stored total, untouched', e.worked_minutes === 290, `${e.worked_minutes}`);
  check('and is NOT flagged as running', !e.in_progress, JSON.stringify(e.in_progress));

  // -------------------------------------------------------------------
  console.log('\nNot in yet');
  // -------------------------------------------------------------------
  db.reset();
  db.setRows([{ ...base, attendance_id: null, clock_in_utc: null, status: null }]);
  [e] = await call();
  check('still a dash — there is nothing to count',
    e.worked_minutes === null, `${e.worked_minutes}`);
  check('and not flagged as running', !e.in_progress, JSON.stringify(e.in_progress));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nTest itself failed:', e);
  process.exit(1);
});

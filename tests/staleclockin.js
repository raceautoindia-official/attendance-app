// "Already clocked in" over a Today card that shows nothing.
//
// Nalini opened the app at 9:24 on a Tuesday morning. Clock In: "-". Clock Out:
// "-". Hours: "-". And in red across the middle of the card, ALREADY CLOCKED IN.
//
// Both were true. The duplicate guard asks whether the employee has an open
// session ANYWHERE — deliberately, so a drifting server clock cannot let
// somebody clock in twice — while the Today card reads only today's row. A
// session left open on an earlier day therefore blocks this morning and is
// invisible on the screen that reports it. There is nothing to clock out of:
// the day it belongs to ended hours ago.
//
// The end-of-day sweep exists to settle exactly those, and when it runs there
// is no problem. This is about the morning after it did not — a restart across
// the 07:00 boundary, a minute of database trouble — where the cost landed on
// the employee as a day they could not start.
//
// A day that has ENDED is now settled in the clock-in path itself, and the
// clock-in carries on. A day that has NOT is still refused, because clocking in
// twice is a real mistake — but it says at what time, which is the fact that
// makes the message answerable.
//
//   node tests/staleclockin.js
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

// The clock-in route reaches a long way past the database — device binding,
// location trust, shifts, mail. Each is stubbed to "yes, fine", so what the
// test observes is the duplicate guard and nothing else.
const state = {
  openSession: null,      // the row the guard will find, or null
  closeCalledWith: null,  // what closeOpenSessions was asked to settle
  closeSettles: true,     // whether that settling actually works
  inserted: null,
};

const stub = (mod) => path.join(__dirname, 'stubs', mod);

const jiti = createJiti(__filename, {
  interopDefault: true,
  moduleCache: false,
  alias: {
    '@/lib/db': stub('clockindb.js'),
    // lib/geo and friends reach the pool by RELATIVE path, and importing the
    // real lib/db opens a connection at module load. Inside lib/, './db' is
    // that same module under its other name.
    './db': stub('clockindb.js'),
    '@/lib/auth': stub('auth.js'),
    '@/lib/closeSessions': stub('closesessions.js'),
    '@/lib/deviceBinding': stub('permissive.js'),
    '@/lib/locationTrust': stub('permissive.js'),
    '@/lib/mailer': stub('permissive.js'),
    '@/lib/jsonColumn': path.join(ROOT, 'lib', 'jsonColumn.ts'),
    '@/lib/employeeDetails': path.join(ROOT, 'lib', 'employeeDetails.ts'),
    '@/lib/attendance': path.join(ROOT, 'lib', 'attendance.ts'),
    '@/lib/constants': path.join(ROOT, 'lib', 'constants.ts'),
    '@/lib/geo': path.join(ROOT, 'lib', 'geo.ts'),
    '@/lib/shifts': path.join(ROOT, 'lib', 'shifts.ts'),
    '@/lib/permissions': path.join(ROOT, 'lib', 'permissions.ts'),
    '@/lib/fenceClosure': path.join(ROOT, 'lib', 'fenceClosure.ts'),
    '@/lib/types': path.join(ROOT, 'lib', 'types.ts'),
  },
});

const db = require('./stubs/clockindb');
const closer = require('./stubs/closesessions');

function clockInRequest() {
  return new Request('http://localhost/api/attendance/clock-in', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'user-agent': 'okhttp/4.9.2 AttendanceApp Android',
      'x-device-id': 'nalini-phone',
      Authorization: 'Bearer stub',
    },
    body: JSON.stringify({ latitude: 13.0827, longitude: 80.2707 }),
  });
}

(async () => {
  const attendance = jiti(path.join(ROOT, 'lib', 'attendance.ts'));
  const TODAY = attendance.getWorkDateIST();
  const YESTERDAY = attendance.previousWorkDate(TODAY);

  const route = jiti(path.join(ROOT, 'app', 'api', 'attendance', 'clock-in', 'route.ts'));
  const POST = route.POST;

  // -------------------------------------------------------------------
  console.log('\nA session left open on a day that has ended');
  // -------------------------------------------------------------------
  db.reset(); closer.reset();
  db.setOpenSession({
    id: 91,
    work_date: YESTERDAY,
    clock_in_utc: new Date(`${YESTERDAY}T03:35:00.000Z`), // 09:05 IST
  });
  closer.setSettles(true);

  let res = await POST(clockInRequest());
  let body = await res.json();

  check('the stale day is settled rather than blamed on the employee',
    closer.calledWith() !== null, 'closeOpenSessions was never called');
  check('and only for this employee',
    closer.calledWith()?.employeeId === 1, JSON.stringify(closer.calledWith()));
  check('the clock-in then goes through',
    res.status === 201 && body.success === true,
    `${res.status} ${JSON.stringify(body).slice(0, 140)}`);
  check('and a row is written for today',
    db.insertedRow() !== null, 'no INSERT reached the database');

  // -------------------------------------------------------------------
  console.log('\nAlready clocked in TODAY — still refused, but it says when');
  // -------------------------------------------------------------------
  db.reset(); closer.reset();
  db.setOpenSession({
    id: 92,
    work_date: TODAY,
    clock_in_utc: new Date(`${TODAY}T03:35:00.000Z`), // 09:05 IST
  });

  res = await POST(clockInRequest());
  body = await res.json();

  check('refused', res.status === 409 && body.success === false, `${res.status}`);
  check('today\'s own session is not swept away',
    closer.calledWith() === null, JSON.stringify(closer.calledWith()));
  check('and the message carries the time, in IST',
    /9:05\s*[AP]M/i.test(body.error ?? ''), body.error);

  // -------------------------------------------------------------------
  console.log('\nA stale day that could not be settled');
  // -------------------------------------------------------------------
  db.reset(); closer.reset();
  db.setOpenSession({
    id: 93,
    work_date: YESTERDAY,
    clock_in_utc: new Date(`${YESTERDAY}T03:35:00.000Z`),
  });
  closer.setSettles(false); // the sweep ran and the row is still open

  res = await POST(clockInRequest());
  body = await res.json();

  check('still refused rather than clocking in twice',
    res.status === 409, `${res.status}`);
  check('and it names the day and who can fix it',
    (body.error ?? '').includes(YESTERDAY) && /administrator/i.test(body.error ?? ''),
    body.error);

  // -------------------------------------------------------------------
  console.log('\nAn ordinary morning');
  // -------------------------------------------------------------------
  db.reset(); closer.reset();
  db.setOpenSession(null);

  res = await POST(clockInRequest());
  body = await res.json();
  check('clocks in', res.status === 201 && body.success === true,
    `${res.status} ${JSON.stringify(body).slice(0, 140)}`);
  check('without waking the settling sweep at all',
    closer.calledWith() === null, JSON.stringify(closer.calledWith()));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nTest itself failed:', e);
  process.exit(1);
});

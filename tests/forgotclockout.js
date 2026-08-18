// What a forgotten clock-out is worth.
//
// The reports were showing TWENTY-HOUR DAYS. The settling sweep credited
// elapsed time up to the day's 07:00 boundary, so somebody who clocked in at
// 09:00, worked their day and walked out without tapping the button was
// recorded as having worked until seven the next morning. Elapsed time is not
// worked time, and a figure that absurd discredits every honest figure beside
// it on the same page.
//
// The day is now settled at the last EVIDENCE the person was at work: their
// final live-tracking fix, or — when the phone left none — a normal day's
// length for them. Never past the boundary, never before the clock-in, and
// which of those produced the number is written on the audit entry so a total
// can be traced instead of argued about.
//
//   node tests/forgotclockout.js
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

const db = require('./stubs/closedb');

const jiti = createJiti(__filename, {
  interopDefault: true,
  moduleCache: false,
  alias: {
    '@/lib/db': path.join(__dirname, 'stubs', 'closedb.js'),
    './db': path.join(__dirname, 'stubs', 'closedb.js'),
    '@/lib/employeeDetails': path.join(ROOT, 'lib', 'employeeDetails.ts'),
    '@/lib/attendance': path.join(ROOT, 'lib', 'attendance.ts'),
    '@/lib/constants': path.join(ROOT, 'lib', 'constants.ts'),
    '@/lib/shifts': path.join(ROOT, 'lib', 'shifts.ts'),
    '@/lib/settlement': path.join(ROOT, 'lib', 'settlement.ts'),
  },
});

const hhmm = (d) => new Date(d).toISOString().slice(11, 16);
const minutesOf = () => db.updated()[0]?.total_minutes;
const basisOf = () => db.auditEntries()
  .find(a => a.action === 'session_auto_closed')?.details?.basis;

(async () => {
  const attendance = jiti(path.join(ROOT, 'lib', 'attendance.ts'));
  const { closeOpenSessions } = jiti(path.join(ROOT, 'lib', 'closeSessions.ts'));

  const TODAY = attendance.getWorkDateIST();
  const DAY = attendance.previousWorkDate(TODAY);
  // The reported case: arrived 09:45 IST (04:15 UTC), worked to 19:10 IST
  // (13:40 UTC). The day ends at 07:00 IST the following morning — 21h15m
  // after this clock-in, which is the number the reports were printing.
  const CLOCK_IN = new Date(`${DAY}T04:15:00.000Z`);
  const TO_BOUNDARY = 21 * 60 + 15;

  const row = (required) => ([{
    id: 77,
    employee_id: 12,
    work_date: DAY,
    clock_in_utc: CLOCK_IN,
    required_minutes: required,
  }]);

  // -------------------------------------------------------------------
  console.log('\nThe phone reported until they left');
  // -------------------------------------------------------------------
  db.reset();
  db.setPending(row(540));                                   // 9h roster
  db.setLastFix(new Date(`${DAY}T13:40:00.000Z`));           // 19:10 IST

  let closed = await closeOpenSessions();
  check('the day is settled', closed === 1, `closed ${closed}`);
  check('at the last tracked position, not the boundary',
    hhmm(db.updated()[0]?.clock_out_utc.replace(' ', 'T') + 'Z') === '13:40',
    db.updated()[0]?.clock_out_utc);
  check('crediting the hours really spent there (9h 25m)',
    minutesOf() === 565, `${minutesOf()} minutes`);
  check('and saying so', basisOf() === 'last_tracked_position', basisOf());

  // -------------------------------------------------------------------
  console.log('\nThe phone left no trace at all');
  // -------------------------------------------------------------------
  db.reset();
  db.setPending(row(540));
  db.setLastFix(null);

  await closeOpenSessions();
  check('a normal day is credited, NOT the 22 hours to the boundary',
    minutesOf() === 540, `${minutesOf()} minutes`);
  check('and saying so', basisOf() === 'scheduled_day_length', basisOf());

  // -------------------------------------------------------------------
  console.log('\nNo tracking and no roster either');
  // -------------------------------------------------------------------
  db.reset();
  db.setPending(row(0));
  db.setLastFix(null);

  await closeOpenSessions();
  check('falls back to the boundary — the only thing left to go on',
    minutesOf() === TO_BOUNDARY, `${minutesOf()} minutes`);
  check('and saying so', basisOf() === 'day_boundary', basisOf());

  // -------------------------------------------------------------------
  console.log('\nA fix from AFTER the day ended');
  // -------------------------------------------------------------------
  db.reset();
  db.setPending(row(540));
  // The phone kept reporting into the next morning. Nobody is credited into
  // a day they have not started.
  db.setLastFix(new Date(`${TODAY}T05:00:00.000Z`));

  await closeOpenSessions();
  check('is never credited past the boundary',
    minutesOf() <= TO_BOUNDARY, `${minutesOf()} minutes`);

  // -------------------------------------------------------------------
  console.log('\nA fix from BEFORE the clock-in');
  // -------------------------------------------------------------------
  db.reset();
  db.setPending(row(540));
  db.setLastFix(new Date(`${DAY}T01:00:00.000Z`));   // 06:30 IST, before arrival

  await closeOpenSessions();
  check('never produces a negative day',
    minutesOf() >= 0, `${minutesOf()} minutes`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nTest itself failed:', e);
  process.exit(1);
});

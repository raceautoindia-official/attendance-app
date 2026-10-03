// The day timeline survives a database that is behind on migrations.
//
// Production ran a build whose timeline query named out_of_fence_reason and
// out_of_fence_status outright, on a database where that migration had not been
// applied. MySQL answered ER_BAD_FIELD_ERROR, the route threw, and the modal an
// admin had just opened said only:
//
//     Could not load the day.
//
// Nothing about a column, nothing about a migration. A missing ALTER TABLE
// looked exactly like a broken feature. Every other route in the app guards its
// optional columns; this one query did not, and it took the whole endpoint down
// with it — including the clock-in and clock-out times, which were sitting in
// columns that have existed since the first schema.
//
// The second half of the test is the quieter bug found alongside it. audit_log
// .details is a JSON column, so mysql2 hands it back ALREADY PARSED. The route
// called JSON.parse() on that object, which throws, and the throw was caught
// and discarded — so every event lost its reason line and its map pin while the
// page looked perfectly healthy.
//
//   node tests/timelinedegrade.js
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

const db = require('./stubs/db');

const jiti = createJiti(__filename, {
  interopDefault: true,
  moduleCache: false,
  alias: {
    '@/lib/db': path.join(__dirname, 'stubs', 'db.js'),
    '@/lib/auth': path.join(__dirname, 'stubs', 'auth.js'),
    '@/lib/jsonColumn': path.join(ROOT, 'lib', 'jsonColumn.ts'),
    '@/lib/employeeDetails': path.join(ROOT, 'lib', 'employeeDetails.ts'),
    '@/lib/attendance': path.join(ROOT, 'lib', 'attendance.ts'),
    '@/lib/constants': path.join(ROOT, 'lib', 'constants.ts'),
    '@/lib/types': path.join(ROOT, 'lib', 'types.ts'),
  },
});

const WORK_DATE = '2026-08-17';
const EMP = 12;

function request() {
  return new Request(
    `http://localhost/api/employees/${EMP}/timeline?date=${WORK_DATE}`,
    { headers: { Authorization: 'Bearer stub' } },
  );
}

(async () => {
  const route = jiti(path.join(ROOT, 'app', 'api', 'employees', '[id]', 'timeline', 'route.ts'));
  const GET = route.GET;

  // Newest first, the order the query asks for — and a FRESH array each time,
  // because the route reverses in place.
  //
  // details as an OBJECT: what the production pool actually returns.
  const auditRows = () => [
    {
      created_at: '2026-08-17T12:10:00.000Z',
      action: 'clock_out',
      details: { employee_id: EMP, auto: true, reason: 'geofence_exit' },
    },
    {
      created_at: '2026-08-17T03:45:00.000Z',
      action: 'clock_in',
      details: {
        employee_id: EMP,
        latitude: 13.0827,
        longitude: 80.2707,
        out_of_fence_reason: 'Customer visit',
      },
    },
  ];

  // ---------------------------------------------------------------------
  console.log('\nA database missing the out-of-fence migrations');
  // ---------------------------------------------------------------------
  db.reset();
  db.setMissingColumns(['out_of_fence_reason', 'out_of_fence_status']);
  db.setAuditRows(auditRows());
  db.setAttendanceRow({
    work_date: WORK_DATE,
    clock_in_utc: '2026-08-17T03:45:00.000Z',
    clock_out_utc: '2026-08-17T12:10:00.000Z',
    total_minutes: 505,
    status: 'present',
  });

  let res = await GET(request(), { params: Promise.resolve({ id: String(EMP) }) });
  check('the endpoint answers instead of throwing', res.status === 200, `status ${res.status}`);

  let body = await res.json();
  check('and it says so', body.success === true, JSON.stringify(body).slice(0, 120));
  check(
    'the clock-in and clock-out still come back',
    body.data?.attendance?.clock_in_utc && body.data?.attendance?.clock_out_utc,
    JSON.stringify(body.data?.attendance),
  );
  check(
    'the unavailable columns read as null, not as an error',
    body.data?.attendance?.out_of_fence_reason === null
      && body.data?.attendance?.out_of_fence_status === null,
    JSON.stringify(body.data?.attendance),
  );

  // ---------------------------------------------------------------------
  console.log('\nDetails arriving already parsed (the JSON column)');
  // ---------------------------------------------------------------------
  const events = body.data?.events ?? [];
  check('both events are narrated', events.length === 2, `got ${events.length}`);
  check(
    'the clock-in keeps its map pin',
    events[0]?.latitude === 13.0827 && events[0]?.longitude === 80.2707,
    `lat ${events[0]?.latitude} lng ${events[0]?.longitude}`,
  );
  check(
    'the clock-in keeps its off-site reason',
    /Customer visit/.test(events[0]?.detail ?? ''),
    JSON.stringify(events[0]),
  );
  check(
    'the automatic clock-out says why it happened',
    /left the site/i.test(events[1]?.title ?? ''),
    JSON.stringify(events[1]),
  );

  // ---------------------------------------------------------------------
  console.log('\nDetails arriving as text (the other driver)');
  // ---------------------------------------------------------------------
  db.reset();
  db.setAuditRows(auditRows().map(r => ({ ...r, details: JSON.stringify(r.details) })));
  res = await GET(request(), { params: Promise.resolve({ id: String(EMP) }) });
  body = await res.json();
  check(
    'read identically',
    body.data?.events?.[0]?.latitude === 13.0827
      && /Customer visit/.test(body.data?.events?.[0]?.detail ?? ''),
    JSON.stringify(body.data?.events?.[0]),
  );

  // ---------------------------------------------------------------------
  console.log('\nA fully migrated database');
  // ---------------------------------------------------------------------
  db.reset();
  db.setMissingColumns([]);
  db.setAttendanceRow({
    work_date: WORK_DATE,
    clock_in_utc: '2026-08-17T03:45:00.000Z',
    clock_out_utc: null,
    total_minutes: null,
    status: 'present',
    banked_minutes: 0,
    session_count: 2,
    out_of_fence_reason: 'Customer visit',
    out_of_fence_status: 'pending',
  });
  res = await GET(request(), { params: Promise.resolve({ id: String(EMP) }) });
  body = await res.json();
  check('the real columns are read when they exist', res.status === 200, `status ${res.status}`);
  check(
    'and their values reach the response',
    body.data?.attendance?.out_of_fence_reason === 'Customer visit'
      && body.data?.attendance?.out_of_fence_status === 'pending',
    JSON.stringify(body.data?.attendance),
  );
  check(
    'the session count is the row\'s, not a placeholder',
    body.data?.attendance?.session_count === 2,
    JSON.stringify(body.data?.attendance),
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nTest itself failed:', e);
  process.exit(1);
});

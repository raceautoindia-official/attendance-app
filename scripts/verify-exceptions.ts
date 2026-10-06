/**
 * scripts/verify-exceptions.ts — the month review.
 *
 *   npx tsx --env-file=.env.local scripts/verify-exceptions.ts
 *
 * Builds a fixture month containing one of each thing the review should notice,
 * checks it notices exactly those, and removes the fixture — including on
 * failure.
 *
 * The thresholds are policy, not arithmetic, so they are pinned here: a change
 * to "what counts as a short day" should be a deliberate edit to a test, not a
 * silent shift in what the review reports.
 */

import { findExceptions, THRESHOLDS } from '../lib/exceptions';
import { GET } from '../app/api/exceptions/route';
import { NextRequest } from 'next/server';
import { signAccessToken, currentTokenVersion } from '../lib/auth';
import { query, queryOne, pool } from '../lib/db';

const FROM = '2019-05-01';
const TO = '2019-05-31';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.parse(`${date}T00:00:00Z`) + (h * 60 + m - 330) * 60_000)
    .toISOString().slice(0, 19).replace('T', ' ');
};

interface Fixture { shiftId: number; ids: Record<string, number>; }

async function seed(): Promise<Fixture> {
  const shift = (await query(
    `INSERT INTO shifts (name, type, start_time, end_time, grace_minutes, working_days)
     VALUES ('__exc_shift', 'fixed', '09:00:00', '18:00:00', 10,
             '["Mon","Tue","Wed","Thu","Fri","Sat"]')`,
  )) as unknown as { insertId: number };
  const shiftId = shift.insertId;

  const add = async (empId: string, name: string, roster: boolean) => {
    const r = (await query(
      `INSERT INTO employees (emp_id, name, pin_hash, role, is_active) VALUES (?, ?, 'x', 'employee', 1)`,
      [empId, name],
    )) as unknown as { insertId: number };
    if (roster) {
      await query(
        `INSERT INTO employee_schedules (employee_id, shift_id, effective_from) VALUES (?, ?, '2019-01-01')`,
        [r.insertId, shiftId],
      );
    }
    return r.insertId;
  };

  const ids = {
    openSession: await add('__EX1', '__Exc OpenSession', true),
    longDay: await add('__EX2', '__Exc LongDay', true),
    lowAverage: await add('__EX3', '__Exc LowAverage', true),
    dormant: await add('__EX4', '__Exc Dormant', true),
    noRoster: await add('__EX5', '__Exc NoRoster', false),
    healthy: await add('__EX6', '__Exc Healthy', true),
  };

  const ins = (empId: number, date: string, cols: {
    in?: string | null; out?: string | null; mins?: number | null; status?: string; fence?: string;
  }) => query(
    `INSERT INTO attendance
       (employee_id, work_date, status, clock_in_utc, clock_out_utc, total_minutes,
        session_count, banked_minutes, geofence_status)
     VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)`,
    [empId, date, cols.status ?? 'present', cols.in ?? null, cols.out ?? null,
      cols.mins ?? null, cols.fence ?? 'not_required'],
  );

  // Clocked in, never out.
  await ins(ids.openSession, '2019-05-02', { in: at('2019-05-02', '09:00'), out: null, mins: null });

  // A day longer than anybody works.
  await ins(ids.longDay, '2019-05-03', {
    in: at('2019-05-03', '08:00'), out: at('2019-05-04', '01:00'), mins: 17 * 60,
  });

  // Consistently short across enough days to be a pattern, not a bad day.
  for (let d = 6; d <= 17; d++) {
    const date = `2019-05-${String(d).padStart(2, '0')}`;
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) continue;
    await ins(ids.lowAverage, date, {
      in: at(date, '09:00'), out: at(date, '13:00'), mins: 240,
    });
  }

  // Full days, nothing to report.
  for (let d = 6; d <= 17; d++) {
    const date = `2019-05-${String(d).padStart(2, '0')}`;
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) continue;
    await ins(ids.healthy, date, {
      in: at(date, '09:00'), out: at(date, '18:00'), mins: 540,
    });
  }

  return { shiftId, ids };
}

async function cleanup(f: Fixture | null) {
  if (!f) return;
  const ids = Object.values(f.ids);
  if (ids.length) {
    const list = ids.map(() => '?').join(',');
    await query(`DELETE FROM attendance WHERE employee_id IN (${list})`, ids);
    await query(`DELETE FROM employee_schedules WHERE employee_id IN (${list})`, ids);
    await query(`DELETE FROM employees WHERE id IN (${list})`, ids);
  }
  if (f.shiftId) await query(`DELETE FROM shifts WHERE id = ?`, [f.shiftId]);
}

async function main() {
  let f: Fixture | null = null;
  try {
    const db = process.env.DB_NAME ?? '';
    if (/prod/i.test(db) || db === 'attendance_db') {
      console.log(`REFUSED: DB_NAME is "${db}" — this script writes.`);
      failed += 1;
      return;
    }
    f = await seed();
    const report = await findExceptions(FROM, TO);
    const forEmployee = (id: number) => report.exceptions.filter(e => e.employee?.id === id);
    const typesFor = (id: number) => forEmployee(id).map(e => e.type);

    console.log('\n— the things it must notice —');
    check('an open session is critical',
      forEmployee(f.ids.openSession).some(e => e.type === 'open_session' && e.severity === 'critical'),
      typesFor(f.ids.openSession).join(', '));
    check('…and is NOT also reported as having recorded nothing',
      !typesFor(f.ids.openSession).includes('no_activity'),
      typesFor(f.ids.openSession).join(', '));
    check('…and says the hours are not final',
      forEmployee(f.ids.openSession).some(e => /not final/i.test(e.detail)));

    check('a 17-hour day is flagged',
      typesFor(f.ids.longDay).includes('implausible_day'), typesFor(f.ids.longDay).join(', '));
    check('…and allows it might be genuine rather than calling it wrong',
      forEmployee(f.ids.longDay).some(e => /genuine long shift/i.test(e.action)));

    const low = forEmployee(f.ids.lowAverage).find(e => e.type === 'low_average');
    check('a consistently short pattern is flagged', Boolean(low),
      typesFor(f.ids.lowAverage).join(', '));
    check('…described as a pattern, not one short day',
      Boolean(low && /pattern across the period/i.test(low.detail)), low?.detail.slice(0, 80) ?? '');
    check('…and offers the innocent explanation first',
      Boolean(low && /part-time arrangement/i.test(low.action)));

    check('an employee who recorded nothing is flagged',
      typesFor(f.ids.dormant).includes('no_activity'), typesFor(f.ids.dormant).join(', '));
    check('an employee with no shift is flagged',
      typesFor(f.ids.noRoster).includes('no_roster'), typesFor(f.ids.noRoster).join(', '));

    console.log('\n— and the things it must NOT ---');
    eq('a healthy employee produces nothing', forEmployee(f.ids.healthy).length, 0);
    check('the dormant employee is not ALSO reported as an absence streak',
      !typesFor(f.ids.dormant).includes('absence_streak'),
      typesFor(f.ids.dormant).join(', '));
    check('a short day is information, not an accusation',
      report.exceptions.filter(e => e.type === 'short_day').every(e => e.severity === 'info'));
    check('every exception says what to do about it',
      report.exceptions.every(e => e.action.length > 10));
    check('every exception has a stable id',
      new Set(report.exceptions.map(e => e.id)).size === report.exceptions.length,
      `${report.exceptions.length} exceptions, ${new Set(report.exceptions.map(e => e.id)).size} unique ids`);

    console.log('\n— ordering and counts —');
    const sev = report.exceptions.map(e => e.severity);
    const firstWarning = sev.indexOf('warning');
    const lastCritical = sev.lastIndexOf('critical');
    check('critical comes before warning', lastCritical === -1 || firstWarning === -1 || lastCritical < firstWarning);
    eq('counts add up',
      report.counts.critical + report.counts.warning + report.counts.info, report.counts.total);
    eq('total matches the list', report.counts.total, report.exceptions.length);
    check('not reported as clear when there is something', report.clear === false);

    console.log('\n— a quiet period reports clear —');
    const quiet = await findExceptions('2019-01-01', '2019-01-07');
    check('a period with nothing in it still lists the standing issues',
      quiet.exceptions.every(e => ['no_activity', 'no_roster', 'data_integrity'].includes(e.type)),
      [...new Set(quiet.exceptions.map(e => e.type))].join(', '));

    console.log('\n— thresholds are pinned, because they are policy —');
    eq('short day is below 60% of the requirement', THRESHOLDS.SHORT_DAY_RATIO, 0.6);
    eq('a low average is below 75% across the period', THRESHOLDS.LOW_AVERAGE_RATIO, 0.75);
    eq('an average needs at least 5 worked days', THRESHOLDS.MIN_DAYS_FOR_AVERAGE, 5);
    eq('14 hours is implausible', THRESHOLDS.IMPLAUSIBLE_DAY_MINUTES, 840);
    eq('5 consecutive absences is a streak', THRESHOLDS.ABSENCE_STREAK, 5);

    console.log('\n— the route —');
    const anon = await GET(new NextRequest(`http://localhost:3000/api/exceptions?month=2019-05`));
    eq('no cookie is rejected', anon.status, 401);

    const admin = await queryOne<{ id: number; emp_id: string; role: string }>(
      `SELECT id, emp_id, role FROM employees WHERE role = 'super_admin' AND is_active = 1 LIMIT 1`,
    );
    if (admin) {
      const tv = await currentTokenVersion(admin.id);
      const token = signAccessToken({ id: admin.id, emp_id: admin.emp_id, role: admin.role, tv } as never);
      const get = (qs: string) => GET(new NextRequest(`http://localhost:3000/api/exceptions?${qs}`, {
        headers: { Cookie: `access_token=${token}` },
      }));
      eq('a month returns 200', (await get('month=2019-05')).status, 200);
      eq('a malformed month is refused', (await get('month=2019-5')).status, 400);
      eq('no period at all is refused', (await get('')).status, 400);
      eq('more than a quarter is refused',
        (await get('from_date=2019-01-01&to_date=2019-12-31')).status, 400);
      const body = (await (await get('month=2019-05')).json()) as { data: { counts: { total: number } } };
      check('the route returns the same report', body.data.counts.total === report.counts.total,
        `${body.data.counts.total} vs ${report.counts.total}`);
    }
  } finally {
    await cleanup(f);
    const left = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM employees WHERE emp_id LIKE '__EX%'`,
    );
    check('fixture cleaned up', Number(left?.n ?? 0) === 0, `${left?.n} left`);
    console.log(`\n${passed} passed, ${failed} failed`);
  }
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });

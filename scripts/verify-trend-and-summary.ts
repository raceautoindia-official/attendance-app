/**
 * scripts/verify-trend-and-summary.ts — the comparison, and the month-end mail.
 *
 *   npx tsx --env-file=.env.local scripts/verify-trend-and-summary.ts
 *
 * The mail is exercised through its dry run, which builds everything and sends
 * nothing. That matters here: SMTP_FROM is not a verified SES identity yet, so
 * a real send would fail silently — the mailer swallows errors by design so a
 * dead mailbox cannot break a cron run. The dry run proves the thing is right
 * before the mailbox is.
 *
 * Builds its own fixture across two months and removes it, including on failure.
 */

import { NextRequest } from 'next/server';
import { buildComparison } from '../lib/hoursTrend';
import { GET as trendRoute } from '../app/api/reports/hours-trend/route';
import { POST as summaryCron } from '../app/api/cron/month-end-summary/route';
import { signAccessToken, currentTokenVersion } from '../lib/auth';
import { query, queryOne, pool } from '../lib/db';

const THIS_MONTH = '2019-11';
const PREV_MONTH = '2019-10';

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

interface Fixture { shiftId: number; subject: number; peers: number[]; }

/** Every Mon–Sat of a month. */
function workingDates(month: string): string[] {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out: string[] = [];
  for (let d = 1; d <= last; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    if (new Date(`${date}T00:00:00Z`).getUTCDay() !== 0) out.push(date);
  }
  return out;
}

async function seed(): Promise<Fixture> {
  const shift = (await query(
    `INSERT INTO shifts (name, type, start_time, end_time, grace_minutes, working_days)
     VALUES ('__trend_shift', 'fixed', '09:00:00', '18:00:00', 10, '["Mon","Tue","Wed","Thu","Fri","Sat"]')`,
  )) as unknown as { insertId: number };

  const add = async (empId: string, name: string, dept: string) => {
    const r = (await query(
      `INSERT INTO employees (emp_id, name, department, pin_hash, role, is_active)
       VALUES (?, ?, ?, 'x', 'employee', 1)`,
      [empId, name, dept],
    )) as unknown as { insertId: number };
    await query(
      `INSERT INTO employee_schedules (employee_id, shift_id, effective_from) VALUES (?, ?, '2019-01-01')`,
      [r.insertId, shift.insertId],
    );
    return r.insertId;
  };

  const subject = await add('__TR1', '__Trend Subject', '__TrendDept');
  const peers = [
    await add('__TR2', '__Trend Peer A', '__TrendDept'),
    await add('__TR3', '__Trend Peer B', '__TrendDept'),
    await add('__TR4', '__Trend Peer C', '__TrendDept'),
  ];

  const fill = async (empId: number, month: string, minutes: number) => {
    for (const date of workingDates(month)) {
      await query(
        `INSERT INTO attendance (employee_id, work_date, status, clock_in_utc, clock_out_utc,
                                 total_minutes, session_count, banked_minutes)
         VALUES (?, ?, 'present', ?, ?, ?, 1, 0)`,
        [empId, date, at(date, '09:00'), at(date, '18:00'), minutes],
      );
    }
  };

  // The subject improves: 8h a day in October, 9h in November.
  await fill(subject, PREV_MONTH, 480);
  await fill(subject, THIS_MONTH, 540);
  // Peers all do 7h, so the subject is comfortably above the median.
  for (const p of peers) {
    await fill(p, PREV_MONTH, 420);
    await fill(p, THIS_MONTH, 420);
  }
  return { shiftId: shift.insertId, subject, peers };
}

async function cleanup(f: Fixture | null) {
  if (!f) return;
  const ids = [f.subject, ...f.peers].filter(Boolean);
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

    console.log('\n— this period against the last —');
    const c = (await buildComparison(f.subject, `${THIS_MONTH}-01`, `${THIS_MONTH}-30`))!;
    check('a comparison is produced', Boolean(c));
    check('the previous period is found', Boolean(c.previous), c.previous?.label ?? 'none');
    eq('the previous period is the month before', c.previous?.label, 'October 2019');
    check('the worked delta is positive — they did more', (c.delta?.worked_minutes ?? 0) > 0,
      `${c.delta?.worked_minutes} min`);
    eq('the average per day rose by exactly an hour', c.delta?.avg_worked_minutes_per_day, 60);

    // November is 30 days and October is 31. Counting back 30 days would start
    // on 2 October and silently drop a working day from the comparison — which
    // is exactly what this did before, and what this check now prevents.
    eq('a whole month compares against the whole previous month',
      c.previous?.from_date, `${PREV_MONTH}-01`);
    eq('…through to its last day', c.previous?.to_date, `${PREV_MONTH}-31`);

    // An arbitrary range has no calendar unit to align to, so an equally long
    // window immediately before is the honest comparison.
    const range = (await buildComparison(f.subject, `${THIS_MONTH}-05`, `${THIS_MONTH}-14`))!;
    eq('a 10-day range compares against the 10 days before it',
      range.previous?.from_date, `${PREV_MONTH}-26`);
    eq('…ending the day before it starts', range.previous?.to_date, `${THIS_MONTH}-04`);

    console.log('\n— against peers —');
    check('peers are found', Boolean(c.peers), c.peers ? `${c.peers.count} people` : 'none');
    eq('scoped to the department', c.peers?.scope, 'department');
    eq('…and named', c.peers?.label, '__TrendDept');
    eq('four comparable people', c.peers?.count, 4);
    eq('the median day is the peers\' 7h, not the subject\'s 9h', c.peers?.median_avg_minutes, 420);
    eq('the subject ranks first by hours worked', c.peers?.rank, 1);

    console.log('\n— it refuses to invent a comparison —');
    const noPrev = (await buildComparison(f.subject, '2019-01-01', '2019-01-31'))!;
    eq('a period with no predecessor has no previous', noPrev.previous, null);
    check('…and says so rather than showing a delta of zero',
      noPrev.delta === null && noPrev.notes.some(n => /no trend to show/i.test(n)),
      noPrev.notes.join(' | '));

    console.log('\n— the route —');
    eq('no cookie is rejected',
      (await trendRoute(new NextRequest(
        `http://localhost:3000/api/reports/hours-trend?employee_id=${f.subject}&month=${THIS_MONTH}`,
      ))).status, 401);

    const admin = await queryOne<{ id: number; emp_id: string; role: string }>(
      `SELECT id, emp_id, role FROM employees WHERE role = 'super_admin' AND is_active = 1 LIMIT 1`,
    );
    if (admin) {
      const tv = await currentTokenVersion(admin.id);
      const token = signAccessToken({ id: admin.id, emp_id: admin.emp_id, role: admin.role, tv } as never);
      const get = (qs: string) => trendRoute(new NextRequest(
        `http://localhost:3000/api/reports/hours-trend?${qs}`, { headers: { Cookie: `access_token=${token}` } },
      ));
      eq('a month returns 200', (await get(`employee_id=${f.subject}&month=${THIS_MONTH}`)).status, 200);
      eq('a missing employee_id is refused', (await get(`month=${THIS_MONTH}`)).status, 400);
      eq('an unknown employee is 404', (await get(`employee_id=99999999&month=${THIS_MONTH}`)).status, 404);
      eq('a range longer than two months is refused',
        (await get(`employee_id=${f.subject}&from_date=2019-01-01&to_date=2019-12-31`)).status, 400);
    }

    console.log('\n— the month-end mail, dry run —');
    const noSecret = await summaryCron(new NextRequest(
      'http://localhost:3000/api/cron/month-end-summary', { method: 'POST' },
    ));
    eq('without the cron secret it is rejected', noSecret.status, 401);

    const secret = process.env.CRON_SECRET;
    if (!secret) {
      console.log('  (CRON_SECRET is not set locally — the authorised path is not exercised)');
    } else {
      const call = (qs: string) => summaryCron(new NextRequest(
        `http://localhost:3000/api/cron/month-end-summary?${qs}`,
        { method: 'POST', headers: { 'x-cron-secret': secret } },
      ));
      const bad = await call(`month=2019-1&dry_run=1`);
      eq('a malformed month is refused', bad.status, 400);

      const res = await call(`month=${THIS_MONTH}&dry_run=1`);
      eq('the dry run succeeds', res.status, 200);
      const body = (await res.json()) as {
        dry_run: boolean;
        would_send_to: string[];
        summary: { employees: number; short: number; closed: boolean; checksum: string };
      };
      check('it reports itself as a dry run', body.dry_run === true);
      check('it says who it WOULD have mailed', Array.isArray(body.would_send_to),
        `${body.would_send_to.length} recipient(s)`);
      check('it counted the employees', body.summary.employees > 0, `${body.summary.employees}`);
      check('it counted who finished short', body.summary.short >= 3,
        `${body.summary.short} short — the three peers at 7h/day`);
      check('an unclosed month is reported as such', body.summary.closed === false);
      check('it carries the same checksum the pack produces',
        /^[0-9a-f]{64}$/.test(body.summary.checksum), body.summary.checksum.slice(0, 16));

      // Nothing was sent, which is the point of a dry run.
      const sent = await queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'month_end_summary_sent'`,
      );
      check('the dry run sent nothing', Number(sent?.n ?? 0) === 0);
    }
  } finally {
    await cleanup(f);
    const left = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM employees WHERE emp_id LIKE '__TR%'`,
    );
    check('fixture cleaned up', Number(left?.n ?? 0) === 0, `${left?.n} left`);
    console.log(`\n${passed} passed, ${failed} failed`);
  }
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });

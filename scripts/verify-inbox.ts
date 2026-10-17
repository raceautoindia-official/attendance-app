/**
 * scripts/verify-inbox.ts — the one queue.
 *
 *   npx tsx --env-file=.env.local scripts/verify-inbox.ts
 *
 * The inbox is a second VIEW of rows four other pages own, so the thing worth
 * testing is that it agrees with them and adds the one fact none of them had:
 * how long something has been waiting.
 *
 * Three properties matter enough to pin down:
 *
 *   It finds every kind. A request that does not appear is worse than no queue,
 *   because the badge then says zero while somebody waits.
 *   The badge counts DECISIONS only. Month exceptions are not waiting on
 *   anybody, and counting them gives a badge that never reaches zero - which
 *   is a badge people stop believing.
 *   Age is real. `waiting_days` drives the red text and the sort, so it is
 *   asserted against rows planted at known ages.
 */

import { NextRequest } from 'next/server';
import { GET as inboxGet } from '../app/api/inbox/route';
import { buildInbox, inboxPendingCount, previousMonth } from '../lib/inbox';
import { signAccessToken, currentTokenVersion } from '../lib/auth';
import { query, queryOne, pool } from '../lib/db';

let passed = 0;
let failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`); }
};
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, JSON.stringify(a) === JSON.stringify(b),
    `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

async function adminToken() {
  const e = await queryOne<{ id: number; emp_id: string; role: string }>(
    `SELECT id, emp_id, role FROM employees WHERE role = 'super_admin' AND is_active = 1 LIMIT 1`);
  if (!e) throw new Error('no active super_admin to act as');
  const tv = await currentTokenVersion(e.id);
  return signAccessToken({ id: e.id, emp_id: e.emp_id, role: e.role, tv } as never);
}

async function cleanup() {
  await query(`DELETE pr FROM permission_requests pr JOIN employees e ON e.id = pr.employee_id WHERE e.emp_id LIKE 'ZZINB%'`);
  await query(`DELETE rr FROM regularisation_requests rr JOIN employees e ON e.id = rr.employee_id WHERE e.emp_id LIKE 'ZZINB%'`);
  await query(`DELETE a FROM attendance a JOIN employees e ON e.id = a.employee_id WHERE e.emp_id LIKE 'ZZINB%'`);
  await query(`DELETE FROM employees WHERE emp_id LIKE 'ZZINB%'`);
}

async function main() {
  try {
    await cleanup();
    const admin = await adminToken();

    const actorId = Number((await queryOne<{ id: number }>(
      `SELECT id FROM employees WHERE role = 'super_admin' AND is_active = 1 LIMIT 1`))?.id);

    await query(
      `INSERT INTO employees (emp_id, name, pin_hash, role, is_active)
       VALUES ('ZZINB001', 'ZZINB Waiting Person', 'x', 'employee', 1)`);
    const employeeId = Number((await queryOne<{ id: number }>(
      `SELECT id FROM employees WHERE emp_id = 'ZZINB001'`))?.id);

    console.log('\n— an empty queue says so —');
    const emptyScope = { visible: [employeeId] };
    const empty = await buildInbox({ ...emptyScope, includeReview: false });
    eq('nothing waiting', empty.counts.total, 0);
    eq('and it says it is clear', empty.clear, true);
    eq('with no oldest', empty.oldest_days, null);

    console.log('\n— a permission request waiting four days —');
    await query(
      `INSERT INTO permission_requests
         (employee_id, request_type, permission_date, start_time, end_time, minutes,
          reason, status, requested_by, created_at)
       VALUES (?, 'permission', CURDATE(), '14:00:00', '16:00:00', 120,
               'Bank work', 'pending', ?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 4 DAY))`,
      [employeeId, employeeId]);

    const withPermission = await buildInbox({ ...emptyScope, includeReview: false });
    eq('one item', withPermission.counts.total, 1);
    eq('of the right kind', withPermission.items[0]?.kind, 'permission_request');
    eq('four days of waiting', withPermission.items[0]?.waiting_days, 4);
    eq('which makes it critical, not merely a warning',
      withPermission.items[0]?.severity, 'critical');
    check('it names the person', withPermission.items[0]?.title.includes('ZZINB Waiting Person'),
      withPermission.items[0]?.title);
    check('and says what was asked for', withPermission.items[0]?.detail.includes('14:00-16:00'),
      withPermission.items[0]?.detail);
    eq('it points at the page that owns the decision',
      withPermission.items[0]?.href, '/permissions');

    console.log('\n— a request that arrived today is not overdue —');
    await query(
      `UPDATE permission_requests SET created_at = UTC_TIMESTAMP()
        WHERE employee_id = ?`, [employeeId]);
    const fresh = await buildInbox({ ...emptyScope, includeReview: false });
    eq('no days waited', fresh.items[0]?.waiting_days, 0);
    eq('so it is a warning', fresh.items[0]?.severity, 'warning');

    console.log('\n— a correction request —');
    await query(
      `INSERT INTO regularisation_requests
         (employee_id, work_date, requested_clock_in, requested_clock_out, reason,
          status, requested_by, created_at)
       VALUES (?, CURDATE(), UTC_TIMESTAMP(), UTC_TIMESTAMP(), 'Forgot to clock out',
               'pending', ?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY))`,
      [employeeId, employeeId]);
    const withReg = await buildInbox({ ...emptyScope, includeReview: false });
    eq('two items now', withReg.counts.total, 2);
    eq('the older one is first', withReg.items[0]?.kind, 'regularisation');
    eq('counted by kind', withReg.counts.by_kind.regularisation, 1);
    eq('the oldest age is reported', withReg.oldest_days, 2);

    console.log('\n— an off-site clock-in nobody has reviewed —');
    await query(
      `INSERT INTO attendance
         (employee_id, work_date, clock_in_utc, geofence_status, out_of_fence_status, status)
       VALUES (?, CURDATE(), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY),
               'outside', 'pending', 'present')`,
      [employeeId]);
    const withOffSite = await buildInbox({ ...emptyScope, includeReview: false });
    eq('three items', withOffSite.counts.total, 3);
    eq('including the off-site one', withOffSite.counts.by_kind.off_site_review, 1);
    const offSite = withOffSite.items.find(i => i.kind === 'off_site_review');
    eq('which goes to the notifications page', offSite?.href, '/notifications');
    check('and says no reason was recorded when there is none',
      Boolean(offSite?.detail.includes('no reason recorded')), offSite?.detail);

    console.log('\n— the badge counts decisions, not reviews —');
    const count = await inboxPendingCount(emptyScope);
    eq('three decisions waiting', count, 3);
    const withReview = await buildInbox({ ...emptyScope, includeReview: true });
    check('the review block adds only month exceptions',
      withReview.items.every(i => i.kind === 'month_exception' || withOffSite.items.some(o => o.id === i.id)));
    check('and those carry no waiting time, because they are not waiting on anybody',
      withReview.items.filter(i => i.kind === 'month_exception')
        .every(i => i.waiting_days === null && i.waiting_since === null));
    eq('so the decision count is unchanged by them', withReview.counts.decisions, 3);

    console.log('\n— through the API —');
    const res = await inboxGet(new NextRequest('http://localhost:3000/api/inbox', {
      headers: { Cookie: `access_token=${admin}` },
    }));
    eq('an admin may read it', res.status, 200);
    const body = await res.json();
    check('it returns a queue', Array.isArray(body?.data?.items));
    check('our three fixtures are in it, among whatever else is pending',
      body.data.items.filter((i: { employee: { emp_id: string } | null }) =>
        i.employee?.emp_id === 'ZZINB001').length === 3,
      `${body.data.items.filter((i: { employee: { emp_id: string } | null }) => i.employee?.emp_id === 'ZZINB001').length} found`);
    eq('nothing is narrowed for a super admin', body.data.scope_note, null);
    check('the review month defaults to the one just finished',
      body.data.review_month === previousMonth(), body.data.review_month);

    const countRes = await inboxGet(new NextRequest('http://localhost:3000/api/inbox?count=1', {
      headers: { Cookie: `access_token=${admin}` },
    }));
    const countBody = await countRes.json();
    eq('count=1 returns no items', countBody.data.items.length, 0);
    check('but still a number', typeof countBody.data.counts.decisions === 'number',
      String(countBody.data.counts.decisions));
    check('and it excludes reviews', countBody.data.counts.reviews === 0,
      String(countBody.data.counts.reviews));

    const refused = await inboxGet(new NextRequest('http://localhost:3000/api/inbox'));
    eq('a request with no token is refused', refused.status, 401);

    console.log('\n— an answered request leaves the queue —');
    await query(
      `UPDATE permission_requests SET status = 'approved', reviewed_by = ?, reviewed_at = UTC_TIMESTAMP()
        WHERE employee_id = ?`, [actorId, employeeId]);
    const afterDecision = await buildInbox({ ...emptyScope, includeReview: false });
    eq('two left', afterDecision.counts.total, 2);
    eq('and no permission request among them',
      afterDecision.counts.by_kind.permission_request, 0);

    console.log('\n— previousMonth —');
    eq('january rolls back a year', previousMonth(new Date('2026-01-15T00:00:00Z')), '2025-12');
    eq('mid-year', previousMonth(new Date('2026-10-12T00:00:00Z')), '2026-09');
    eq('the first of a month', previousMonth(new Date('2026-03-01T00:00:00Z')), '2026-02');
  } finally {
    await cleanup();
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });

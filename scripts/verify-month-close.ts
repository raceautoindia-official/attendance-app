/**
 * scripts/verify-month-close.ts — closing a month, and the lock that follows.
 *
 *   npx tsx --env-file=.env.local scripts/verify-month-close.ts
 *
 * Closes a month far in the past that holds no real data, drives the real API
 * routes against it, and removes the closure afterwards — including on failure.
 *
 * The lock is the whole point, so most of these checks are about what it must
 * REFUSE. A lock that can be walked around is worse than none, because it looks
 * like a guarantee.
 */

import { NextRequest } from 'next/server';
import { GET, POST, DELETE } from '../app/api/month-close/route';
import { PUT as editAttendance } from '../app/api/attendance/[id]/route';
import { POST as createLeave } from '../app/api/leaves/route';
import { DELETE as deleteLeave } from '../app/api/leaves/[id]/route';
import { lockFor, lastDayOfMonth, closeMonth } from '../lib/monthClose';
import { buildHoursLedger } from '../lib/hoursLedger';
import { signAccessToken, currentTokenVersion } from '../lib/auth';
import { query, queryOne, pool } from '../lib/db';

// Far enough back that no real attendance exists there.
const MONTH = '2019-03';
const INSIDE = '2019-03-14';
const OUTSIDE = '2019-04-02';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

async function tokenFor(role: string) {
  const e = await queryOne<{ id: number; emp_id: string; role: string }>(
    `SELECT id, emp_id, role FROM employees WHERE role = ? AND is_active = 1 LIMIT 1`, [role],
  );
  if (!e) return null;
  const tv = await currentTokenVersion(e.id);
  return { id: e.id, token: signAccessToken({ id: e.id, emp_id: e.emp_id, role: e.role, tv } as never) };
}

const req = (body: unknown, token: string, method = 'POST') =>
  new NextRequest('http://localhost:3000/api/month-close', {
    method, headers: { 'Content-Type': 'application/json', Cookie: `access_token=${token}` },
    body: JSON.stringify(body),
  });

async function main() {
  let attendanceId: number | null = null;
  let leaveId: number | null = null;
  try {
    const admin = await tokenFor('super_admin');
    if (!admin) { check('a super_admin exists', false); return; }

    const subject = await queryOne<{ id: number }>(
      `SELECT id FROM employees WHERE role = 'employee' AND is_active = 1 LIMIT 1`,
    );
    if (!subject) { check('an employee exists', false); return; }

    // A row inside the month, and a leave record, to try editing once locked.
    const a = (await query(
      `INSERT INTO attendance (employee_id, work_date, status, total_minutes, session_count, banked_minutes)
       VALUES (?, ?, 'present', 480, 1, 0)`, [subject.id, INSIDE],
    )) as unknown as { insertId: number };
    attendanceId = a.insertId;

    console.log('\n— nothing is locked before a month is closed —');
    eq('the date is writable', await lockFor(INSIDE), null);
    const editBefore = await editAttendance(
      req({ notes: 'before close' }, admin.token, 'PUT'),
      { params: Promise.resolve({ id: String(attendanceId) }) },
    );
    eq('an attendance edit succeeds', editBefore.status, 200);

    console.log('\n— authority —');
    const emp = await tokenFor('employee');
    if (emp) {
      eq('a plain employee cannot close a month',
        (await POST(req({ month: MONTH }, emp.token))).status, 403);
    }
    const mgr = await tokenFor('manager');
    if (mgr) {
      eq('a manager cannot close a month either — it is not an edit',
        (await POST(req({ month: MONTH }, mgr.token))).status, 403);
    } else {
      console.log('  (no manager role in this database — not exercised)');
    }

    console.log('\n— a month that has not finished cannot be closed —');
    const future = new Date();
    const futureMonth = `${future.getUTCFullYear() + 1}-01`;
    const tooSoon = await POST(req({ month: futureMonth }, admin.token));
    eq('closing a future month is refused', tooSoon.status, 400);
    const msg = (await tooSoon.json()) as { error: string };
    check('…and says why', /has not happened yet/i.test(msg.error), msg.error);
    eq('a malformed month is refused', (await POST(req({ month: '2019-3' }, admin.token))).status, 400);

    console.log('\n— closing —');
    const closed = await POST(req({ month: MONTH, notes: 'verify-month-close' }, admin.token));
    eq('the month closes', closed.status, 200);
    const payload = (await closed.json()) as {
      data: { closure: { is_closed: boolean; closed_by_name: string | null; closed_through: string }; warnings: string[] };
    };
    check('it is marked closed', payload.data.closure.is_closed === true);
    check('it records who closed it', Boolean(payload.data.closure.closed_by_name),
      payload.data.closure.closed_by_name ?? 'nobody');
    eq('it locks through the end of the month',
      payload.data.closure.closed_through, lastDayOfMonth(MONTH));
    check('warnings are advisory, not blocking', Array.isArray(payload.data.warnings),
      `${payload.data.warnings.length} warning(s)`);
    eq('closing twice is refused', (await POST(req({ month: MONTH }, admin.token))).status, 400);

    console.log('\n— the lock refuses writes —');
    const lock = await lockFor(INSIDE);
    check('a date inside the month is locked', Boolean(lock));
    eq('a date outside it is not', await lockFor(OUTSIDE), null);

    const editAfter = await editAttendance(
      req({ notes: 'after close' }, admin.token, 'PUT'),
      { params: Promise.resolve({ id: String(attendanceId) }) },
    );
    eq('editing attendance in a closed month is refused', editAfter.status, 409);
    const editMsg = (await editAfter.json()) as { error: string };
    check('…and the refusal names who closed it and when',
      /closed on/i.test(editMsg.error), editMsg.error.slice(0, 110));

    const stored = await queryOne<{ notes: string | null }>(
      `SELECT notes FROM attendance WHERE id = ?`, [attendanceId],
    );
    eq('…and the row was NOT changed', stored?.notes, 'before close');

    const leaveBlocked = await createLeave(new NextRequest('http://localhost:3000/api/leaves', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `access_token=${admin.token}` },
      body: JSON.stringify({ employee_id: subject.id, leave_date: INSIDE, leave_type: 'casual' }),
    }));
    eq('adding leave in a closed month is refused', leaveBlocked.status, 409);

    const leaveOutside = await createLeave(new NextRequest('http://localhost:3000/api/leaves', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `access_token=${admin.token}` },
      body: JSON.stringify({ employee_id: subject.id, leave_date: OUTSIDE, leave_type: 'casual' }),
    }));
    check('…but leave outside it is still allowed', leaveOutside.status === 201 || leaveOutside.status === 200,
      `HTTP ${leaveOutside.status}`);
    const madeLeave = await queryOne<{ id: number }>(
      `SELECT id FROM leave_records WHERE employee_id = ? AND leave_date = ?`, [subject.id, OUTSIDE],
    );
    leaveId = madeLeave?.id ?? null;

    console.log('\n— the statement says whether the figures are final —');
    const led = (await buildHoursLedger({
      employeeId: subject.id, fromDate: `${MONTH}-01`, toDate: lastDayOfMonth(MONTH),
    }))!;
    check('the ledger reports the closure', Boolean(led.closure?.is_closed));
    const open = (await buildHoursLedger({
      employeeId: subject.id, fromDate: '2019-04-01', toDate: '2019-04-30',
    }))!;
    eq('an unclosed month reports none', open.closure, null);

    console.log('\n— reopening is recorded, not silent —');
    eq('reopening without a reason is refused',
      (await DELETE(req({ month: MONTH, reason: 'x' }, admin.token, 'DELETE'))).status, 400);
    const reopened = await DELETE(
      req({ month: MONTH, reason: 'verification run — correcting a clock-out' }, admin.token, 'DELETE'),
    );
    eq('reopening with a reason succeeds', reopened.status, 200);
    eq('the date is writable again', await lockFor(INSIDE), null);

    const audit = await query<{ action: string; details: unknown }>(
      `SELECT action, details FROM audit_log
        WHERE action IN ('month_closed','month_reopened')
        ORDER BY id DESC LIMIT 2`,
    );
    check('both the close and the reopen are in the audit log',
      audit.some(r => r.action === 'month_closed') && audit.some(r => r.action === 'month_reopened'),
      audit.map(r => r.action).join(', '));
    check('the reopen reason is stored',
      JSON.stringify(audit).includes('correcting a clock-out'));

    const editReopened = await editAttendance(
      req({ notes: 'after reopen' }, admin.token, 'PUT'),
      { params: Promise.resolve({ id: String(attendanceId) }) },
    );
    eq('editing works again once reopened', editReopened.status, 200);

    console.log('\n— a part-month close locks only what it covers —');
    await query(`DELETE FROM month_closures WHERE period_month = ?`, [`${MONTH}-01`]);
    await closeMonth({ month: MONTH, closedBy: admin.id, closedThrough: '2019-03-15' });
    check('the 14th is locked', Boolean(await lockFor('2019-03-14')));
    eq('the 20th is not', await lockFor('2019-03-20'), null);

    const listed = await GET(new NextRequest('http://localhost:3000/api/month-close', {
      headers: { Cookie: `access_token=${admin.token}` },
    }));
    const all = (await listed.json()) as { data: { closures: Array<{ period_month: string }> } };
    check('the closure appears in the list',
      all.data.closures.some(c => c.period_month.startsWith(MONTH)));
  } finally {
    await query(`DELETE FROM month_closures WHERE period_month = ?`, [`${MONTH}-01`]);
    if (leaveId) await query(`DELETE FROM leave_records WHERE id = ?`, [leaveId]);
    await query(`DELETE FROM leave_records WHERE leave_date IN (?, ?)`, [INSIDE, OUTSIDE]);
    if (attendanceId) await query(`DELETE FROM attendance WHERE id = ?`, [attendanceId]);
    const left = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM month_closures WHERE period_month = ?`, [`${MONTH}-01`],
    );
    check('closure cleaned up', Number(left?.n ?? 0) === 0);
    const rows = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM attendance WHERE work_date = ?`, [INSIDE],
    );
    check('test attendance cleaned up', Number(rows?.n ?? 0) === 0);
    console.log(`\n${passed} passed, ${failed} failed`);
  }
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });

/**
 * scripts/verify-regularisation.ts — attendance corrections, end to end.
 *
 *   npx tsx --env-file=.env.local scripts/verify-regularisation.ts
 *
 * Approving a request WRITES to attendance, so most of these checks are about
 * who may do that and when. A correction workflow that can be driven by the
 * person being corrected is not a workflow, it is a self-service edit with
 * extra steps.
 *
 * Builds its own fixture and removes it, including on failure.
 */

import { NextRequest } from 'next/server';
import { GET, POST } from '../app/api/regularisations/route';
import { PATCH } from '../app/api/regularisations/[id]/route';
import { createRequest, approveRequest, getRequest } from '../lib/regularisation';
import { closeMonth } from '../lib/monthClose';
import { signAccessToken, currentTokenVersion } from '../lib/auth';
import { query, queryOne, pool } from '../lib/db';

const DATE = '2019-09-10';
const MONTH = '2019-09';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

/** IST time on DATE as an ISO string with offset. */
const istIso = (hhmm: string, date = DATE) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.parse(`${date}T00:00:00Z`) + (h * 60 + m - 330) * 60_000).toISOString();
};

interface Fixture { shiftId: number; worker: number; other: number; attendanceId: number; }

async function tok(id: number) {
  const e = await queryOne<{ id: number; emp_id: string; role: string }>(
    `SELECT id, emp_id, role FROM employees WHERE id = ?`, [id],
  );
  const tv = await currentTokenVersion(id);
  return signAccessToken({ id, emp_id: e!.emp_id, role: e!.role, tv } as never);
}

const req = (body: unknown, token: string, method = 'POST') =>
  new NextRequest('http://localhost:3000/api/regularisations', {
    method, headers: { 'Content-Type': 'application/json', Cookie: `access_token=${token}` },
    body: JSON.stringify(body),
  });

async function seed(): Promise<Fixture> {
  const shift = (await query(
    `INSERT INTO shifts (name, type, start_time, end_time, grace_minutes, working_days)
     VALUES ('__reg_shift', 'fixed', '09:00:00', '18:00:00', 10, '["Mon","Tue","Wed","Thu","Fri","Sat"]')`,
  )) as unknown as { insertId: number };

  const add = async (empId: string, name: string) => {
    const r = (await query(
      `INSERT INTO employees (emp_id, name, pin_hash, role, is_active) VALUES (?, ?, 'x', 'employee', 1)`,
      [empId, name],
    )) as unknown as { insertId: number };
    await query(
      `INSERT INTO employee_schedules (employee_id, shift_id, effective_from) VALUES (?, ?, '2019-01-01')`,
      [r.insertId, shift.insertId],
    );
    return r.insertId;
  };

  const worker = await add('__REG1', '__Reg Worker');
  const other = await add('__REG2', '__Reg Other');

  // Clocked in at 09:00, never clocked out — the case this is for.
  const a = (await query(
    `INSERT INTO attendance (employee_id, work_date, status, clock_in_utc, clock_out_utc,
                             total_minutes, session_count, banked_minutes)
     VALUES (?, ?, 'present', ?, NULL, NULL, 1, 0)`,
    [worker, DATE, istIso('09:00').slice(0, 19).replace('T', ' ')],
  )) as unknown as { insertId: number };

  return { shiftId: shift.insertId, worker, other, attendanceId: a.insertId };
}

async function cleanup(f: Fixture | null) {
  if (!f) return;
  const ids = [f.worker, f.other].filter(Boolean);
  if (ids.length) {
    const list = ids.map(() => '?').join(',');
    await query(`DELETE FROM regularisation_requests WHERE employee_id IN (${list})`, ids);
    await query(`DELETE FROM attendance WHERE employee_id IN (${list})`, ids);
    await query(`DELETE FROM employee_schedules WHERE employee_id IN (${list})`, ids);
    await query(`DELETE FROM employees WHERE id IN (${list})`, ids);
  }
  if (f.shiftId) await query(`DELETE FROM shifts WHERE id = ?`, [f.shiftId]);
  await query(`DELETE FROM month_closures WHERE period_month = ?`, [`${MONTH}-01`]);
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
    const admin = await queryOne<{ id: number }>(
      `SELECT id FROM employees WHERE role = 'super_admin' AND is_active = 1 LIMIT 1`,
    );
    if (!admin) { check('a super_admin exists', false); return; }
    const adminToken = await tok(admin.id);
    const workerToken = await tok(f.worker);
    const otherToken = await tok(f.other);

    console.log('\n— raising a request —');
    const created = await POST(req({
      work_date: DATE,
      requested_clock_out: istIso('18:00'),
      reason: 'Forgot to clock out, left at 6pm as usual.',
    }, workerToken));
    eq('an employee can raise one about their own day', created.status, 201);
    const body = (await created.json()) as { data: { request: { id: number; status: string } } };
    const id = body.data.request.id;
    eq('it starts pending', body.data.request.status, 'pending');

    const untouched = await queryOne<{ clock_out_utc: Date | null; total_minutes: number | null }>(
      `SELECT clock_out_utc, total_minutes FROM attendance WHERE id = ?`, [f.attendanceId],
    );
    eq('raising it changes NOTHING on the attendance row', untouched?.clock_out_utc ?? null, null);

    console.log('\n— what a request must contain —');
    eq('no reason is refused',
      (await POST(req({ work_date: DATE, requested_clock_out: istIso('18:00'), reason: 'x' }, otherToken))).status, 400);
    eq('no corrected time at all is refused',
      (await POST(req({ work_date: DATE, reason: 'Something went wrong here' }, otherToken))).status, 400);
    const wrongDay = await POST(req({
      work_date: DATE, requested_clock_out: istIso('18:00', '2019-09-20'),
      reason: 'A time that belongs to another day entirely',
    }, otherToken));
    eq('a time belonging to another day is refused', wrongDay.status, 400);
    const wdMsg = (await wrongDay.json()) as { error: string };
    check('…and says which day it actually falls on', /falls on 2019-09-20/.test(wdMsg.error), wdMsg.error);
    eq('a clock-out before the clock-in is refused',
      (await POST(req({
        work_date: DATE, requested_clock_in: istIso('18:00'), requested_clock_out: istIso('09:00'),
        reason: 'Times the wrong way round',
      }, otherToken))).status, 400);
    eq('a second pending request for the same day is refused',
      (await POST(req({
        work_date: DATE, requested_clock_out: istIso('19:00'), reason: 'Another go at the same day',
      }, workerToken))).status, 400);

    console.log('\n— who may raise one —');
    const forSomeoneElse = await POST(req({
      employee_id: f.other, work_date: DATE, requested_clock_out: istIso('18:00'),
      reason: 'Raising this on behalf of a colleague',
    }, workerToken));
    eq('an employee cannot raise one for somebody else', forSomeoneElse.status, 403);

    console.log('\n— who may decide —');
    const selfApprove = await PATCH(
      req({ action: 'approve' }, workerToken, 'PATCH'),
      { params: Promise.resolve({ id: String(id) }) },
    );
    eq('the employee cannot approve their own', selfApprove.status, 403);
    const otherApprove = await PATCH(
      req({ action: 'approve' }, otherToken, 'PATCH'),
      { params: Promise.resolve({ id: String(id) }) },
    );
    eq('another employee cannot approve it either', otherApprove.status, 403);

    console.log('\n— approving applies the correction —');
    const approved = await PATCH(
      req({ action: 'approve', notes: 'Confirmed with the site' }, adminToken, 'PATCH'),
      { params: Promise.resolve({ id: String(id) }) },
    );
    eq('an administrator can approve', approved.status, 200);

    const after = await queryOne<{ clock_out_utc: Date | null; total_minutes: number | null; status: string }>(
      `SELECT clock_out_utc, total_minutes, status FROM attendance WHERE id = ?`, [f.attendanceId],
    );
    check('the clock-out is now set', after?.clock_out_utc != null);
    eq('and the hours are nine', Number(after?.total_minutes), 540);

    const stored = await getRequest(id);
    eq('the request is approved', stored?.status, 'approved');
    check('it recorded who approved it', Boolean(stored?.reviewed_by_name), stored?.reviewed_by_name ?? '');
    eq('…and what the row held before', stored?.previous_clock_out, null);
    check('…and the reviewer note', stored?.review_notes === 'Confirmed with the site');

    const audit = await query<{ action: string; details: unknown }>(
      `SELECT action, details FROM audit_log
        WHERE action IN ('regularisation_requested','regularisation_approved')
        ORDER BY id DESC LIMIT 2`,
    );
    check('both the request and the approval are audited',
      audit.some(a => a.action === 'regularisation_requested')
      && audit.some(a => a.action === 'regularisation_approved'),
      audit.map(a => a.action).join(', '));
    check('the audit entry carries the before and after',
      JSON.stringify(audit).includes('"before"') && JSON.stringify(audit).includes('"after"'));

    eq('an already-decided request cannot be decided again',
      (await PATCH(req({ action: 'approve' }, adminToken, 'PATCH'),
        { params: Promise.resolve({ id: String(id) }) })).status, 400);

    console.log('\n— rejecting —');
    const second = await createRequest({
      employeeId: f.other, workDate: DATE, requestedClockIn: null,
      requestedClockOut: istIso('20:00'), reason: 'Worked late on this day',
      requestedBy: f.other,
    });
    const rejectNoNote = await PATCH(
      req({ action: 'reject' }, adminToken, 'PATCH'),
      { params: Promise.resolve({ id: String(second.id) }) },
    );
    eq('rejecting without a note is refused', rejectNoNote.status, 400);
    const rejected = await PATCH(
      req({ action: 'reject', notes: 'Site says they left at 6' }, adminToken, 'PATCH'),
      { params: Promise.resolve({ id: String(second.id) }) },
    );
    eq('rejecting with a note succeeds', rejected.status, 200);
    const rows = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM attendance WHERE employee_id = ? AND work_date = ?`,
      [f.other, DATE],
    );
    eq('a rejected request changes no attendance', Number(rows?.n ?? 0), 0);

    console.log('\n— a closed month refuses corrections —');
    await closeMonth({ month: MONTH, closedBy: admin.id });
    const afterClose = await POST(req({
      work_date: DATE, requested_clock_out: istIso('19:00'),
      reason: 'Trying to correct a month that is closed',
    }, otherToken));
    eq('raising one in a closed month is refused', afterClose.status, 409);

    // And a request already in the queue cannot be approved into a closed month.
    await query(`DELETE FROM month_closures WHERE period_month = ?`, [`${MONTH}-01`]);
    const queued = await createRequest({
      employeeId: f.other, workDate: DATE, requestedClockIn: istIso('09:00'),
      requestedClockOut: istIso('18:00'), reason: 'Raised before the month was closed',
      requestedBy: f.other,
    });
    await closeMonth({ month: MONTH, closedBy: admin.id });
    let blocked = false;
    try { await approveRequest({ id: queued.id, reviewedBy: admin.id }); }
    catch (e) { blocked = /closed on/i.test((e as Error).message); }
    check('a request raised BEFORE the close cannot be approved after it', blocked);

    console.log('\n— visibility —');
    const mine = await GET(new NextRequest('http://localhost:3000/api/regularisations?status=all', {
      headers: { Cookie: `access_token=${workerToken}` },
    }));
    const mineBody = (await mine.json()) as { data: { requests: Array<{ employee_id: number }> } };
    check('an employee sees only their own requests',
      mineBody.data.requests.every(r => r.employee_id === f!.worker),
      `${mineBody.data.requests.length} rows`);

    const all = await GET(new NextRequest('http://localhost:3000/api/regularisations?status=all', {
      headers: { Cookie: `access_token=${adminToken}` },
    }));
    const allBody = (await all.json()) as { data: { requests: Array<{ employee_id: number }> } };
    check('an administrator sees everybody\'s',
      allBody.data.requests.length > mineBody.data.requests.length,
      `${allBody.data.requests.length} vs ${mineBody.data.requests.length}`);

    eq('an unauthenticated caller is rejected',
      (await GET(new NextRequest('http://localhost:3000/api/regularisations'))).status, 401);
  } finally {
    await cleanup(f);
    const left = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM employees WHERE emp_id LIKE '__REG%'`,
    );
    check('fixture cleaned up', Number(left?.n ?? 0) === 0, `${left?.n} left`);
    console.log(`\n${passed} passed, ${failed} failed`);
  }
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });

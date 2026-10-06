/**
 * scripts/verify-break-policy.ts — the unpaid-break setting, end to end.
 *
 *   npx tsx --env-file=.env.local scripts/verify-break-policy.ts
 *
 * Creates one temporary shift through the real API routes, sets a break on it,
 * and checks the figure actually moves — then deletes it, including on failure.
 *
 * It exists because the column, the engine and the tests all landed before
 * there was any way for an administrator to set the value. The policy was
 * agreed and unreachable, which is the same as not having it.
 */

import { NextRequest } from 'next/server';
import { POST as createShift, GET as listShifts } from '../app/api/schedules/route';
import { PUT as updateShift, DELETE as deleteShift } from '../app/api/schedules/[id]/route';
import { signAccessToken, currentTokenVersion } from '../lib/auth';
import { shiftRequiredMinutes, shiftMinutes } from '../lib/shifts';
import { query, queryOne, pool } from '../lib/db';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

const NAME = '__break_policy_test_shift';

function req(body: unknown, token: string, method = 'POST'): NextRequest {
  return new NextRequest('http://localhost:3000/api/schedules', {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: `access_token=${token}` },
    body: JSON.stringify(body),
  });
}

async function main() {
  let shiftId: number | null = null;
  try {
    const admin = await queryOne<{ id: number; emp_id: string; role: string }>(
      `SELECT id, emp_id, role FROM employees WHERE role = 'super_admin' AND is_active = 1 LIMIT 1`,
    );
    if (!admin) { check('a super_admin exists', false); return; }
    const tv = await currentTokenVersion(admin.id);
    const token = signAccessToken({ id: admin.id, emp_id: admin.emp_id, role: admin.role, tv } as never);

    console.log('\n— creating a shift without a break keeps today\'s behaviour —');
    const created = await createShift(req({
      name: NAME, type: 'fixed', start_time: '09:00', end_time: '18:00',
      grace_minutes: 10, working_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    }, token));
    eq('the shift is created', created.status, 201);
    const body = (await created.json()) as { success: boolean; data: { id: number } };
    shiftId = body.data.id;

    const bare = await queryOne<{ unpaid_break_minutes: number | null; start_time: string; end_time: string }>(
      `SELECT unpaid_break_minutes, start_time, end_time FROM shifts WHERE id = ?`, [shiftId],
    );
    eq('no break is stored when none was given', bare?.unpaid_break_minutes ?? null, null);
    eq('the gross span is nine hours', shiftMinutes(bare!), 540);
    eq('…and with no break set, the requirement is the same nine hours',
      shiftRequiredMinutes(bare!), 540);

    console.log('\n— setting a break changes what the shift requires —');
    const updated = await updateShift(
      req({ unpaid_break_minutes: 60 }, token, 'PUT'),
      { params: Promise.resolve({ id: String(shiftId) }) },
    );
    eq('the update succeeds', updated.status, 200);
    const withBreak = await queryOne<{ unpaid_break_minutes: number | null; start_time: string; end_time: string }>(
      `SELECT unpaid_break_minutes, start_time, end_time FROM shifts WHERE id = ?`, [shiftId],
    );
    eq('the break is stored', Number(withBreak?.unpaid_break_minutes), 60);
    eq('the gross span is unchanged', shiftMinutes(withBreak!), 540);
    eq('the requirement drops to eight hours', shiftRequiredMinutes(withBreak!), 480);

    console.log('\n— the value survives a round trip through the list endpoint —');
    const listed = await listShifts(new NextRequest('http://localhost:3000/api/schedules', {
      headers: { Cookie: `access_token=${token}` },
    }));
    const all = (await listed.json()) as { data: { shifts?: Array<Record<string, unknown>> } | Array<Record<string, unknown>> };
    const rows = Array.isArray(all.data) ? all.data : (all.data.shifts ?? []);
    const mine = rows.find(r => r.name === NAME);
    check('the shift comes back from GET', Boolean(mine));
    eq('…carrying the break value, so the form can show it',
      Number(mine?.unpaid_break_minutes), 60);

    console.log('\n— clearing it restores the original behaviour —');
    await updateShift(
      req({ unpaid_break_minutes: null }, token, 'PUT'),
      { params: Promise.resolve({ id: String(shiftId) }) },
    );
    const cleared = await queryOne<{ unpaid_break_minutes: number | null; start_time: string; end_time: string }>(
      `SELECT unpaid_break_minutes, start_time, end_time FROM shifts WHERE id = ?`, [shiftId],
    );
    eq('the break is cleared', cleared?.unpaid_break_minutes ?? null, null);
    eq('and the requirement is nine hours again', shiftRequiredMinutes(cleared!), 540);

    console.log('\n— nonsense values are refused —');
    const tooBig = await updateShift(
      req({ unpaid_break_minutes: 999 }, token, 'PUT'),
      { params: Promise.resolve({ id: String(shiftId) }) },
    );
    eq('a break longer than four hours is rejected', tooBig.status, 400);
    const negative = await updateShift(
      req({ unpaid_break_minutes: -30 }, token, 'PUT'),
      { params: Promise.resolve({ id: String(shiftId) }) },
    );
    eq('a negative break is rejected', negative.status, 400);

    console.log('\n— nothing in production has a policy set yet —');
    const live = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM shifts WHERE unpaid_break_minutes IS NOT NULL AND name <> ?`,
      [NAME],
    );
    check('no real shift has been changed by this work',
      Number(live[0]?.n ?? 0) === 0,
      `${live[0]?.n} shift(s) carry a break policy — expected 0 until somebody sets one deliberately`);
  } finally {
    if (shiftId) {
      const admin = await queryOne<{ id: number; emp_id: string; role: string }>(
        `SELECT id, emp_id, role FROM employees WHERE role = 'super_admin' AND is_active = 1 LIMIT 1`,
      );
      if (admin) {
        const tv = await currentTokenVersion(admin.id);
        const token = signAccessToken({ id: admin.id, emp_id: admin.emp_id, role: admin.role, tv } as never);
        await deleteShift(
          new NextRequest('http://localhost:3000/api/schedules', {
            method: 'DELETE', headers: { Cookie: `access_token=${token}` },
          }),
          { params: Promise.resolve({ id: String(shiftId) }) },
        ).catch(() => null);
      }
      await query(`DELETE FROM shifts WHERE name = ?`, [NAME]);
    }
    const left = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM shifts WHERE name = ?`, [NAME]);
    check('test shift cleaned up', Number(left?.n ?? 0) === 0);
    console.log(`\n${passed} passed, ${failed} failed`);
  }
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });

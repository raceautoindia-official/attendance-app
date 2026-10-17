/**
 * scripts/verify-onboarding-api.ts — the joining and leaving endpoints.
 *
 *   npx tsx --env-file=.env.local scripts/verify-onboarding-api.ts
 *
 * verify-onboarding.ts proves the library. The interesting surface here is the
 * one the library does not have: an ORDINARY EMPLOYEE can reach these
 * endpoints, because several joining tasks are genuinely theirs to do and
 * routing those through HR is how a checklist becomes a chase.
 *
 * That makes the boundary worth attacking directly:
 *
 *   - they may read their own checklist and nobody else's
 *   - they may tick a task whose owner is 'employee'
 *   - they may NOT tick one owned by HR, IT or finance - "access revoked" and
 *     "final settlement paid" are not theirs to mark done
 *   - a task on somebody else's list answers the same way as a task that does
 *     not exist, so the response cannot be used to probe for ids
 *
 * Everything it creates is prefixed ZZOA and removed at the end.
 */

import { NextRequest } from 'next/server';
import { GET as journeysGet, POST as journeysPost } from '../app/api/onboarding/journeys/route';
import { POST as tasksPost } from '../app/api/onboarding/tasks/route';
import { signAccessToken, currentTokenVersion } from '../lib/auth';
import { query, queryOne, pool } from '../lib/db';

let passed = 0;
let failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`); }
};
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

const JOURNEYS = 'http://localhost:3000/api/onboarding/journeys';
const TASKS = 'http://localhost:3000/api/onboarding/tasks';

function req(token: string, body?: unknown, url = JOURNEYS) {
  return new NextRequest(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `access_token=${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function tokenForId(id: number) {
  const e = await queryOne<{ id: number; emp_id: string; role: string }>(
    `SELECT id, emp_id, role FROM employees WHERE id = ?`, [id]);
  const tv = await currentTokenVersion(e!.id);
  return signAccessToken({ id: e!.id, emp_id: e!.emp_id, role: e!.role, tv } as never);
}

async function cleanup() {
  await query(`DELETE t FROM employee_onboarding_tasks t
                 JOIN employee_onboarding j ON j.id = t.journey_id
                 JOIN employees e ON e.id = j.employee_id WHERE e.emp_id LIKE 'ZZOA%'`);
  await query(`DELETE j FROM employee_onboarding j JOIN employees e ON e.id = j.employee_id
                WHERE e.emp_id LIKE 'ZZOA%'`);
  await query(`DELETE FROM employees WHERE emp_id LIKE 'ZZOA%'`);
}

async function main() {
  try {
    await cleanup();
    const adminRow = (await queryOne<{ id: number }>(
      `SELECT id FROM employees WHERE role = 'super_admin' AND is_active = 1 LIMIT 1`))!;
    const admin = await tokenForId(adminRow.id);

    const mk = async (e: string, n: string) => ((await query(
      `INSERT INTO employees (emp_id, name, pin_hash, role, is_active) VALUES (?, ?, 'x', 'employee', 1)`,
      [e, n])) as unknown as { insertId: number }).insertId;
    const starter = await mk('ZZOA1', 'ZZOA Starter');
    const other = await mk('ZZOA2', 'ZZOA Somebody Else');
    const starterToken = await tokenForId(starter);
    const otherToken = await tokenForId(other);

    console.log('\n— starting a checklist —');
    const started = await journeysPost(req(admin, {
      action: 'start', employee_id: starter, direction: 'onboarding',
      anchor_date: '2026-10-05',
    }));
    eq('an admin can start one', started.status, 201);

    const dup = await journeysPost(req(admin, {
      action: 'start', employee_id: starter, direction: 'onboarding', anchor_date: '2026-10-05',
    }));
    eq('a second in the same direction is refused', dup.status, 400);
    check('and says why', /already has a/i.test((await dup.json()).error), 'explained');

    const employeeStarting = await journeysPost(req(starterToken, {
      action: 'start', employee_id: other, direction: 'onboarding', anchor_date: '2026-10-05',
    }));
    check('an employee cannot start one for anybody',
      employeeStarting.status === 401 || employeeStarting.status === 403,
      `got ${employeeStarting.status}`);

    console.log('\n— an employee reads their own list, and only that —');
    const board = await journeysGet(req(admin, undefined, `${JOURNEYS}?with_queue=1`));
    eq('an admin sees the board', board.status, 200);
    const boardData = (await board.json()).data;
    check('with the attention queue', boardData.queue !== null);

    const noMine = await journeysGet(req(starterToken, undefined, JOURNEYS));
    check('an employee cannot read the whole board',
      noMine.status === 401 || noMine.status === 403, `got ${noMine.status}`);

    const mine = await journeysGet(req(starterToken, undefined, `${JOURNEYS}?mine=1`));
    eq('but can read their own', mine.status, 200);
    const mineJourneys = (await mine.json()).data.journeys as Array<{ employee_id: number; tasks: Array<{ id: number; owner_role: string; status: string }> }>;
    eq('which is exactly one checklist', mineJourneys.length, 1);
    eq('and it is theirs', mineJourneys[0].employee_id, starter);

    const theirs = await journeysGet(req(otherToken, undefined, `${JOURNEYS}?mine=1`));
    const theirsJourneys = (await theirs.json()).data.journeys as unknown[];
    eq('somebody with no checklist sees none, not somebody else s', theirsJourneys.length, 0);

    console.log('\n— who may tick what —');
    const tasks = mineJourneys[0].tasks;
    const ownTask = tasks.find(t => t.owner_role === 'employee');
    const hrTask = tasks.find(t => t.owner_role === 'hr')!;
    const itTask = tasks.find(t => t.owner_role === 'it')!;

    if (ownTask) {
      const ok = await tasksPost(req(starterToken, { task_id: ownTask.id, status: 'done' }, TASKS));
      eq('they can tick one that is theirs to do', ok.status, 200);
    } else {
      check('the template has at least one employee-owned task', false, 'none found');
    }

    const refusedHr = await tasksPost(req(starterToken, { task_id: hrTask.id, status: 'done' }, TASKS));
    eq('but not one owned by HR', refusedHr.status, 403);
    check('and is told who to ask',
      /somebody else is responsible/i.test((await refusedHr.json()).error), 'explained');

    const refusedIt = await tasksPost(req(starterToken, { task_id: itTask.id, status: 'done' }, TASKS));
    eq('nor one owned by IT', refusedIt.status, 403);

    const someoneElses = await tasksPost(req(otherToken, { task_id: hrTask.id, status: 'done' }, TASKS));
    eq('a task on somebody else s list is refused', someoneElses.status, 403);
    // Same wording as a task that does not exist, so the response cannot be
    // used to discover which ids belong to whose checklist.
    const missing = await tasksPost(req(otherToken, { task_id: 99999999, status: 'done' }, TASKS));
    eq('and a task that does not exist answers identically', missing.status, 403);
    check('with the same message, so ids cannot be probed',
      (await someoneElses.json()).error === (await missing.json()).error);

    console.log('\n— an admin may tick anything on the list —');
    eq('including an HR task',
      (await tasksPost(req(admin, { task_id: hrTask.id, status: 'done' }, TASKS))).status, 200);
    const afterTick = await journeysGet(req(admin, undefined, JOURNEYS));
    const j = ((await afterTick.json()).data.journeys as Array<{ employee_id: number; done: number }>)
      .find(x => x.employee_id === starter)!;
    check('and progress moves', j.done >= 1, `${j.done} done`);

    console.log('\n— finishing —');
    const blocked = await journeysPost(req(admin, {
      action: 'complete', journey_id: (await queryOne<{ id: number }>(
        `SELECT id FROM employee_onboarding WHERE employee_id = ? AND status = 'in_progress'`,
        [starter]))!.id,
    }));
    eq('refused while required tasks are open', blocked.status, 400);
    check('listing what is still open',
      /still open/i.test((await blocked.json()).error), 'explained');

    const journeyId = (await queryOne<{ id: number }>(
      `SELECT id FROM employee_onboarding WHERE employee_id = ? AND status = 'in_progress'`,
      [starter]))!.id;
    eq('and allowed when forced',
      (await journeysPost(req(admin, { action: 'complete', journey_id: journeyId, force: true }))).status, 200);

    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    await cleanup();
  }
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });

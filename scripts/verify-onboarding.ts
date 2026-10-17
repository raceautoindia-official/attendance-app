/**
 * scripts/verify-onboarding.ts — joining and leaving checklists.
 *
 *   npx tsx --env-file=.env.local scripts/verify-onboarding.ts
 *
 * The behaviours worth guarding are the ones that protect against a checklist
 * being quietly wrong rather than visibly broken:
 *
 *   - tasks are COPIED from the template, so editing the template later does
 *     not rewrite what somebody was already asked to do
 *   - a blocking task stops a checklist being closed, and an override is
 *     recorded rather than silent — "access revoked" left pending on somebody
 *     who has already left is the exact case this exists for
 *   - only PENDING tasks can be overdue; "not applicable" is a decision, not
 *     a thing left undone
 *   - nobody gets two open checklists in the same direction, because that
 *     means two sets of dates and two people each assuming the other is on it
 *
 * Everything it creates is prefixed ZZOB and removed at the end.
 */

import {
  defaultTemplate, startJourney, listJourneys, setTaskStatus,
  completeJourney, cancelJourney, attentionQueue, OnboardingError,
} from '../lib/onboarding';
import { query, queryOne, pool } from '../lib/db';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

async function refused(label: string, fn: () => Promise<unknown>) {
  try { await fn(); check(label, false, 'it was allowed'); }
  catch (e) { check(label, e instanceof OnboardingError, (e as Error).message.slice(0, 90)); }
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysFromNow = (n: number) => ymd(new Date(Date.now() + n * 86_400_000));

async function cleanup() {
  await query(`DELETE t FROM employee_onboarding_tasks t
                 JOIN employee_onboarding j ON j.id = t.journey_id
                 JOIN employees e ON e.id = j.employee_id WHERE e.emp_id LIKE 'ZZOB%'`);
  await query(`DELETE j FROM employee_onboarding j JOIN employees e ON e.id = j.employee_id
                WHERE e.emp_id LIKE 'ZZOB%'`);
  await query(`DELETE FROM employees WHERE emp_id LIKE 'ZZOB%'`);
  await query(`DELETE tt FROM onboarding_template_tasks tt
                 JOIN onboarding_templates t ON t.id = tt.template_id WHERE t.name LIKE 'ZZOB%'`);
  await query(`DELETE FROM onboarding_templates WHERE name LIKE 'ZZOB%'`);
}

async function main() {
  const ACTOR = (await queryOne<{ id: number }>(
    `SELECT id FROM employees WHERE role = 'super_admin' AND is_active = 1 LIMIT 1`))!.id;
  try {
    await cleanup();

    console.log('\n— the shipped templates —');
    const joining = await defaultTemplate('onboarding');
    const leaving = await defaultTemplate('offboarding');
    check('there is a default joining checklist', Boolean(joining), joining?.name);
    check('and a default leaving one', Boolean(leaving), leaving?.name);
    check('joining covers the three that were asked for',
      ['ID card', 'training', 'Attendance app'].every(
        k => joining!.tasks.some(t => t.title.toLowerCase().includes(k.toLowerCase()))),
      joining!.tasks.length + ' tasks');
    check('and includes work due BEFORE day one',
      joining!.tasks.some(t => t.due_offset_days < 0),
      `earliest ${Math.min(...joining!.tasks.map(t => t.due_offset_days))} days`);
    check('leaving blocks on revoking access',
      leaving!.tasks.some(t => /revoked/i.test(t.title) && t.is_blocking));
    check('blocking is used sparingly, or it means nothing',
      joining!.tasks.filter(t => t.is_blocking).length < joining!.tasks.length,
      `${joining!.tasks.filter(t => t.is_blocking).length} of ${joining!.tasks.length}`);

    console.log('\n— starting somebody —');
    const emp = ((await query(
      `INSERT INTO employees (emp_id, name, pin_hash, role, is_active)
       VALUES ('ZZOB1', 'ZZOB Starter', 'x', 'employee', 1)`,
    )) as unknown as { insertId: number }).insertId;

    const anchor = daysFromNow(-10);
    const journeyId = await startJourney({
      employeeId: emp, direction: 'onboarding', anchorDate: anchor, by: ACTOR });

    const [journey] = await listJourneys({ employeeId: emp });
    eq('the checklist was created', journey.status, 'in_progress');
    eq('with every task from the template', journey.total, joining!.tasks.length);
    check('dates resolved from the anchor, not left as offsets',
      journey.tasks.every(t => t.due_on !== null && /^\d{4}-\d{2}-\d{2}$/.test(t.due_on)));

    // The pre-start tasks must land before the anchor, which is the thing a
    // naive "all due on day one" implementation gets wrong.
    const earliest = journey.tasks.map(t => t.due_on!).sort()[0];
    check('and work due before day one really is dated earlier',
      earliest < anchor, `${earliest} < ${anchor}`);

    eq('the joining date was recorded on the employee',
      (await queryOne<{ joined_on: string }>(
        `SELECT DATE_FORMAT(joined_on, '%Y-%m-%d') AS joined_on FROM employees WHERE id = ?`,
        [emp]))?.joined_on, anchor);

    console.log('\n— two open checklists in one direction is refused —');
    await refused('a second joining checklist is refused',
      () => startJourney({ employeeId: emp, direction: 'onboarding',
        anchorDate: anchor, by: ACTOR }));
    // The other direction is a different thing entirely and must be allowed:
    // somebody can be mid-onboarding and resign.
    const offId = await startJourney({
      employeeId: emp, direction: 'offboarding', anchorDate: daysFromNow(20), by: ACTOR });
    check('but a leaving checklist alongside it is allowed', offId > 0);
    await cancelJourney(offId, ACTOR);

    console.log('\n— editing the template does not rewrite live checklists —');
    const tplTask = joining!.tasks[0];
    await query(`UPDATE onboarding_template_tasks SET title = ? WHERE id = ?`,
      ['ZZOB RENAMED IN TEMPLATE', tplTask.id]);
    const [stillTheSame] = await listJourneys({ employeeId: emp, direction: 'onboarding' });
    check('the live checklist keeps the wording it was handed',
      !stillTheSame.tasks.some(t => t.title === 'ZZOB RENAMED IN TEMPLATE'),
      'unchanged');
    await query(`UPDATE onboarding_template_tasks SET title = ? WHERE id = ?`,
      [tplTask.title, tplTask.id]);

    console.log('\n— overdue means pending, past its date, and nothing else —');
    const overdueNow = stillTheSame.tasks.filter(t => t.overdue);
    check('tasks dated before today are overdue', overdueNow.length > 0, `${overdueNow.length}`);
    const one = overdueNow[0];
    await setTaskStatus({ taskId: one.id, status: 'not_applicable', by: ACTOR,
      notes: 'ZZOB not needed' });
    const [afterNA] = await listJourneys({ employeeId: emp, direction: 'onboarding' });
    check('marking one not applicable clears it from overdue',
      !afterNA.tasks.find(t => t.id === one.id)?.overdue);
    check('and it counts as handled, not outstanding',
      afterNA.done > stillTheSame.done, `${stillTheSame.done} -> ${afterNA.done}`);

    console.log('\n— a blocking task stops the checklist closing —');
    const blockingLeft = afterNA.blocking_outstanding;
    check('there are blocking tasks outstanding', blockingLeft > 0, `${blockingLeft}`);
    await refused('closing is refused while one is open',
      () => completeJourney({ journeyId, by: ACTOR }));

    // Reality sometimes requires finishing anyway. It must be possible, and it
    // must be recorded - which is the difference between an override and a
    // silent gap.
    await completeJourney({ journeyId, by: ACTOR, force: true });
    const [closed] = await listJourneys({ employeeId: emp, direction: 'onboarding' });
    eq('forcing closes it', closed.status, 'completed');
    // `details` is a JSON column, which mysql2 hands back already parsed, so
    // it has to be re-serialised to be searched rather than String()-ed into
    // '[object Object]'.
    const forced = await queryOne<{ details: unknown }>(
      `SELECT details FROM audit_log WHERE action = 'onboarding_completed'
        ORDER BY id DESC LIMIT 1`);
    const detailText = JSON.stringify(forced?.details ?? null);
    check('and the override is in the audit log with what was skipped',
      /"forced":true/.test(detailText) && /skipped_blocking/.test(detailText),
      detailText.slice(0, 100));
    await refused('a closed checklist cannot be closed again',
      () => completeJourney({ journeyId, by: ACTOR }));

    console.log('\n— the queue only lists what needs chasing —');
    const emp2 = ((await query(
      `INSERT INTO employees (emp_id, name, pin_hash, role, is_active)
       VALUES ('ZZOB2', 'ZZOB Leaver', 'x', 'employee', 1)`,
    )) as unknown as { insertId: number }).insertId;
    await startJourney({ employeeId: emp2, direction: 'offboarding',
      anchorDate: daysFromNow(-5), by: ACTOR });

    const queue = await attentionQueue();
    check('overdue work is listed', queue.overdue.length > 0, `${queue.overdue.length}`);
    check('every entry names who should do it',
      queue.overdue.every(o => Boolean(o.owner_role)));
    check('nothing from a closed checklist appears',
      !queue.overdue.some(o => o.journey_id === journeyId));
    check('and nothing dated in the future appears',
      queue.overdue.every(o => o.due_on < ymd(new Date())));

    const soon = await startJourney({ employeeId: emp, direction: 'offboarding',
      anchorDate: daysFromNow(14), by: ACTOR });
    const q2 = await attentionQueue();
    check('somebody leaving soon is flagged before the date, not after',
      q2.starting_soon.some(s => s.emp_id === 'ZZOB1'), `${q2.starting_soon.length} upcoming`);
    await cancelJourney(soon, ACTOR);

    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    await cleanup();
  }
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });

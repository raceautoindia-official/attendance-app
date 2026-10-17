/**
 * scripts/verify-alerts.ts — the alert engine.
 *
 *   npx tsx --env-file=.env.local scripts/verify-alerts.ts
 *
 * An alert engine fails in one of four ways, and all four are quiet:
 *
 *   IT FIRES WHEN NOBODY ASKED. The thresholds are NULL until somebody sets
 *   one, so the first block proves a run with no thresholds produces nothing.
 *   Twelve of eighteen active people are on flexible shifts, and a rule that
 *   named them every morning would get the feature muted in a week.
 *
 *   IT FIRES TWICE. One row per employee per rule per period, updated in
 *   place. Running the same rule four times must leave one row.
 *
 *   IT NEVER STOPS FIRING. An alert whose fact has gone - leave approved
 *   afterwards, attendance corrected - has to resolve itself, and an
 *   acknowledged one must not come back to be acknowledged again.
 *
 *   IT DISAGREES WITH THE REPORTS. Lateness and hours come from the same
 *   ledger the Reports page reads, so the numbers in the alert are asserted
 *   against the ledger rather than recomputed here.
 */

import { NextRequest } from 'next/server';
import { GET as alertsGet, POST as alertsPost } from '../app/api/alerts/route';
import {
  runAlerts, listAlerts, listRules, acknowledgeAlert, snoozeAlert,
  setRuleEnabled, selfPhrasing, RULES, AlertError,
} from '../lib/alerts';
import { digestEnabled, sendAlertDigest } from '../lib/alertDigest';
import { getWorkDateIST } from '../lib/attendance';
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

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const today = ymd(new Date());
const month = today.slice(0, 7);

async function adminToken() {
  const e = await queryOne<{ id: number; emp_id: string; role: string }>(
    `SELECT id, emp_id, role FROM employees WHERE role = 'super_admin' AND is_active = 1 LIMIT 1`);
  if (!e) throw new Error('no active super_admin to act as');
  const tv = await currentTokenVersion(e.id);
  return { token: signAccessToken({ id: e.id, emp_id: e.emp_id, role: e.role, tv } as never), id: e.id };
}

async function cleanup() {
  await query(`DELETE a FROM alerts a JOIN employees e ON e.id = a.employee_id WHERE e.emp_id LIKE 'ZZAL%'`);
  await query(`DELETE ep FROM employee_policies ep JOIN employees e ON e.id = ep.employee_id WHERE e.emp_id LIKE 'ZZAL%'`);
  await query(`DELETE es FROM employee_schedules es JOIN employees e ON e.id = es.employee_id WHERE e.emp_id LIKE 'ZZAL%'`);
  await query(`DELETE lr FROM leave_records lr JOIN employees e ON e.id = lr.employee_id WHERE e.emp_id LIKE 'ZZAL%'`);
  await query(`DELETE at FROM attendance at JOIN employees e ON e.id = at.employee_id WHERE e.emp_id LIKE 'ZZAL%'`);
  await query(`DELETE FROM employees WHERE emp_id LIKE 'ZZAL%'`);
  await query(`DELETE FROM policies WHERE code LIKE 'ZZAL%'`);
  await query(`DELETE FROM shifts WHERE name LIKE 'ZZAL%'`);
  await query(`DELETE FROM alert_deliveries WHERE recipient LIKE 'zzal%' OR period_key LIKE 'ZZAL%'`);
}

async function main() {
  try {
    await cleanup();
    const admin = await adminToken();

    // ---------------------------------------------------------------------
    // Fixtures: one person, one fixed shift, one policy with nothing set.
    // ---------------------------------------------------------------------
    await query(
      `INSERT INTO shifts (name, type, start_time, end_time, working_days, grace_minutes)
       VALUES ('ZZAL Morning', 'fixed', '09:00:00', '18:00:00',
               JSON_ARRAY('Mon','Tue','Wed','Thu','Fri','Sat','Sun'), 10)`);
    const shiftId = Number((await queryOne<{ id: number }>(
      `SELECT id FROM shifts WHERE name = 'ZZAL Morning'`))?.id);

    await query(
      `INSERT INTO policies (name, code, is_active, hours_basis) VALUES ('ZZAL Policy', 'ZZAL1', 1, 'roster')`);
    const policyId = Number((await queryOne<{ id: number }>(
      `SELECT id FROM policies WHERE code = 'ZZAL1'`))?.id);

    await query(
      `INSERT INTO employees (emp_id, name, pin_hash, role, is_active)
       VALUES ('ZZAL001', 'ZZAL Late Person', 'x', 'employee', 1)`);
    const employeeId = Number((await queryOne<{ id: number }>(
      `SELECT id FROM employees WHERE emp_id = 'ZZAL001'`))?.id);

    await query(
      `INSERT INTO employee_schedules (employee_id, shift_id, effective_from, assigned_by)
       VALUES (?, ?, DATE_SUB(?, INTERVAL 60 DAY), ?)`,
      [employeeId, shiftId, `${month}-01`, admin.id]);
    await query(
      `INSERT INTO employee_policies (employee_id, policy_id, effective_from, assigned_by)
       VALUES (?, ?, DATE_SUB(?, INTERVAL 60 DAY), ?)`,
      [employeeId, policyId, `${month}-01`, admin.id]);

    const mine = () => listAlerts({ employeeId, states: ['open', 'acknowledged'] });

    console.log('\n— the catalogue —');
    const rules = await listRules();
    eq('every rule in code has a row', rules.length, RULES.length);
    check('and every row is a rule in code',
      rules.every(r => RULES.some(c => c.key === r.rule_key)),
      rules.map(r => r.rule_key).join(', '));

    console.log('\n— nothing fires with no threshold set —');
    await runAlerts({ family: 'pattern' });
    eq('no alerts for a policy with every threshold NULL', (await mine()).length, 0);

    console.log('\n— repeated lateness, once the policy says so —');
    // Three late days: clocked in at 10:00 IST against a 09:00 shift with a
    // 10 minute grace. 'late' status, because that is what the reports count.
    for (const day of [1, 2, 3]) {
      const date = `${month}-${String(day).padStart(2, '0')}`;
      await query(
        `INSERT INTO attendance
           (employee_id, work_date, first_clock_in_utc, clock_in_utc, clock_out_utc,
            total_minutes, status)
         VALUES (?, ?, CONCAT(?, ' 04:30:00'), CONCAT(?, ' 04:30:00'),
                 CONCAT(?, ' 12:30:00'), 480, 'late')`,
        [employeeId, date, date, date, date]);
    }
    await query(`UPDATE policies SET late_alert_days_per_month = 3 WHERE id = ?`, [policyId]);

    const first = await runAlerts({ family: 'pattern', only: ['late_pattern'] });
    eq('one alert opened', first.opened, 1);
    const late = (await mine()).find(a => a.rule_key === 'late_pattern');
    check('it exists', Boolean(late), late?.title);
    eq('it is keyed to the month', late?.period_key, month);
    check('it names the count', Boolean(late?.title.includes('3 times')), late?.title);
    const detail = (late?.detail ?? {}) as Record<string, number>;
    eq('the detail agrees with the ledger', Number(detail.days_late), 3);
    check('and records what the threshold was', Number(detail.threshold) === 3);

    console.log('\n— running it again does not pile up —');
    const second = await runAlerts({ family: 'pattern', only: ['late_pattern'] });
    eq('nothing new opened', second.opened, 0);
    eq('the existing row was updated', second.updated, 1);
    await runAlerts({ family: 'pattern', only: ['late_pattern'] });
    await runAlerts({ family: 'pattern', only: ['late_pattern'] });
    eq('four runs, one row',
      (await mine()).filter(a => a.rule_key === 'late_pattern').length, 1);

    console.log('\n— acknowledging it, with the note that is the outcome —');
    await acknowledgeAlert({ id: late!.id, by: admin.id, note: 'Spoke to him - bus route changed' });
    const acked = (await mine()).find(a => a.id === late!.id);
    eq('the state moves', acked?.state, 'acknowledged');
    eq('the note is kept', acked?.acknowledge_note, 'Spoke to him - bus route changed');
    check('and who did it', Boolean(acked?.acknowledged_by_name), acked?.acknowledged_by_name ?? '');
    check('it is in the audit log',
      Number((await queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'alert_acknowledged' AND entity_id = ?`,
        [late!.id]))?.n) === 1);

    await runAlerts({ family: 'pattern', only: ['late_pattern'] });
    eq('a later run does not reopen it to be acknowledged again',
      (await mine()).find(a => a.id === late!.id)?.state, 'acknowledged');

    console.log('\n— it resolves itself when the fact goes —');
    await query(`UPDATE policies SET late_alert_days_per_month = 10 WHERE id = ?`, [policyId]);
    const third = await runAlerts({ family: 'pattern', only: ['late_pattern'] });
    eq('one resolved', third.resolved, 1);
    eq('and it has left the queue', (await mine()).filter(a => a.rule_key === 'late_pattern').length, 0);

    console.log('\n— and reopens if it comes back —');
    await query(`UPDATE policies SET late_alert_days_per_month = 3 WHERE id = ?`, [policyId]);
    await runAlerts({ family: 'pattern', only: ['late_pattern'] });
    const reopened = (await mine()).find(a => a.rule_key === 'late_pattern');
    eq('open again', reopened?.state, 'open');
    eq('as the same row, not a second one', reopened?.id, late?.id);

    console.log('\n— lateness that cannot be measured is never a pattern —');
    // A flexible shift records no lateness, so days_late is 0 of 0 measured.
    await query(
      `INSERT INTO shifts (name, type, required_hours, working_days)
       VALUES ('ZZAL Flexible', 'flexible', 9,
               JSON_ARRAY('Mon','Tue','Wed','Thu','Fri','Sat','Sun'))`);
    const flexId = Number((await queryOne<{ id: number }>(
      `SELECT id FROM shifts WHERE name = 'ZZAL Flexible'`))?.id);
    await query(
      `INSERT INTO employees (emp_id, name, pin_hash, role, is_active)
       VALUES ('ZZAL002', 'ZZAL Flexible Person', 'x', 'employee', 1)`);
    const flexPerson = Number((await queryOne<{ id: number }>(
      `SELECT id FROM employees WHERE emp_id = 'ZZAL002'`))?.id);
    await query(
      `INSERT INTO employee_schedules (employee_id, shift_id, effective_from, assigned_by)
       VALUES (?, ?, ?, ?)`, [flexPerson, flexId, `${month}-01`, admin.id]);
    await query(
      `INSERT INTO employee_policies (employee_id, policy_id, effective_from, assigned_by)
       VALUES (?, ?, ?, ?)`, [flexPerson, policyId, `${month}-01`, admin.id]);
    for (const day of [1, 2, 3, 4]) {
      const date = `${month}-${String(day).padStart(2, '0')}`;
      await query(
        `INSERT INTO attendance
           (employee_id, work_date, first_clock_in_utc, clock_in_utc, clock_out_utc, total_minutes, status)
         VALUES (?, ?, CONCAT(?, ' 06:00:00'), CONCAT(?, ' 06:00:00'), CONCAT(?, ' 14:00:00'), 480, 'present')`,
        [flexPerson, date, date, date, date]);
    }
    await runAlerts({ family: 'pattern', only: ['late_pattern'] });
    eq('the flexible employee gets no lateness alert',
      (await listAlerts({ employeeId: flexPerson })).filter(a => a.rule_key === 'late_pattern').length, 0);

    console.log('\n— nobody has clocked in —');
    // The rule the whole feature was asked for. It is time-sensitive, so the
    // clock is passed in rather than waited for: 14:00 IST is well past a
    // 09:00 shift plus ten minutes of grace plus a thirty minute allowance.
    const workDate = getWorkDateIST();
    const afternoon = new Date(`${workDate}T14:00:00+05:30`);

    // Nobody has an allowance set yet, so there is nothing to report even
    // though two fixtures are rostered today and have clocked nothing.
    const before = await runAlerts({ family: 'live', now: afternoon });
    eq('silent with no allowance set', before.opened, 0);

    await query(`UPDATE policies SET missing_clockin_alert_minutes = 30 WHERE id = ?`, [policyId]);
    await runAlerts({ family: 'live', now: afternoon });
    const missing = (await listAlerts({ employeeId, states: ['open'] }))
      .find(a => a.rule_key === 'not_clocked_in');
    check('the person on a fixed shift is reported', Boolean(missing), missing?.title);
    eq('keyed to the day, not the month', missing?.period_key, workDate);
    check('it says when they were due', Boolean(missing?.body.includes('09:00')), missing?.body);

    // The flexible employee is rostered today and has clocked nothing either,
    // and must NOT be named: there is no start time to be late against.
    // Twelve of eighteen active people are in this position.
    eq('the flexible employee is not reported',
      (await listAlerts({ employeeId: flexPerson, states: ['open'] }))
        .filter(a => a.rule_key === 'not_clocked_in').length, 0);

    console.log('\n— and the excuses it has to respect —');
    // Approved permission covering today is permission to be elsewhere.
    await query(
      `INSERT INTO permission_requests
         (employee_id, request_type, permission_date, start_time, end_time, minutes,
          reason, status, requested_by, reviewed_by, reviewed_at)
       VALUES (?, 'permission', ?, '09:00:00', '11:00:00', 120, 'Bank',
               'approved', ?, ?, UTC_TIMESTAMP())`,
      [employeeId, workDate, employeeId, admin.id]);
    const afterPermission = await runAlerts({ family: 'live', now: afternoon });
    eq('an approved permission resolves it', afterPermission.resolved, 1);
    eq('and it is out of the queue',
      (await listAlerts({ employeeId, states: ['open'] }))
        .filter(a => a.rule_key === 'not_clocked_in').length, 0);

    await query(`DELETE FROM permission_requests WHERE employee_id = ?`, [employeeId]);
    await runAlerts({ family: 'live', now: afternoon });
    eq('removing it brings the alert back',
      (await listAlerts({ employeeId, states: ['open'] }))
        .filter(a => a.rule_key === 'not_clocked_in').length, 1);

    // Leave does the same, through expectedButMissing - the one definition of
    // 'expected to work today' that the absence job and Overview also use.
    await query(
      `INSERT INTO leave_records (employee_id, leave_date, leave_type, created_by)
       VALUES (?, ?, 'sick', ?)`, [employeeId, workDate, admin.id]);
    await runAlerts({ family: 'live', now: afternoon });
    eq('leave resolves it too',
      (await listAlerts({ employeeId, states: ['open'] }))
        .filter(a => a.rule_key === 'not_clocked_in').length, 0);
    await query(`DELETE FROM leave_records WHERE employee_id = ? AND leave_date = ?`,
      [employeeId, workDate]);

    // Before the allowance has passed, nothing is said. 09:05 is inside the
    // grace period, let alone the allowance.
    await query(`UPDATE alerts SET state = 'resolved' WHERE rule_key = 'not_clocked_in'`);
    const earlyMorning = new Date(`${workDate}T09:05:00+05:30`);
    const early = await runAlerts({ family: 'live', now: earlyMorning });
    eq('nothing is said inside the allowance', early.opened, 0);
    console.log('\n— heavy leave —');
    await query(`UPDATE policies SET leave_alert_days_per_month = 2 WHERE id = ?`, [policyId]);
    for (const day of [10, 11]) {
      await query(
        `INSERT INTO leave_records (employee_id, leave_date, leave_type, created_by)
         VALUES (?, ?, 'casual', ?)`,
        [employeeId, `${month}-${String(day).padStart(2, '0')}`, admin.id]);
    }
    // A company holiday, which must NOT count: it is not leave anybody took.
    await query(
      `INSERT INTO leave_records (employee_id, leave_date, leave_type, created_by)
       VALUES (?, ?, 'holiday', ?)`, [employeeId, `${month}-12`, admin.id]);
    await runAlerts({ family: 'pattern', only: ['leave_pattern'] });
    const leave = (await mine()).find(a => a.rule_key === 'leave_pattern');
    check('an alert for the two days', Boolean(leave), leave?.title);
    eq('the holiday is not counted',
      Number((leave?.detail as Record<string, number>)?.leave_days), 2);

    console.log('\n— snoozing hides it without resolving it —');
    const until = ymd(new Date(Date.now() + 5 * 86_400_000));
    await snoozeAlert({ id: leave!.id, until, by: admin.id });
    const visible = await listAlerts({ employeeId });
    check('it is out of the queue', !visible.some(a => a.id === leave!.id));
    const withSnoozed = await listAlerts({ employeeId, includeSnoozed: true });
    check('but still there, and still open',
      withSnoozed.find(a => a.id === leave!.id)?.state === 'open');
    let snoozeRefused = '';
    try { await snoozeAlert({ id: leave!.id, until: '2020-01-01', by: admin.id }); }
    catch (e) { snoozeRefused = e instanceof AlertError ? 'refused' : 'wrong error'; }
    eq('a snooze into the past is refused', snoozeRefused, 'refused');

    console.log('\n— switching a rule off clears what it had open —');
    await setRuleEnabled({ ruleKey: 'leave_pattern', enabled: false, by: admin.id });
    eq('its alerts are resolved',
      (await listAlerts({ employeeId, includeSnoozed: true })).filter(a => a.rule_key === 'leave_pattern').length, 0);
    const off = await runAlerts({ family: 'pattern', only: ['leave_pattern'] });
    eq('and it no longer runs', off.ran, []);
    eq('it is reported as skipped', off.skipped, ['leave_pattern']);
    await setRuleEnabled({ ruleKey: 'leave_pattern', enabled: true, by: admin.id });
    let ruleRefused = '';
    try { await setRuleEnabled({ ruleKey: 'nonsense.rule', enabled: true, by: admin.id }); }
    catch (e) { ruleRefused = e instanceof AlertError ? 'refused' : 'wrong error'; }
    eq('an unknown rule key is refused', ruleRefused, 'refused');

    console.log('\n— a month nobody has closed —');
    const lifecycle = await runAlerts({ family: 'lifecycle', only: ['month_not_closed'] });
    const companyAlert = await queryOne<{ id: number; employee_id: number | null; period_key: string }>(
      `SELECT id, employee_id, period_key FROM alerts
        WHERE rule_key = 'month_not_closed' AND state <> 'resolved' LIMIT 1`);
    const dayOfMonth = Number(today.slice(8, 10));
    if (dayOfMonth >= 7) {
      check('there is an alert with no employee on it',
        Boolean(companyAlert) && companyAlert?.employee_id === null,
        JSON.stringify(companyAlert));
      // This is what the generated employee_key is for: a unique key with a
      // NULL column in it does not dedupe.
      await runAlerts({ family: 'lifecycle', only: ['month_not_closed'] });
      eq('and only one of it',
        Number((await queryOne<{ n: number }>(
          `SELECT COUNT(*) AS n FROM alerts WHERE rule_key = 'month_not_closed'`))?.n), 1);
    } else {
      check('before the 7th it stays quiet', !companyAlert, 'nothing yet, as intended');
      eq('and the run reports nothing opened', lifecycle.opened, 0);
    }

    console.log('\n— what the employee sees —');
    await runAlerts({ family: 'pattern', only: ['late_pattern'] });
    const forSelf = (await listAlerts({ employeeId, states: ['open'] }))
      .find(a => a.rule_key === 'late_pattern');
    const self = forSelf ? selfPhrasing(forSelf) : null;
    check('it is re-worded in the second person',
      Boolean(self?.title.startsWith('You have')), self?.title ?? 'none');
    check('the admin wording is not what they see',
      self?.title !== forSelf?.title);
    eq('and a live rule has no self wording at all',
      selfPhrasing({ ...forSelf!, rule_key: 'not_clocked_in' }), null);

    console.log('\n— through the API —');
    const res = await alertsGet(new NextRequest('http://localhost:3000/api/alerts', {
      headers: { Cookie: `access_token=${admin.token}` },
    }));
    eq('an admin may read the queue', res.status, 200);
    const body = await res.json();
    check('with the catalogue beside it', Array.isArray(body.data.rules) && body.data.rules.length > 0);
    check('and a manage flag', body.data.can_manage === true);
    check('our fixture is in it',
      body.data.alerts.some((a: { emp_id: string | null }) => a.emp_id === 'ZZAL001'));

    const anon = await alertsGet(new NextRequest('http://localhost:3000/api/alerts'));
    eq('no token, no queue', anon.status, 401);

    const ackRes = await alertsPost(new NextRequest('http://localhost:3000/api/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `access_token=${admin.token}` },
      body: JSON.stringify({ action: 'acknowledge', id: forSelf!.id, note: 'via the api' }),
    }));
    eq('acknowledging over HTTP works', ackRes.status, 200);
    eq('and it took',
      (await listAlerts({ employeeId, states: ['acknowledged'] })).some(a => a.id === forSelf!.id), true);

    const badRes = await alertsPost(new NextRequest('http://localhost:3000/api/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `access_token=${admin.token}` },
      body: JSON.stringify({ action: 'snooze', id: forSelf!.id, until: 'tomorrow' }),
    }));
    eq('a malformed date is a 400, not a 500', badRes.status, 400);

    console.log('\n— the digest —');
    eq('off unless ALERT_DIGEST says otherwise', digestEnabled(),
      (process.env.ALERT_DIGEST ?? '').toLowerCase() === 'on');
    const digest = await sendAlertDigest('ZZAL-test-period');
    if (!digestEnabled()) {
      eq('it sends nothing while off', digest.sent, 0);
      eq('and reports that it is off', digest.enabled, false);
    } else {
      check('it reports what it did', typeof digest.sent === 'number');
    }
  } finally {
    await cleanup();
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });

/**
 * scripts/verify-chat-policy-tools.ts — can the assistant see the new features?
 *
 *   npx tsx --env-file=.env.local scripts/verify-chat-policy-tools.ts
 *
 * Policies, performance scoring and document compliance were built after the
 * chat layer, and nothing connected them. A model with no tool for a question
 * does not say "I have no data source for that" — it answers from the nearest
 * thing it does have, which is how a confident wrong answer gets made. So the
 * first thing checked is simply that the tools are registered and callable.
 *
 * The rest guards the one mistake that matters most here: reporting a figure
 * that was never measured as a zero. Somebody on a flexible shift who arrives
 * at 1pm every day has null lateness, and "0 late days" reads as a clean
 * record — the opposite of the truth.
 *
 * Read-only apart from the fixture it creates and removes (prefix ZZCP).
 */

import { TOOLS, dispatch } from '../lib/chat/registry';
import { SYSTEM_PROMPT } from '../lib/chat/prompt';
import { createPolicy, assignPolicy } from '../lib/policy';
import { query, queryOne, pool } from '../lib/db';
import type { ChatContext } from '../lib/chat/types';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

interface Rows { count: number; rows: Array<Record<string, unknown>>; notes?: string[] }

async function cleanup() {
  await query(
    `DELETE ep FROM employee_policies ep JOIN employees e ON e.id = ep.employee_id
      WHERE e.emp_id LIKE 'ZZCP%'`);
  await query(
    `DELETE es FROM employee_schedules es JOIN employees e ON e.id = es.employee_id
      WHERE e.emp_id LIKE 'ZZCP%'`);
  await query(`DELETE FROM employees WHERE emp_id LIKE 'ZZCP%'`);
  await query(`DELETE FROM policies WHERE code LIKE 'ZZCP-%'`);
  await query(`DELETE FROM shifts WHERE name LIKE 'ZZcp_%'`);
}

async function main() {
  try {
    await cleanup();

    const admin = await queryOne<{ id: number }>(
      `SELECT id FROM employees WHERE role = 'super_admin' AND is_active = 1 LIMIT 1`);
    const ctx: ChatContext = { employeeId: admin!.id, role: 'super_admin' };
    const empCtx: ChatContext = { employeeId: admin!.id, role: 'employee' };

    console.log('\n— the tools exist at all —');
    const names = new Set(TOOLS.map(t => t.name));
    for (const n of ['list_policies', 'get_employee_policy', 'get_performance_scores', 'get_document_compliance']) {
      check(`${n} is registered`, names.has(n));
    }
    check('every tool has a description the model can choose from',
      TOOLS.every(t => t.description.length > 40));
    check('and strict-mode schemas list every property as required',
      TOOLS.every(t => {
        const props = Object.keys(t.parameters.properties ?? {});
        const req = (t.parameters.required ?? []) as string[];
        return props.length === req.length;
      }));

    console.log('\n— the prompt tells the model these exist —');
    for (const phrase of ['list_policies', 'get_performance_scores', 'get_document_compliance']) {
      check(`the prompt mentions ${phrase}`, SYSTEM_PROMPT.includes(phrase));
    }
    check('and warns that most of a policy changes no figure',
      /reference data|changes no figure/i.test(SYSTEM_PROMPT));
    check('and that a policy default shift is not what decides the roster',
      /default shift is a reference|schedule decides/i.test(SYSTEM_PROMPT));

    console.log('\n— a fixture whose lateness cannot be measured —');
    const flexShift = ((await query(
      `INSERT INTO shifts (name, type, start_time, end_time, required_hours, grace_minutes, working_days)
       VALUES ('ZZcp_flex', 'flexible', '09:00:00', '18:00:00', 9, 10,
               '["Mon","Tue","Wed","Thu","Fri","Sat"]')`,
    )) as unknown as { insertId: number }).insertId;
    const fixedShift = ((await query(
      `INSERT INTO shifts (name, type, start_time, end_time, required_hours, grace_minutes, working_days)
       VALUES ('ZZcp_fixed', 'fixed', '09:00:00', '18:00:00', NULL, 10,
               '["Mon","Tue","Wed","Thu","Fri","Sat"]')`,
    )) as unknown as { insertId: number }).insertId;

    const empId = ((await query(
      `INSERT INTO employees (emp_id, name, pin_hash, role, is_active)
       VALUES ('ZZCP1', 'ZZ Chat Policy', 'x', 'employee', 1)`,
    )) as unknown as { insertId: number }).insertId;
    await query(
      `INSERT INTO employee_schedules (employee_id, shift_id, effective_from)
       VALUES (?, ?, '2019-01-01')`, [empId, flexShift]);

    // The policy names the FIXED shift while the roster says flexible — the
    // disagreement the assistant has to be able to explain.
    const pol = await createPolicy(
      { name: 'ZZ Chat Policy', code: 'ZZCP-A', monthly_hours: 225,
        default_shift_id: fixedShift, pf_applicable: true } as never,
      admin!.id,
    );
    await assignPolicy({
      employeeId: empId, policyId: pol.id, effectiveFrom: '2026-01-01', by: admin!.id,
    });

    console.log('\n— list_policies —');
    const list = await dispatch(ctx, 'list_policies', {}) as Rows;
    check('it returns policies', list.count > 0, `${list.count}`);
    const mine = list.rows.find(r => r.code === 'ZZCP-A');
    check('including the one just created', Boolean(mine));
    eq('with its monthly hours', Number(mine?.monthly_hours), 225);
    check('and its statutory flags', Array.isArray(mine?.statutory) && (mine!.statutory as string[]).includes('PF'));
    check('and it warns which fields actually change a figure',
      (list.notes ?? []).some(n => /changes no figure|recorded for reference/i.test(n)),
      (list.notes ?? []).join(' | ').slice(0, 90));
    check('and it says leave balances do NOT come from the policy',
      (list.notes ?? []).some(n => /Leave Quotas/i.test(n)));

    console.log('\n— get_employee_policy —');
    const one = await dispatch(ctx, 'get_employee_policy', { employee_id: empId }) as Rows;
    check('it finds the assignment', one.count > 0, `${one.count}`);
    const cur = one.rows.find(r => r.is_current === true);
    eq('and names the policy', cur?.policy_code, 'ZZCP-A');
    eq('it reports the shift actually rostered', cur?.actual_shift_name, 'ZZcp_flex');
    eq('beside the one the policy names', cur?.default_shift_name, 'ZZcp_fixed');
    eq('and flags that the two disagree', cur?.shift_matches_policy, false);
    check('with a note explaining which one decides',
      (one.notes ?? []).some(n => /schedule decides/i.test(n)),
      (one.notes ?? []).join(' | ').slice(0, 100));

    console.log('\n— get_performance_scores: null is NOT zero —');
    const perf = await dispatch(ctx, 'get_performance_scores',
      { preset: null, from_date: '2026-09-01', to_date: '2026-09-30', policy_id: null }) as Rows;
    check('it returns scores', perf.count > 0, `${perf.count}`);
    const flexRow = perf.rows.find(r => r.employee_id === empId);
    if (flexRow) {
      eq('punctuality is null, not 0, for a flexible shift', flexRow.punctuality, null);
      eq('and late_days is null, not 0', flexRow.late_days, null);
    }
    check('a note spells out that null means not measured',
      (perf.notes ?? []).some(n => /NOT MEASURED/i.test(n)),
      (perf.notes ?? []).join(' | ').slice(0, 110));
    check('and forbids reporting it as zero',
      (perf.notes ?? []).some(n => /never report that as zero/i.test(n)));

    console.log('\n— get_document_compliance —');
    const docs = await dispatch(ctx, 'get_document_compliance', { only_incomplete: null }) as Rows;
    check('it returns employees', docs.count > 0, `${docs.count}`);
    check('each row says what is missing',
      docs.rows.every(r => Array.isArray(r.missing)));
    const onlyBad = await dispatch(ctx, 'get_document_compliance', { only_incomplete: true }) as Rows;
    check('filtering to incomplete returns no complete rows',
      onlyBad.rows.every(r => r.complete === false),
      `${onlyBad.count} incomplete`);

    console.log('\n— they are super-admin only, like every other tool —');
    for (const n of ['list_policies', 'get_employee_policy', 'get_performance_scores', 'get_document_compliance']) {
      const refused = await dispatch(empCtx, n, { employee_id: empId, only_incomplete: null })
        .then(() => false).catch(() => true);
      check(`${n} refuses a non-admin`, refused);
    }

    console.log('\n— an unknown tool is a hard error, not a guess —');
    const bogus = await dispatch(ctx, 'get_salary', {}).then(() => false).catch(() => true);
    check('the model cannot invent a data source', bogus);

    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    await cleanup();
  }
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });

/**
 * scripts/verify-policies.ts — policies, assignment, and the invariant.
 *
 *   npx tsx --env-file=.env.local scripts/verify-policies.ts
 *
 * The invariant is the point of the whole phase: a policy can exist and be
 * assigned to somebody, and their figures must be byte-identical to before.
 * Nothing reads policy yet — that is phase B — and this proves the foundation
 * was laid without disturbing anything underneath it.
 *
 * Builds its own fixture and removes it, including on failure.
 */

import { NextRequest } from 'next/server';
import { GET as listPoliciesRoute, POST as createRoute, PolicySchema } from '../app/api/policies/route';
import { PATCH as patchRoute, DELETE as deactivateRoute } from '../app/api/policies/[id]/route';
import {
  GET as assignListRoute, POST as assignRoute, DELETE as endRoute,
} from '../app/api/policies/assign/route';
import { resolvePolicyFor, resolvePoliciesFor, listAssignments } from '../lib/policy';
import { buildHoursLedger } from '../lib/hoursLedger';
import { signAccessToken, currentTokenVersion } from '../lib/auth';
import { query, queryOne, pool } from '../lib/db';
import { POLICY_FIELD_LABELS, POLICY_FIELD_HELP } from '../lib/policyFields';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

// Not the repo's usual '__' fixture prefix: a policy code is a user-facing
// handle and the schema rightly refuses a leading underscore.
const CODE_A = 'ZZTEST-POL-A';
const CODE_B = 'ZZTEST-POL-B';

async function tok(role: string) {
  const e = await queryOne<{ id: number; emp_id: string; role: string }>(
    `SELECT id, emp_id, role FROM employees WHERE role = ? AND is_active = 1 LIMIT 1`, [role],
  );
  if (!e) return null;
  const tv = await currentTokenVersion(e.id);
  return { id: e.id, token: signAccessToken({ id: e.id, emp_id: e.emp_id, role: e.role, tv } as never) };
}

const req = (body: unknown, token: string, method = 'POST', path = '/api/policies') =>
  new NextRequest(`http://localhost:3000${path}`, {
    method, headers: { 'Content-Type': 'application/json', Cookie: `access_token=${token}` },
    body: JSON.stringify(body),
  });

async function cleanup() {
  await query(
    `DELETE ep FROM employee_policies ep JOIN policies p ON p.id = ep.policy_id WHERE p.code LIKE 'ZZTEST-POL%'`,
  );
  await query(`DELETE FROM policies WHERE code LIKE 'ZZTEST-POL%'`);
}

async function main() {
  try {
    const db = process.env.DB_NAME ?? '';
    if (/prod/i.test(db) || db === 'attendance_db') {
      console.log(`REFUSED: DB_NAME is "${db}" — this script writes.`);
      failed += 1;
      return;
    }
    await cleanup();

    const admin = await tok('super_admin');
    if (!admin) { check('a super_admin exists', false); return; }
    const emp = await tok('employee');

    const subject = await queryOne<{ id: number; name: string }>(
      `SELECT e.id, e.name FROM employees e
        WHERE e.is_active = 1 AND e.role = 'employee'
          AND EXISTS (SELECT 1 FROM employee_schedules es WHERE es.employee_id = e.id)
        ORDER BY (SELECT COUNT(*) FROM attendance a WHERE a.employee_id = e.id AND a.total_minutes > 0) DESC
        LIMIT 1`,
    );
    if (!subject) { check('a rostered employee exists', false); return; }

    // ---- THE INVARIANT: capture the figures BEFORE any policy exists -------
    const before = (await buildHoursLedger({
      employeeId: subject.id, fromDate: '2026-09-01', toDate: '2026-09-30',
    }))!;

    console.log('\n— authority —');
    eq('an employee cannot create a policy',
      emp ? (await createRoute(req({ name: 'x', code: 'xx' }, emp.token))).status : 403, 403);
    eq('an unauthenticated caller cannot list them',
      (await listPoliciesRoute(new NextRequest('http://localhost:3000/api/policies'))).status, 401);

    console.log('\n— creating —');
    const created = await createRoute(req({
      name: 'Test Staff 225', code: CODE_A,
      description: 'Verification fixture',
      monthly_hours: 225, week_offs_per_month: 4,
      pf_applicable: true, esi_applicable: true, professional_tax_applicable: true,
      casual_leave_days: 12, sick_leave_days: 12,
    }, admin.token));
    eq('a policy is created', created.status, 201);
    const policyA = (await created.json()).data.policy as { id: number; hours_basis: string; monthly_hours: number };
    eq('hours_basis defaults to roster', policyA.hours_basis, 'roster');
    eq('monthly hours are stored', Number(policyA.monthly_hours), 225);

    console.log('\n— what the schema refuses —');

    // The form sends '' for an untouched box and used to convert EVERY blank
    // to null, including these two. The API then answered 'expected string,
    // received null' - a message about a type, naming no field, for what is
    // simply a box somebody left empty. Both halves are tested: the blank is
    // refused, and the refusal says which field and why.
    for (const [what, body, field] of [
      ['an empty name', { name: '', code: 'ZZTEST-POL-X' }, 'Name'],
      ['an empty code', { name: 'Nameless', code: '' }, 'Code'],
      ['a null name', { name: null, code: 'ZZTEST-POL-X' }, 'Name'],
    ] as const) {
      const res = await createRoute(req(body, admin.token));
      eq(`${what} is refused`, res.status, 400);
      const msg = String(((await res.json()) as { error?: string }).error ?? '');
      check(`and the message names the field (${field})`, msg.startsWith(field), msg);
      check('and does not leak the raw type error', !msg.includes('received null'), msg);
    }

    // Several blanks at once: filling one must not merely reveal the next.
    {
      const res = await createRoute(req({ name: '', code: '' }, admin.token));
      const msg = String(((await res.json()) as { error?: string }).error ?? '');
      check('both missing fields are reported together', msg.includes('Name') && msg.includes('Code'), msg);
    }

    // A label for every field the schema can reject, or an error can still
    // come back naming a raw column.
    {
      const keys = Object.keys(PolicySchema.shape);
      const unlabelled = keys.filter(k => !POLICY_FIELD_LABELS[k]);
      check('every policy field has a human label', unlabelled.length === 0, unlabelled.join(', '));
      const unexplained = keys.filter(k => !POLICY_FIELD_HELP[k] && k !== 'is_active' && k !== 'hours_basis');
      check('and help text explaining it', unexplained.length === 0, unexplained.join(', '));
    }
    eq('a duplicate code is refused',
      (await createRoute(req({ name: 'Another', code: CODE_A }, admin.token))).status, 400);
    eq('a code with spaces is refused',
      (await createRoute(req({ name: 'x', code: 'bad code' }, admin.token))).status, 400);
    const fixedNoHours = await createRoute(req({
      name: 'Fixed no hours', code: 'ZZTEST-POL-X', hours_basis: 'fixed_monthly',
    }, admin.token));
    eq('fixed_monthly without monthly hours is refused', fixedNoHours.status, 400);
    check('…and says why',
      /that figure IS the requirement/i.test(((await fixedNoHours.json()) as { error: string }).error));
    // There is no half-day flow in this business, so the API does not accept
    // half-day thresholds at all. Sending them must not quietly configure a
    // rule the app would never apply — the columns stay dormant in the schema
    // so introducing the concept later needs no migration.
    const halfDay = await createRoute(req({
      name: 'Half day attempt', code: 'ZZTEST-POL-Y',
      min_hours_full_day: 8, min_hours_half_day: 4,
    }, admin.token));
    eq('a policy sent half-day thresholds is still created', halfDay.status, 201);
    const hdId = ((await halfDay.json()).data as { policy: { id: number } }).policy.id;
    const hdRow = await queryOne<{ full: number | null; half: number | null }>(
      `SELECT min_hours_full_day AS full, min_hours_half_day AS half FROM policies WHERE id = ?`,
      [hdId],
    );
    eq('…but the full-day threshold was NOT stored', hdRow?.full, null);
    eq('…nor the half-day one', hdRow?.half, null);
    eq('all-zero score weights are refused',
      (await createRoute(req({
        name: 'No weights', code: 'ZZTEST-POL-Z',
        score_weight_attendance: 0, score_weight_punctuality: 0, score_weight_hours: 0,
      }, admin.token))).status, 400);

    console.log('\n— assigning —');
    const assigned = await assignRoute(req({
      employee_ids: [subject.id], policy_id: policyA.id, effective_from: '2026-01-01',
    }, admin.token, 'POST', '/api/policies/assign'));
    eq('assignment succeeds', assigned.status, 200);
    const aBody = (await assigned.json()).data as { assigned: number[]; skipped: unknown[] };
    eq('the employee is assigned', aBody.assigned.length, 1);

    const resolved = await resolvePolicyFor(subject.id, '2026-09-15');
    check('the policy resolves for a date inside the assignment', resolved?.id === policyA.id);
    eq('…and does NOT resolve before it began', await resolvePolicyFor(subject.id, '2025-12-31'), null);

    const unassignedPeer = await queryOne<{ id: number }>(
      `SELECT id FROM employees WHERE id <> ? AND is_active = 1 LIMIT 1`, [subject.id],
    );
    if (unassignedPeer) {
      eq('an employee with no policy resolves to null — the whole invariant',
        await resolvePolicyFor(unassignedPeer.id, '2026-09-15'), null);
    }

    console.log('\n— THE INVARIANT: assignment changes no figure —');
    const after = (await buildHoursLedger({
      employeeId: subject.id, fromDate: '2026-09-01', toDate: '2026-09-30',
    }))!;
    eq('required minutes unchanged', after.totals.required_minutes, before.totals.required_minutes);
    eq('worked minutes unchanged', after.totals.worked_minutes, before.totals.worked_minutes);
    eq('net minutes unchanged', after.totals.net_minutes, before.totals.net_minutes);
    eq('the stated standard is still the global one', after.standard.stated_minutes, before.standard.stated_minutes);
    // Phase B wired the policy in, so the ledger now REPORTS which rule set
    // applied. That is the one intended difference: every figure above is
    // unchanged, and the only new content is the policy block itself.
    eq('the ledger now names the policy that applied', after.assigned_policy?.code, CODE_A);
    eq('…and it was null before one was assigned', before.assigned_policy, null);
    check('nothing else about the ledger moved',
      JSON.stringify({ ...after, assigned_policy: null, warnings: [] })
        === JSON.stringify({ ...before, assigned_policy: null, warnings: [] }),
      'a roster policy states a norm; it does not change what the roster asks');

    console.log('\n— reassignment keeps history —');
    const second = await createRoute(req({
      name: 'Test Field', code: CODE_B, monthly_hours: 208,
    }, admin.token));
    const policyB = (await second.json()).data.policy as { id: number };
    await assignRoute(req({
      employee_ids: [subject.id], policy_id: policyB.id, effective_from: '2026-06-01',
    }, admin.token, 'POST', '/api/policies/assign'));

    const history = await listAssignments({ employeeId: subject.id });
    eq('there are now two assignments on record', history.length, 2);
    const oldOne = history.find(h => h.policy_id === policyA.id)!;
    eq('the first was closed the day before the second began', oldOne.effective_to, '2026-05-31');
    check('the second is open-ended',
      history.find(h => h.policy_id === policyB.id)?.effective_to === null);

    const inMay = await resolvePolicyFor(subject.id, '2026-05-15');
    const inJuly = await resolvePolicyFor(subject.id, '2026-07-15');
    eq('May still resolves to the FIRST policy', inMay?.id, policyA.id);
    eq('July resolves to the second', inJuly?.id, policyB.id);
    check('a month already paid for keeps the rules it was computed under',
      inMay?.id !== inJuly?.id);

    eq('assigning the same policy twice is refused',
      ((await (await assignRoute(req({
        employee_ids: [subject.id], policy_id: policyB.id, effective_from: '2026-08-01',
      }, admin.token, 'POST', '/api/policies/assign'))).json()).data as { skipped: unknown[] }).skipped.length, 1);

    // Reassigning on the SAME date used to leave two assignments open at once,
    // because the closing clause only caught assignments starting strictly
    // earlier. resolvePolicyFor then returned the newest while the hours ledger
    // returned the oldest — the same employee on two policies depending on
    // which code asked.
    console.log('\n— same-day reassignment leaves exactly one in force —');
    const sameDayPolicy = (await (await createRoute(req({
      name: 'Same day', code: 'ZZTEST-POL-S',
    }, admin.token))).json()).data.policy as { id: number };
    await assignRoute(req({
      employee_ids: [subject.id], policy_id: policyA.id, effective_from: '2026-03-01',
    }, admin.token, 'POST', '/api/policies/assign'));
    await assignRoute(req({
      employee_ids: [subject.id], policy_id: sameDayPolicy.id, effective_from: '2026-03-01',
    }, admin.token, 'POST', '/api/policies/assign'));

    const covering = (await listAssignments({ employeeId: subject.id }))
      .filter(a => a.effective_from <= '2026-03-15'
        && (a.effective_to === null || a.effective_to >= '2026-03-15'));
    eq('exactly one assignment covers that date', covering.length, 1);
    eq('…and it is the one assigned last', covering[0]?.policy_id, sameDayPolicy.id);
    eq('the resolver agrees',
      (await resolvePolicyFor(subject.id, '2026-03-15'))?.id, sameDayPolicy.id);
    check('no assignment has an inverted date range',
      (await listAssignments({ employeeId: subject.id }))
        .every(a => a.effective_to === null || a.effective_to >= a.effective_from),
      'closing a same-day assignment would otherwise end it before it began');

    console.log('\n— bulk —');
    const peers = await query<{ id: number }>(
      `SELECT id FROM employees WHERE is_active = 1 AND id <> ? LIMIT 3`, [subject.id],
    );
    if (peers.length >= 2) {
      const bulk = await assignRoute(req({
        employee_ids: peers.map(p => p.id), policy_id: policyA.id, effective_from: '2026-02-01',
      }, admin.token, 'POST', '/api/policies/assign'));
      const bBody = (await bulk.json()).data as { assigned: number[]; skipped: unknown[] };
      eq('every employee in the batch is assigned', bBody.assigned.length, peers.length);
      const map = await resolvePoliciesFor(peers.map(p => p.id), '2026-09-15');
      eq('and all resolve to it', map.size, peers.length);
      // Each entry must key to its OWN employee: the batch resolver selects
      // p.* , so ep.employee_id has to be added explicitly or every row keys to
      // NaN and the map silently collapses to one entry.
      check('each entry is keyed to the right employee',
        peers.every(pr => map.get(pr.id)?.id === policyA.id),
        [...map.keys()].join(', '));
    }

    console.log('\n— deactivating —');
    const stillOn = await deactivateRoute(
      req({}, admin.token, 'DELETE', `/api/policies/${policyA.id}`),
      { params: Promise.resolve({ id: String(policyA.id) }) },
    );
    eq('a policy with people on it cannot be deactivated', stillOn.status, 409);
    check('…and says how many',
      /employee\(s\) are still on/i.test(((await stillOn.json()) as { error: string }).error));

    // Clear everybody off policy A, then it may be retired.
    await query(
      `UPDATE employee_policies SET effective_to = '2026-12-31'
        WHERE policy_id = ? AND effective_to IS NULL`, [policyA.id],
    );
    const retired = await deactivateRoute(
      req({}, admin.token, 'DELETE', `/api/policies/${policyA.id}`),
      { params: Promise.resolve({ id: String(policyA.id) }) },
    );
    eq('once nobody is on it, it deactivates', retired.status, 200);
    const rows = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM policies WHERE id = ?`, [policyA.id]);
    eq('deactivating never deletes — the history stays explainable', Number(rows[0].n), 1);

    console.log('\n— editing —');
    const patched = await patchRoute(
      req({ monthly_hours: 240, pf_applicable: false }, admin.token, 'PATCH', `/api/policies/${policyB.id}`),
      { params: Promise.resolve({ id: String(policyB.id) }) },
    );
    eq('a policy can be edited', patched.status, 200);
    const edited = (await patched.json()).data.policy as { monthly_hours: number; pf_applicable: boolean };
    eq('the change took', Number(edited.monthly_hours), 240);
    eq('and a checkbox can be turned off', edited.pf_applicable, false);

    console.log('\n— ending an assignment —');
    const ended = await endRoute(req(
      { employee_id: subject.id, effective_to: '2026-11-30' }, admin.token, 'DELETE', '/api/policies/assign',
    ));
    eq('an assignment can be ended', ended.status, 200);
    eq('after which the employee resolves to no policy again',
      await resolvePolicyFor(subject.id, '2026-12-15'), null);
    eq('ending it twice is refused',
      (await endRoute(req(
        { employee_id: subject.id, effective_to: '2026-11-30' }, admin.token, 'DELETE', '/api/policies/assign',
      ))).status, 400);

    console.log('\n— listing —');
    const listed = await assignListRoute(new NextRequest(
      `http://localhost:3000/api/policies/assign?employee_id=${subject.id}`,
      { headers: { Cookie: `access_token=${admin.token}` } },
    ));
    eq('assignments list', listed.status, 200);
    const audits = await query<{ action: string }>(
      `SELECT action FROM audit_log
        WHERE action IN ('policy_created','policy_updated','policy_assigned','policy_unassigned')
        ORDER BY id DESC LIMIT 8`,
    );
    check('every policy action is audited',
      ['policy_created', 'policy_assigned', 'policy_unassigned'].every(a => audits.some(x => x.action === a)),
      [...new Set(audits.map(a => a.action))].join(', '));
  } finally {
    await cleanup();
    const left = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM policies WHERE code LIKE 'ZZTEST-POL%'`,
    );
    check('fixture cleaned up', Number(left?.n ?? 0) === 0, `${left?.n} left`);
    console.log(`\n${passed} passed, ${failed} failed`);
  }
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });

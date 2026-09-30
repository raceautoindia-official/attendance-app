/**
 * scripts/verify-chat-tools.ts — smoke-test the chat data layer.
 *
 * Exercises every registry tool against the real database WITHOUT calling any
 * model, so the data path can be verified on its own. Also checks the two
 * invariants that matter most: strict-mode schema compliance, and that no tool
 * can return a PII column.
 *
 * Run:  npx tsx --env-file=.env.local scripts/verify-chat-tools.ts
 */

import { TOOLS, dispatch, openAiTools } from '../lib/chat/registry';
import { resolveRange, istToday } from '../lib/chat/dates';
import { SAFE_EMPLOYEE_COLUMNS, type ChatContext } from '../lib/chat/types';
import { pool } from '../lib/db';

/** Columns that must never appear in any tool output. */
const FORBIDDEN = [
  'bank_account_number',
  'bank_account_name',
  'bank_ifsc',
  'bank_name',
  'pan_number',
  'aadhaar_number',
  'pin_hash',
];

const SUPER_ADMIN: ChatContext = { employeeId: 1, role: 'super_admin' };
const EMPLOYEE: ChatContext = { employeeId: 3, role: 'employee' };

let pass = 0;
let fail = 0;

function ok(label: string, detail = '') {
  pass += 1;
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}

function bad(label: string, detail: string) {
  fail += 1;
  console.log(`  FAIL  ${label} — ${detail}`);
}

/** Every property must be in `required` and additionalProperties must be false. */
function checkStrictSchema(name: string, params: Record<string, unknown>) {
  const props = Object.keys((params.properties ?? {}) as object);
  const required = (params.required ?? []) as string[];
  if (params.additionalProperties !== false) {
    return bad(`schema ${name}`, 'additionalProperties is not false');
  }
  const missing = props.filter(p => !required.includes(p));
  if (missing.length > 0) {
    return bad(`schema ${name}`, `not in required: ${missing.join(', ')}`);
  }
  ok(`schema ${name}`, `${props.length} props, strict-compliant`);
}

async function main() {
  console.log(`\nIST today: ${istToday()}`);

  console.log('\n— date resolution —');
  for (const preset of ['today', 'this_month', 'last_month', 'last_7_days', 'this_year'] as const) {
    const r = resolveRange({ preset });
    if (r.from > r.to) bad(`preset ${preset}`, `from ${r.from} > to ${r.to}`);
    else ok(`preset ${preset}`, `${r.from}..${r.to} "${r.label}"`);
  }
  try {
    resolveRange({ preset: 'custom' });
    bad('preset custom without dates', 'should have thrown');
  } catch {
    ok('preset custom without dates', 'throws as expected');
  }
  // Reversed bounds must be normalised, not queried backwards.
  const rev = resolveRange({ from_date: '2026-07-31', to_date: '2026-05-01' });
  if (rev.from === '2026-05-01' && rev.to === '2026-07-31') {
    ok('reversed bounds normalised', `${rev.from}..${rev.to}`);
  } else {
    bad('reversed bounds', `${rev.from}..${rev.to}`);
  }

  console.log('\n— strict-mode schemas —');
  for (const t of TOOLS) checkStrictSchema(t.name, t.parameters);
  const defs = openAiTools();
  if (defs.every(d => d.function.strict === true)) {
    ok('all tools strict: true', `${defs.length} tools`);
  } else {
    bad('strict flag', 'some tool is not strict');
  }

  console.log('\n— role enforcement —');
  try {
    await dispatch(EMPLOYEE, 'get_attendance_summary', {});
    bad('employee role blocked', 'a non-super_admin got data');
  } catch (err) {
    ok('employee role blocked', (err as Error).name);
  }
  try {
    await dispatch(SUPER_ADMIN, 'definitely_not_a_tool', {});
    bad('unknown tool rejected', 'should have thrown');
  } catch {
    ok('unknown tool rejected', 'throws as expected');
  }

  console.log('\n— live tool calls —');
  const range = { preset: null, from_date: '2026-05-01', to_date: '2026-07-31' };
  const calls: Array<[string, Record<string, unknown>]> = [
    ['list_departments', {}],
    ['resolve_employee', { search: 'Arun', include_inactive: null }],
    ['get_attendance_summary', { ...range, employee_ids: null, department: null }],
    ['get_daily_snapshot', { date: '2026-07-01', department: null }],
    ['get_late_arrivals', { ...range, employee_ids: null, department: null }],
    ['get_absentees', { ...range, employee_ids: null, department: null }],
    ['get_department_rollup', range],
    ['get_geofence_exceptions', { ...range, employee_ids: null, department: null }],
    ['get_leave_records', { ...range, employee_ids: null, department: null, leave_type: null }],
    ['get_holidays', range],
    ['get_shifts', {}],
    ['get_schedule', { employee_id: 1 }],
    ['get_live_tracking_status', {}],
    ['get_audit_trail', { ...range, entity: null, performed_by: null }],
    ['get_employee_profile', { employee_id: 1 }],
    // Migration-dependent — expected to fail on a pre-migration database.
    ['get_attendance_detail', { employee_id: 1, ...range }],
    ['get_leave_balance', { employee_id: 1, year: 2026 }],
  ];

  const payloads: string[] = [];

  for (const [name, args] of calls) {
    try {
      const res = await dispatch(SUPER_ADMIN, name, args);
      const json = JSON.stringify(res);
      payloads.push(json);
      const r = res as { count?: number; range?: { label?: string } };
      ok(name, `count=${r.count ?? '?'}${r.range?.label ? ` period="${r.range.label}"` : ''}`);
    } catch (err) {
      const msg = (err as Error).message;
      // A missing migration column is a known environment gap, not a code bug.
      if (/Unknown column|doesn't exist/i.test(msg)) {
        console.log(`  SKIP  ${name} — needs a pending migration (${msg.slice(0, 60)})`);
      } else {
        bad(name, msg);
      }
    }
  }

  // Regression guard: escapeLike() must neutralise LIKE wildcards. A bare '%'
  // search once slipped through as a pattern; if escaping breaks again this
  // returns every employee instead of none.
  console.log('\n— LIKE wildcard escaping —');
  // "a%" escaped matches the literal text a% (nobody). Unescaped it would
  // expand to %a%% and match every name containing an "a".
  const wild = (await dispatch(SUPER_ADMIN, 'resolve_employee', {
    search: 'a%',
    include_inactive: null,
  })) as { count: number };
  if (wild.count === 0) {
    ok('"a%" matches nothing', 'wildcard escaped');
  } else {
    bad('"a%" search', `matched ${wild.count} employees — wildcard not escaped`);
  }

  const wildUnderscore = (await dispatch(SUPER_ADMIN, 'resolve_employee', {
    search: 'a_u',
    include_inactive: null,
  })) as { count: number };
  if (wildUnderscore.count === 0) {
    ok('"a_u" treated literally', 'underscore escaped');
  } else {
    bad('"a_u" search', `matched ${wildUnderscore.count} — underscore not escaped`);
  }

  console.log('\n— PII containment —');
  const combined = payloads.join('\n').toLowerCase();
  const leaked = FORBIDDEN.filter(c => combined.includes(c));
  if (leaked.length === 0) {
    ok('no PII column in any tool output', `${FORBIDDEN.length} columns checked`);
  } else {
    bad('PII leak', `found: ${leaked.join(', ')}`);
  }

  const overlap = SAFE_EMPLOYEE_COLUMNS.filter(c => FORBIDDEN.includes(c));
  if (overlap.length === 0) {
    ok('allowlist excludes every PII column');
  } else {
    bad('allowlist', `contains ${overlap.join(', ')}`);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async err => {
  console.error('\nverification crashed:', err);
  await pool.end();
  process.exit(1);
});

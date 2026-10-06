/**
 * scripts/verify-chat-fixes.ts — a regression case per reported assistant defect.
 *
 *   npx tsx --env-file=.env.local scripts/verify-chat-fixes.ts
 *
 * Read-only apart from one temporary employee used to prove the fuzzy name
 * matcher, which is removed again including on failure.
 *
 * Each block names the complaint it answers, so a future change that quietly
 * reintroduces one of these fails loudly instead of being rediscovered by a
 * user months later.
 */

import { resolveEmployee } from '../lib/chat/tools/employees';
import { getAttendanceDetail } from '../lib/chat/tools/attendance';
import { getHoursLedger } from '../lib/chat/tools/hours';
import { createReportDownload, REPORTS } from '../lib/chat/export';
import { TOOLS } from '../lib/chat/registry';
import { SYSTEM_PROMPT } from '../lib/chat/prompt';
import type { ChatContext } from '../lib/chat/types';
import { query, queryOne, pool } from '../lib/db';

const CTX: ChatContext = { employeeId: 1, role: 'super_admin' };

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

async function main() {
  let tempId: number | null = null;
  try {
    const subject = await queryOne<{ id: number; name: string }>(
      `SELECT e.id, e.name FROM employees e
        WHERE EXISTS (SELECT 1 FROM attendance a WHERE a.employee_id = e.id)
        ORDER BY (SELECT COUNT(*) FROM attendance a WHERE a.employee_id = e.id) DESC
        LIMIT 1`,
    );
    if (!subject) { check('an employee with attendance exists', false); return; }
    console.log(`  (subject: ${subject.name}, id ${subject.id})`);

    // ---------------------------------------------------------------------
    console.log('\n— defect 1: "average working day of X" was refused —');
    // The prompt forbids arithmetic and no tool produced an average, so the
    // model correctly said the figure was unavailable. The tool now supplies it.
    const led = await getHoursLedger(CTX, {
      employee_id: subject.id, preset: 'last_month', include_days: false,
    });
    const r = led.rows[0];
    check('the ledger tool returns a row', Boolean(r));
    check('average working day is supplied, pre-formatted',
      typeof r.totals.average_per_worked_day_display === 'string'
      && r.totals.average_per_worked_day_display.length > 0,
      r.totals.average_per_worked_day_display);
    check('shortest and longest day are supplied',
      'shortest_day' in r.totals && 'longest_day' in r.totals,
      `${r.totals.shortest_day} / ${r.totals.longest_day}`);
    check('required, worked and the gap all arrive as quotable strings',
      [r.totals.required_display, r.totals.worked_display, r.totals.net_display]
        .every(v => typeof v === 'string' && /h \d+m$/.test(v)),
      `${r.totals.required_display} | ${r.totals.worked_display} | ${r.totals.net_display}`);
    check('the month verdict says short/ahead in words',
      /SHORT|AHEAD|on target/.test(r.totals.month_verdict), r.totals.month_verdict);
    check('the requirement explains itself',
      r.requirement.explanation.length > 20, r.requirement.explanation.slice(0, 70));
    check('the prompt points at the tool instead of refusing',
      SYSTEM_PROMPT.includes('get_hours_ledger'));

    // ---------------------------------------------------------------------
    console.log('\n— defect 2: a misspelled name returned nothing —');
    const real = await queryOne<{ id: number; name: string }>(
      `SELECT id, name FROM employees WHERE is_active = 1 AND CHAR_LENGTH(name) > 5 ORDER BY id LIMIT 1`,
    );
    if (real) {
      const first = real.name.split(/\s+/)[0];
      // Transpose two letters in the middle — the commonest kind of typo.
      const typo = first.length > 3
        ? first.slice(0, 2) + first[3] + first[2] + first.slice(4)
        : first + 'x';
      const fuzzy = await resolveEmployee(CTX, { search: typo });
      check(`"${typo}" (typo of "${first}") returns suggestions, not nothing`,
        fuzzy.count > 0, `${fuzzy.count} candidate(s)`);
      check('suggestions are flagged as guesses, not matches',
        fuzzy.rows.every(x => x.suggestion === true));
      check('the real employee is among them',
        fuzzy.rows.some(x => x.id === real.id),
        fuzzy.rows.map(x => x.name).join(', '));
      check('a note tells the model to ask before reporting',
        (fuzzy.notes ?? []).some(n => /did you mean|closest|Ask /i.test(n)),
        (fuzzy.notes ?? []).join(' | '));
      check('the prompt describes the suggestion flag',
        SYSTEM_PROMPT.includes('suggestion: true'));

      // An exact match must NOT be downgraded to a suggestion.
      const exact = await resolveEmployee(CTX, { search: first });
      check('an exact match is still a match, not a suggestion',
        exact.count > 0 && exact.rows.every(x => !x.suggestion),
        `${exact.count} match(es)`);
    }

    // Pure nonsense must still return nothing — a fuzzy matcher that always
    // finds somebody is worse than one that finds nobody.
    const nonsense = await resolveEmployee(CTX, { search: 'zzqxwvk' });
    eq('pure nonsense still returns no candidates', nonsense.count, 0);
    check('…and says not to guess',
      (nonsense.notes ?? []).some(n => /do not guess/i.test(n)),
      (nonsense.notes ?? []).join(' | '));

    // ---------------------------------------------------------------------
    console.log('\n— defect 3: "0 records" could not be told from "no such person" —');
    const ghost = await getAttendanceDetail(CTX, { employee_id: 99_999_999, preset: 'last_month' });
    eq('an unknown id returns no rows', ghost.count, 0);
    check('…and says the employee does not exist',
      (ghost.notes ?? []).some(n => /no employee with id/i.test(n)),
      (ghost.notes ?? []).join(' | '));

    // A real employee, in a period they certainly have no data for.
    const empty = await getAttendanceDetail(CTX, {
      employee_id: subject.id, from_date: '2019-01-01', to_date: '2019-01-31',
    });
    eq('a real employee in an empty period returns no rows', empty.count, 0);
    check('…and reports the period they DO have data for',
      (empty.notes ?? []).some(n => /records run from/i.test(n)),
      (empty.notes ?? []).join(' | '));
    check('…and warns against reporting it as zero hours',
      (empty.notes ?? []).some(n => /not report it as zero/i.test(n)));

    // ---------------------------------------------------------------------
    console.log('\n— defect 4: one person\'s export returned the whole company —');
    const tool = TOOLS.find(t => t.name === 'create_report_download')!;
    const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
    const required = (tool.parameters as { required: string[] }).required;
    check('the schema now exposes employee_ids', 'employee_ids' in props);
    check('…and strict mode lists it as required', required.includes('employee_ids'));

    const scoped = await createReportDownload(CTX, {
      report: 'attendance_summary', format: 'csv',
      employee_ids: [subject.id], preset: 'last_month',
    });
    if (scoped.count > 0) {
      check('a scoped export names who it covers',
        scoped.rows[0].report_label.includes(subject.name),
        scoped.rows[0].report_label);
    } else {
      console.log('  (no data last month for the subject — label check skipped)');
    }

    // The exact shape of the original bug: the singular id passed to a
    // multi-employee report. It used to be read by nothing.
    const singular = await createReportDownload(CTX, {
      report: 'attendance_summary', format: 'csv',
      employee_id: subject.id, preset: 'last_month',
    });
    if (singular.count > 0) {
      check('a singular employee_id is honoured, not ignored',
        singular.rows[0].report_label.includes(subject.name),
        singular.rows[0].report_label);
      const all = await createReportDownload(CTX, {
        report: 'attendance_summary', format: 'csv', preset: 'last_month',
      });
      check('…and the scoped file is smaller than the unscoped one',
        singular.rows[0].rows < all.rows[0].rows,
        `${singular.rows[0].rows} row(s) scoped vs ${all.rows[0].rows} unscoped`);
    } else {
      console.log('  (no data last month — scoping size check skipped)');
    }

    // A scope that cannot be honoured must be refused, never silently dropped.
    let refused = false;
    try {
      await createReportDownload(CTX, {
        report: 'department_rollup', format: 'csv',
        employee_ids: [subject.id], preset: 'last_month',
      });
    } catch (e) {
      refused = /cannot be narrowed/i.test((e as Error).message);
    }
    check('a scope the report cannot honour is refused, not ignored', refused);

    check('every scopable report is marked as such',
      ['attendance_summary', 'late_arrivals', 'absentees', 'geofence_exceptions', 'leave_records']
        .every(k => REPORTS[k].scopable === true));
    check('reports covering a fixed population are NOT marked scopable',
      !REPORTS.department_rollup.scopable && !REPORTS.daily_snapshot.scopable);
    check('the prompt tells the model to scope the file',
      SYSTEM_PROMPT.includes('employee_ids'));

    // ---------------------------------------------------------------------
    console.log('\n— the fuzzy matcher must not leak contact details —');
    const ins = (await query(
      `INSERT INTO employees (emp_id, name, email, phone, pin_hash, role, is_active)
       VALUES ('__FZ1', 'Zyxwvut Qponml', 'leak@example.com', '9999999999', 'x', 'employee', 1)`,
    )) as unknown as { insertId: number };
    tempId = ins.insertId;
    const leaky = await resolveEmployee(CTX, { search: 'Zyxwvur' });
    check('the typo finds the temporary employee', leaky.rows.some(x => x.id === tempId));
    const serialised = JSON.stringify(leaky);
    check('no email in the result', !serialised.includes('leak@example.com'));
    check('no phone in the result', !serialised.includes('9999999999'));
  } finally {
    if (tempId) await query(`DELETE FROM employees WHERE id = ?`, [tempId]);
    const left = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM employees WHERE emp_id = '__FZ1'`,
    );
    check('temporary employee cleaned up', Number(left?.n ?? 0) === 0);
    console.log(`\n${passed} passed, ${failed} failed`);
  }
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });

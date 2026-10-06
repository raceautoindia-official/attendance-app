/**
 * scripts/test-chat-fixes-live.ts — the four reported defects, against the real model.
 *
 *   npx tsx --env-file=.env.local scripts/test-chat-fixes-live.ts [model]
 *
 * SPENDS REAL MONEY: one API call per case.
 *
 * verify-chat-fixes.ts proves the TOOLS behave. This proves the MODEL does —
 * that it reaches for the right tool, scopes the file, and asks before guessing
 * at a name. A tool can be perfect and still never be called.
 *
 * Each case is worded the way the defect was originally reported.
 */

import { runChat } from '../lib/chat/openai';
import type { ChatContext } from '../lib/chat/types';
import { queryOne, pool } from '../lib/db';

const CTX: ChatContext = { employeeId: 1, role: 'super_admin' };

let passed = 0;
let failed = 0;

/** Models write typographic punctuation; normalise before matching. */
const norm = (s: string) =>
  s.replace(/[‘’‛ʼ]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').toLowerCase();

function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
  if (detail && ok) console.log(`        ${detail}`);
}

async function main() {
  const model = process.argv[2];

  const subject = await queryOne<{ id: number; name: string }>(
    `SELECT e.id, e.name FROM employees e
      WHERE e.is_active = 1
        AND (SELECT COUNT(*) FROM attendance a WHERE a.employee_id = e.id AND a.total_minutes > 0) > 10
      ORDER BY (SELECT COUNT(*) FROM attendance a WHERE a.employee_id = e.id) DESC LIMIT 1`,
  );
  if (!subject) { console.log('No suitable employee with attendance.'); return; }
  const first = subject.name.split(/\s+/)[0];
  // Double a letter — a typo that substring matching cannot survive.
  const typo = first.slice(0, 2) + first[1] + first.slice(2);
  console.log(`\nSubject: ${subject.name} (id ${subject.id}); typo used: "${typo}"\n`);

  const ask = async (q: string) => {
    const r = await runChat(CTX, q, [], model ? { model } : {});
    return { answer: r.answer, tools: r.traces.map(t => t.name), traces: r.traces };
  };

  // -- defect 1 ------------------------------------------------------------
  console.log(`— "what is ${first}'s average working day last month?" —`);
  {
    const r = await ask(`What is ${first}'s average working day last month?`);
    check('did not refuse for want of a calculation',
      !/not available|cannot calculate|can't calculate|don't have|do not have/.test(norm(r.answer)),
      r.answer.replace(/\s+/g, ' ').slice(0, 160));
    check('used the hours ledger', r.tools.includes('get_hours_ledger'), r.tools.join(', '));
    check('quoted an hours-and-minutes figure', /\d+\s*h/i.test(r.answer));
  }

  // -- defect 2 ------------------------------------------------------------
  console.log(`\n— "show me ${typo}'s record" (misspelled) —`);
  {
    const r = await ask(`Show me ${typo}'s attendance record for last month.`);
    const n = norm(r.answer);
    check('offered the right person instead of denying they exist',
      n.includes(norm(first)) || n.includes(norm(subject.name)),
      r.answer.replace(/\s+/g, ' ').slice(0, 160));
    check('did not flatly say no such employee',
      !/no employee (named|by that name|with that name) .{0,40}(was )?found/.test(n)
      || n.includes('did you mean') || n.includes(norm(first)));
    check('called resolve_employee', r.tools.includes('resolve_employee'), r.tools.join(', '));
  }

  // -- defect 3 ------------------------------------------------------------
  console.log(`\n— "${first}'s report" with no period given —`);
  {
    const r = await ask(`Give me ${first}'s attendance report.`);
    check('did not report an empty month as zero work',
      !/0 (hours|days worked)|no records found/.test(norm(r.answer))
      || /records run|period|month/.test(norm(r.answer)),
      r.answer.replace(/\s+/g, ' ').slice(0, 160));
    check('stated which period it used', /\b(2026|september|october|last month|this month)\b/i.test(r.answer));
  }

  // -- defect 4 ------------------------------------------------------------
  console.log(`\n— "export ${first}'s September to Excel" (the whole-company bug) —`);
  {
    const r = await ask(`Export ${first}'s September 2026 attendance summary to Excel.`);
    const dl = r.traces.find(t => t.name === 'create_report_download');
    check('built a file', Boolean(dl), r.tools.join(', '));
    if (dl) {
      const args = (dl.args ?? {}) as { employee_ids?: number[]; employee_id?: number; report?: string };
      const scoped =
        (Array.isArray(args.employee_ids) && args.employee_ids.includes(subject.id))
        || args.employee_id === subject.id;
      check('scoped the file to that one person, not the whole company',
        scoped, JSON.stringify(args));
      check('the file covers exactly one employee', dl.rows === 1, `${dl.rows} row(s) in the file`);
    }
    check('told the user who the file covers',
      norm(r.answer).includes(norm(first)),
      r.answer.replace(/\s+/g, ' ').slice(0, 160));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });

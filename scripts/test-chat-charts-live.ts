/**
 * scripts/test-chat-charts-live.ts — charts, against the real model.
 *
 *   npx tsx --env-file=.env.local scripts/test-chat-charts-live.ts [model]
 *
 * SPENDS REAL MONEY: one API call per case.
 *
 * verify-charts.ts proves the spec boundary holds. This proves the model
 * reaches for it, picks a sensible form, and — the part that actually matters —
 * charts numbers it READ rather than numbers it made up.
 */

import { runChat } from '../lib/chat/openai';
import { validateChartSpec, type ChartSpec } from '../lib/charts/types';
import type { ChatContext } from '../lib/chat/types';
import { query, pool } from '../lib/db';

const CTX: ChatContext = { employeeId: 1, role: 'super_admin' };

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** Pull the chart spec out of a build_chart trace. */
function chartFrom(traces: Array<{ name: string; args?: unknown }>): ChartSpec | null {
  const t = traces.find(x => x.name === 'build_chart');
  if (!t) return null;
  const v = validateChartSpec(t.args);
  return 'spec' in v ? v.spec : null;
}

async function main() {
  const model = process.argv[2];
  const people = await query<{ id: number; name: string }>(
    `SELECT e.id, e.name FROM employees e
      WHERE e.is_active = 1
        AND (SELECT COUNT(*) FROM attendance a
              WHERE a.employee_id = e.id AND a.total_minutes > 0
                AND a.work_date BETWEEN '2026-09-01' AND '2026-09-30') > 10
      ORDER BY e.name LIMIT 3`,
  );
  if (people.length < 3) { console.log('Need three employees with September data.'); return; }
  const names = people.map(p => p.name.split(/\s+/)[0]);
  console.log(`\nUsing: ${names.join(', ')}\n`);

  const ask = async (q: string) => {
    const r = await runChat(CTX, q, [], model ? { model } : {});
    return { answer: r.answer, tools: r.traces.map(t => t.name), traces: r.traces };
  };

  // -- the exact request from the brief ------------------------------------
  console.log(`— "pie chart of hours worked by ${names.join(', ')} in September" —`);
  {
    const r = await ask(
      `Show me a pie chart of the hours worked by ${names.join(', ')} in September 2026.`,
    );
    check('called build_chart', r.tools.includes('build_chart'), r.tools.join(', '));
    const spec = chartFrom(r.traces);
    check('the spec it produced is valid', Boolean(spec));
    if (spec) {
      check('it is a pie', spec.type === 'pie', spec.type);
      check('one series of parts', spec.series.length === 1, `${spec.series.length}`);
      check('a slice per person asked about',
        spec.series[0].points.length === 3, `${spec.series[0].points.length} slices`);
      check('the slices are the right people',
        names.every(n => spec.series[0].points.some(p => p.label.toLowerCase().includes(n.toLowerCase()))),
        spec.series[0].points.map(p => p.label).join(', '));
      check('values are durations, not invented percentages',
        spec.unit === 'minutes' || spec.unit === 'hours', spec.unit);
      check('every slice has a positive value',
        spec.series[0].points.every(p => p.value > 0),
        spec.series[0].points.map(p => `${p.label}=${p.value}`).join(' '));

      // The real test: the charted numbers must match the database.
      const real = await query<{ id: number; mins: number }>(
        `SELECT employee_id AS id, COALESCE(SUM(total_minutes), 0) AS mins
           FROM attendance
          WHERE employee_id IN (${people.map(() => '?').join(',')})
            AND work_date BETWEEN '2026-09-01' AND '2026-09-30'
          GROUP BY employee_id`,
        people.map(p => p.id),
      );
      let matched = 0;
      for (const person of people) {
        const actualMin = Number(real.find(x => x.id === person.id)?.mins ?? 0);
        const slice = spec.series[0].points.find(
          p => p.label.toLowerCase().includes(person.name.split(/\s+/)[0].toLowerCase()),
        );
        if (!slice) continue;
        const charted = spec.unit === 'hours' ? slice.value * 60 : slice.value;
        // Within a minute of rounding, or within an hour if it charted hours.
        if (Math.abs(charted - actualMin) <= (spec.unit === 'hours' ? 31 : 1)) matched += 1;
      }
      check('the charted values match the database', matched === people.length,
        `${matched} of ${people.length} within rounding`);
    }
    check('described the chart in words too', r.answer.length > 40,
      r.answer.replace(/\s+/g, ' ').slice(0, 140));
  }

  // -- a trend, which should NOT be a pie ----------------------------------
  console.log('\n— "chart the daily hours trend for one person" —');
  {
    const r = await ask(`Chart ${names[0]}'s daily hours through September 2026.`);
    const spec = chartFrom(r.traces);
    check('called build_chart', Boolean(spec), r.tools.join(', '));
    if (spec) {
      check('chose a time-appropriate form, not a pie',
        spec.type === 'line' || spec.type === 'column', spec.type);
      check('has a point per day, not a handful',
        spec.series[0].points.length >= 10, `${spec.series[0].points.length} points`);
    }
  }

  // -- comparing people, where a bar beats a pie ---------------------------
  console.log('\n— "compare hours across the team" —');
  {
    const r = await ask('Compare total hours worked across all employees in September 2026 as a chart.');
    const spec = chartFrom(r.traces);
    check('called build_chart', Boolean(spec), r.tools.join(', '));
    if (spec) {
      check('chose a comparison form', ['bar', 'column'].includes(spec.type), spec.type);
      check('no more than eight series', spec.series.length <= 8, `${spec.series.length}`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
}

main()
  .catch(e => { console.error(e); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });

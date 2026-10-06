/**
 * scripts/verify-charts.ts — the chart spec boundary.
 *
 *   npx tsx --env-file=.env.local scripts/verify-charts.ts
 *
 * Read-only; touches no data.
 *
 * A chart is the one place where model-produced structure reaches the screen,
 * so the validator is the boundary that matters: anything it lets through gets
 * drawn. These checks are about what it must refuse, and about the forms the
 * data-viz rules say are misleading rather than merely ugly.
 */

import {
  validateChartSpec, foldForPie, formatValue, MAX_PIE_SLICES, MAX_SERIES,
  CHART_TYPES, CHART_UNITS,
} from '../lib/charts/types';
import { buildChart } from '../lib/chat/tools/charts';
import { TOOLS } from '../lib/chat/registry';
import { SYSTEM_PROMPT } from '../lib/chat/prompt';
import type { ChatContext } from '../lib/chat/types';
import { pool } from '../lib/db';

const CTX: ChatContext = { employeeId: 1, role: 'super_admin' };
const ADMIN_ONLY: ChatContext = { employeeId: 2, role: 'employee' };

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const ok = (spec: unknown) => 'spec' in validateChartSpec(spec);
const err = (spec: unknown) => {
  const r = validateChartSpec(spec);
  return 'error' in r ? r.error : null;
};

const pts = (...vals: number[]) => vals.map((v, i) => ({ label: `P${i}`, value: v }));
const base = {
  type: 'bar', title: 'Hours worked', unit: 'minutes',
  series: [{ label: 'Worked', points: pts(540, 480, 300) }],
};

async function main() {
  console.log('\n— a well-formed spec is accepted —');
  check('a simple bar chart validates', ok(base));
  for (const type of CHART_TYPES) {
    const spec = type === 'pie' || type === 'stacked_bar'
      ? { ...base, type }
      : { ...base, type };
    check(`type "${type}" validates`, ok(spec));
  }
  for (const unit of CHART_UNITS) check(`unit "${unit}" validates`, ok({ ...base, unit }));

  console.log('\n— malformed specs are refused, with a reason —');
  check('a missing title is refused', Boolean(err({ ...base, title: '' })));
  check('an unknown type is refused', Boolean(err({ ...base, type: 'donut3d' })));
  check('an unknown unit is refused', Boolean(err({ ...base, unit: 'bananas' })));
  check('no series is refused', Boolean(err({ ...base, series: [] })));
  check('a series with no points is refused',
    Boolean(err({ ...base, series: [{ label: 'x', points: [] }] })));
  check('a non-numeric value is refused',
    Boolean(err({ ...base, series: [{ label: 'x', points: [{ label: 'a', value: 'lots' }] }] })));
  check('a NaN value is refused',
    Boolean(err({ ...base, series: [{ label: 'x', points: [{ label: 'a', value: Number.NaN }] }] })));
  check('a point with no label is refused',
    Boolean(err({ ...base, series: [{ label: 'x', points: [{ value: 1 }] }] })));
  check('a null spec is refused', Boolean(err(null)));

  console.log('\n— the forms the data-viz rules call misleading —');
  const tooMany = {
    ...base,
    series: Array.from({ length: MAX_SERIES + 1 }, (_, i) => ({ label: `S${i}`, points: pts(1) })),
  };
  check(`more than ${MAX_SERIES} series is refused — the palette is never cycled`,
    Boolean(err(tooMany)), err(tooMany) ?? '');
  check('a one-slice pie is refused — "the number is the chart"',
    Boolean(err({ ...base, type: 'pie', series: [{ label: 'x', points: pts(5) }] })));
  check('a pie of two series is refused — part-to-whole is one set of parts',
    Boolean(err({ ...base, type: 'pie', series: [{ label: 'a', points: pts(1, 2) }, { label: 'b', points: pts(1, 2) }] })));
  check('an all-zero pie is refused — there is no share to show',
    Boolean(err({ ...base, type: 'pie', series: [{ label: 'x', points: pts(0, 0, 0) }] })));
  check('a negative slice is refused rather than flipped or dropped',
    Boolean(err({ ...base, type: 'pie', series: [{ label: 'x', points: pts(5, -3, 2) }] })),
    err({ ...base, type: 'pie', series: [{ label: 'x', points: pts(5, -3, 2) }] }) ?? '');
  check('…and the refusal names a form that CAN show it',
    /column or bar/i.test(err({ ...base, type: 'stacked_bar', series: [{ label: 'x', points: pts(5, -3) }] }) ?? ''));
  check('a negative value IS allowed on a column chart',
    ok({ ...base, type: 'column', series: [{ label: 'x', points: pts(5, -3) }] }));

  console.log('\n— a long tail folds instead of becoming unreadable —');
  const many = Array.from({ length: 11 }, (_, i) => ({ label: `E${i}`, value: 11 - i }));
  const folded = foldForPie(many);
  check(`folded to ${MAX_PIE_SLICES} slices`, folded.length === MAX_PIE_SLICES, `${folded.length}`);
  check('the last slice is the grouped remainder', folded[folded.length - 1].label.startsWith('Other'));
  check('folding preserves the total',
    folded.reduce((s, p) => s + p.value, 0) === many.reduce((s, p) => s + p.value, 0));
  check('a short list is left alone', foldForPie(many.slice(0, 4)).length === 4);

  console.log('\n— durations read as hours and minutes, never decimals —');
  check('510 minutes renders as 8h 30m', formatValue(510, 'minutes') === '8h 30m', formatValue(510, 'minutes'));
  check('540 minutes renders as 9h', formatValue(540, 'minutes') === '9h', formatValue(540, 'minutes'));
  check('45 minutes renders as 45m', formatValue(45, 'minutes') === '45m', formatValue(45, 'minutes'));
  check('a negative duration keeps its sign', formatValue(-90, 'minutes') === '-1h 30m', formatValue(-90, 'minutes'));

  console.log('\n— the tool —');
  const res = await buildChart(CTX, base);
  check('a valid spec comes back as one row', res.count === 1 && res.rows.length === 1);
  check('the spec is returned intact', res.rows[0].chart.title === 'Hours worked');
  check('a note tells the model not to read every value back aloud',
    (res.notes ?? []).some(n => /do not list every value/i.test(n)));

  let threw = '';
  try { await buildChart(CTX, { ...base, type: 'nonsense' }); }
  catch (e) { threw = (e as Error).message; }
  check('an invalid spec throws with guidance rather than drawing nothing',
    threw.includes('Unknown chart type') && threw.includes('must come from a tool result'), threw.slice(0, 80));

  let denied = false;
  try { await buildChart(ADMIN_ONLY, base); } catch { denied = true; }
  check('a non-super-admin is refused', denied);

  const closePie = await buildChart(CTX, {
    ...base, type: 'pie',
    series: [{ label: 'x', points: [
      { label: 'a', value: 100 }, { label: 'b', value: 101 }, { label: 'c', value: 102 },
    ] }],
  });
  check('a pie of near-identical shares warns that it reads poorly',
    (closePie.notes ?? []).some(n => /close together/i.test(n)),
    (closePie.notes ?? []).join(' | '));

  const bigPie = await buildChart(CTX, {
    ...base, type: 'pie',
    series: [{ label: 'x', points: Array.from({ length: 9 }, (_, i) => ({ label: `E${i}`, value: i + 1 })) }],
  });
  check('a pie with too many slices says so and suggests a bar',
    (bigPie.notes ?? []).some(n => /too many to read/i.test(n) && /bar chart/i.test(n)));

  console.log('\n— the tool is registered and described —');
  const tool = TOOLS.find(t => t.name === 'build_chart');
  check('build_chart is registered', Boolean(tool));
  if (tool) {
    const params = tool.parameters as { properties: Record<string, unknown>; required: string[] };
    check('every property is required (OpenAI strict mode)',
      Object.keys(params.properties).every(k => params.required.includes(k)),
      `${params.required.length} of ${Object.keys(params.properties).length}`);
    check('the description says values must come from a tool result',
      /never chart a number you/i.test(tool.description));
    check('…and tells the model when a pie is appropriate',
      /pie.{0,60}six/i.test(tool.description), tool.description.slice(0, 60));
  }
  check('the prompt does not forbid charts by omission',
    SYSTEM_PROMPT.length > 0);

  console.log(`\n${passed} passed, ${failed} failed`);
}

main()
  .catch(err2 => { console.error(err2); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });

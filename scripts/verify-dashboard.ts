/**
 * scripts/verify-dashboard.ts — the home dashboard.
 *
 *   npx tsx --env-file=.env.local scripts/verify-dashboard.ts
 *
 * A dashboard is read first and trusted most, so a wrong figure here outranks
 * the right figure on the page it links to. What is checked:
 *
 *   - every chart is a VALID spec, by the same validator the assistant's charts
 *     go through — one palette, one set of rules about what a chart may claim
 *   - a month in progress is compared against the part of it that has elapsed,
 *     not against the whole, or every month reads as a shortfall until the last
 *     day of it
 *   - a figure nobody could measure says so instead of showing zero
 *   - the queues only carry things that are actually waiting
 *   - the API refuses an employee, since this aggregates the whole company
 *
 * Read-only against the real database apart from the auth fixtures it needs.
 */

import { NextRequest } from 'next/server';
import { GET as dashboardRoute } from '../app/api/dashboard/route';
import { buildDashboard } from '../lib/dashboard';
import { validateChartSpec } from '../lib/charts/types';
import { signAccessToken, currentTokenVersion } from '../lib/auth';
import { queryOne, pool } from '../lib/db';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

async function tokenFor(role: 'super_admin' | 'employee'): Promise<string | null> {
  const e = await queryOne<{ id: number; emp_id: string; role: string }>(
    `SELECT id, emp_id, role FROM employees WHERE role = ? AND is_active = 1 LIMIT 1`, [role],
  );
  if (!e) return null;
  const tv = await currentTokenVersion(e.id);
  return signAccessToken({ id: e.id, emp_id: e.emp_id, role: e.role, tv } as never);
}

async function main() {
  try {
    const d = await buildDashboard({});

    console.log('\n— every chart is a spec the renderer will accept —');
    check('at least one chart is produced', d.charts.length > 0, `${d.charts.length} charts`);
    for (const spec of d.charts) {
      const v = validateChartSpec(spec);
      check(`"${spec.title}" is a valid spec`, !('error' in v), 'error' in v ? v.error : spec.type);
    }
    check('no chart carries more series than the palette has slots',
      d.charts.every(c => c.series.length <= 8),
      d.charts.map(c => `${c.title}:${c.series.length}`).join(', '));
    check('every chart point is a finite number',
      d.charts.every(c => c.series.every(se => se.points.every(p => Number.isFinite(p.value)))));
    check('and no value is negative, which no chart here can mean',
      d.charts.every(c => c.series.every(se => se.points.every(p => p.value >= 0))));

    console.log('\n— a month in progress is judged on the part that has happened —');
    const hoursKpi = d.kpis.find(k => k.key === 'hours_month')!;
    check('the hours figure exists', Boolean(hoursKpi));
    const inProgress = d.notes.some(n => /still running/i.test(n));
    if (inProgress) {
      check('the label says month to date', /month to date/i.test(hoursKpi.label), hoursKpi.label);
      check('and the comparison is to the hours due by now, not the whole month',
        /due by day/i.test(hoursKpi.hint), hoursKpi.hint);
      check('a note explains the scaling rather than leaving it to be inferred',
        d.notes.some(n => /not against the full month/i.test(n)));
    } else {
      check('a completed month compares against the full stated figure',
        /the month states/i.test(hoursKpi.hint), hoursKpi.hint);
    }

    console.log('\n— not measured is never shown as zero —');
    const lateKpi = d.kpis.find(k => k.key === 'late_days')!;
    check('the late figure declares whether it could be measured at all',
      typeof lateKpi.measured === 'boolean', String(lateKpi.measured));
    if (!lateKpi.measured) {
      check('and when it could not, it says so rather than reporting 0',
        /cannot be measured|nobody is on a shift/i.test(lateKpi.hint), lateKpi.hint);
    }
    check('every KPI carries a hint saying what the number means',
      d.kpis.every(k => k.hint.length > 0));

    console.log('\n— the queues only carry what is waiting —');
    check('no queue is listed with a count of zero',
      d.queues.every(q => q.count > 0),
      d.queues.map(q => `${q.key}:${q.count}`).join(', ') || 'none waiting');
    check('every queue links somewhere to act on it',
      d.queues.every(q => q.href.startsWith('/')));

    console.log('\n— today adds up —');
    check('clocked in never exceeds headcount',
      d.today.clocked_in <= d.today.headcount,
      `${d.today.clocked_in} of ${d.today.headcount}`);
    check('still working is a subset of those clocked in',
      d.today.still_working <= d.today.clocked_in,
      `${d.today.still_working} of ${d.today.clocked_in}`);
    check('nobody is counted as both absent and present',
      d.today.clocked_in + d.today.on_leave + d.today.not_in_yet <= d.today.headcount + d.today.on_leave,
      `${d.today.clocked_in}+${d.today.on_leave}+${d.today.not_in_yet} vs ${d.today.headcount}`);

    console.log('\n— who may read it —');
    const adminToken = await tokenFor('super_admin');
    const empToken = await tokenFor('employee');
    if (adminToken) {
      const res = await dashboardRoute(new NextRequest('http://localhost:3000/api/dashboard', {
        headers: { Cookie: `access_token=${adminToken}` },
      }));
      eq('an admin may read it', res.status, 200);
    }
    if (empToken) {
      const res = await dashboardRoute(new NextRequest('http://localhost:3000/api/dashboard', {
        headers: { Cookie: `access_token=${empToken}` },
      }));
      check('an employee may not — it aggregates the whole company',
        res.status === 401 || res.status === 403, `got ${res.status}`);
    }
    {
      const res = await dashboardRoute(new NextRequest('http://localhost:3000/api/dashboard?month=nonsense', {
        headers: { Cookie: `access_token=${adminToken}` },
      }));
      eq('a malformed month is refused', res.status, 400);
    }

    console.log('\n— a past month still works —');
    const past = await buildDashboard({ month: '2026-09' });
    eq('it reports the month asked for', past.month, '2026-09');
    check('and does not claim to be in progress',
      !past.notes.some(n => /still running/i.test(n)),
      past.notes.join(' | ').slice(0, 80) || 'no in-progress note');

    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    await pool.end();
  }
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(() => process.exit(failed === 0 ? 0 : 1));

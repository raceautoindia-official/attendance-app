/**
 * scripts/verify-hours-route.ts — route checks for /api/reports/hours-ledger.
 *
 *   npx tsx --env-file=.env.local scripts/verify-hours-route.ts
 *
 * verify-hours-ledger.ts proves the arithmetic against a fixture. This proves
 * the HTTP surface: the auth gate, the manager scoping, the month/range
 * parsing, and that the JSON the page consumes is actually the shape it
 * expects. Read-only — it writes nothing.
 */

import { NextRequest } from 'next/server';
import { GET } from '../app/api/reports/hours-ledger/route';
import { signAccessToken, currentTokenVersion } from '../lib/auth';
import { query, queryOne, pool } from '../lib/db';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (name: string, a: unknown, b: unknown) =>
  check(name, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

function req(qs: string, token?: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/reports/hours-ledger?${qs}`, {
    headers: token ? { Cookie: `access_token=${token}` } : {},
  });
}

async function tokenFor(role: string): Promise<{ id: number; token: string } | null> {
  const e = await queryOne<{ id: number; emp_id: string; role: string }>(
    `SELECT id, emp_id, role FROM employees WHERE role = ? AND is_active = 1 LIMIT 1`,
    [role],
  );
  if (!e) return null;
  const tv = await currentTokenVersion(e.id);
  return { id: e.id, token: signAccessToken({ id: e.id, emp_id: e.emp_id, role: e.role, tv } as never) };
}

async function main() {
  console.log('\n— auth gate —');
  eq('no cookie is rejected', (await GET(req('employee_id=1&month=2026-09'))).status, 401);

  const emp = await tokenFor('employee');
  if (emp) {
    eq('a plain employee is rejected', (await GET(req('employee_id=1&month=2026-09', emp.token))).status, 403);
  } else {
    check('a plain employee is rejected', false, 'no active employee to test with');
  }

  const admin = await tokenFor('super_admin');
  if (!admin) { check('a super_admin exists', false); return; }

  console.log('\n— input validation —');
  eq('missing employee_id', (await GET(req('month=2026-09', admin.token))).status, 400);
  eq('non-numeric employee_id', (await GET(req('employee_id=abc&month=2026-09', admin.token))).status, 400);
  eq('malformed month', (await GET(req('employee_id=1&month=2026-13', admin.token))).status, 400);
  eq('no period at all', (await GET(req('employee_id=1', admin.token))).status, 400);
  eq('period over 400 days is refused',
    (await GET(req('employee_id=1&from_date=2020-01-01&to_date=2026-01-01', admin.token))).status, 400);
  eq('unknown employee is 404',
    (await GET(req('employee_id=99999999&month=2026-09', admin.token))).status, 404);

  console.log('\n— month and range agree —');
  const subject = await queryOne<{ id: number; name: string }>(
    `SELECT e.id, e.name FROM employees e
      WHERE e.role = 'employee'
        AND EXISTS (SELECT 1 FROM employee_schedules es WHERE es.employee_id = e.id)
      ORDER BY (SELECT COUNT(*) FROM attendance a WHERE a.employee_id = e.id) DESC
      LIMIT 1`,
  );
  if (!subject) { check('a rostered employee exists to test with', false); return; }
  console.log(`  (using ${subject.name}, id ${subject.id})`);

  const byMonth = await GET(req(`employee_id=${subject.id}&month=2026-09`, admin.token));
  eq('month form returns 200', byMonth.status, 200);
  const m = (await byMonth.json()) as { success: boolean; data: Record<string, never> };
  check('payload is successful', m.success === true);

  const byRange = await GET(
    req(`employee_id=${subject.id}&from_date=2026-09-01&to_date=2026-09-30`, admin.token),
  );
  const r = (await byRange.json()) as { success: boolean; data: Record<string, never> };
  check('month=2026-09 and the equivalent range give identical results',
    JSON.stringify(m.data) === JSON.stringify(r.data));

  console.log('\n— the shape the page consumes —');
  const d = m.data as unknown as {
    employee: { id: number; name: string };
    period: { from_date: string; to_date: string; label: string };
    policy: Record<string, unknown>;
    standing: string;
    totals: Record<string, number | null | boolean | object>;
    standard: Record<string, number>;
    days: Array<Record<string, unknown>>;
    warnings: string[];
  };
  for (const key of ['employee', 'period', 'policy', 'standing', 'totals', 'standard', 'days', 'warnings']) {
    check(`payload has "${key}"`, key in d);
  }
  eq('period label reads as a month', d.period.label, 'September 2026');
  eq('days covers the whole month', d.days.length, 30);
  check('every day has a date, kind and shortage',
    d.days.every(x => typeof x.date === 'string' && typeof x.kind === 'string' && typeof x.shortage_minutes === 'number'));

  console.log('\n— invariants that must hold on real data —');
  const days = d.days as unknown as Array<{
    kind: string; shortage_minutes: number; required_minutes: number | null;
    credited_minutes: number; worked_minutes: number | null;
  }>;
  const t = d.totals as unknown as {
    required_minutes: number; shortage_minutes: number; credited_minutes: number;
    worked_minutes: number; days_short: number;
  };
  check('no non-working day carries a shortage',
    days.filter(x => x.kind !== 'working').every(x => x.shortage_minutes === 0));
  eq('day shortages sum to the total',
    days.reduce((s, x) => s + x.shortage_minutes, 0), t.shortage_minutes);
  eq('day requirements sum to the total',
    days.reduce((s, x) => s + (x.required_minutes ?? 0), 0), t.required_minutes);
  eq('days_short matches the days that are short',
    days.filter(x => x.shortage_minutes > 0).length, t.days_short);
  check('credited never exceeds required plus what was worked',
    t.credited_minutes <= t.worked_minutes + t.required_minutes);
  check('shortage is never negative', t.shortage_minutes >= 0);

  console.log('\n— manager scoping —');
  const mgr = await tokenFor('manager');
  if (mgr) {
    const reports = await query<{ id: number }>(
      `SELECT id FROM employees WHERE manager_id = ? LIMIT 1`, [mgr.id],
    );
    const outsider = await queryOne<{ id: number }>(
      `SELECT id FROM employees WHERE (manager_id IS NULL OR manager_id <> ?) AND id <> ? LIMIT 1`,
      [mgr.id, mgr.id],
    );
    if (outsider) {
      eq("a manager cannot read someone else's hours",
        (await GET(req(`employee_id=${outsider.id}&month=2026-09`, mgr.token))).status, 403);
    }
    if (reports.length) {
      eq('a manager can read their own report',
        (await GET(req(`employee_id=${reports[0].id}&month=2026-09`, mgr.token))).status, 200);
    } else {
      console.log('  (no employee has this manager assigned — scoping allow-path not exercised)');
    }
  } else {
    console.log('  (no manager role in this database — scoping not exercised)');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });

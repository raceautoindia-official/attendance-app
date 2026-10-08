/**
 * scripts/audit-routes.ts — does every route actually work?
 *
 *   npx tsx --env-file=.env.local scripts/audit-routes.ts
 *
 * The test suites prove specific behaviours. They cannot prove that a page
 * nobody wrote a test for still renders, or that an endpoint added months ago
 * has not been broken by a change to something it imports. `tsc` and `next
 * build` do not catch it either: both are satisfied by code that throws the
 * moment it reads from the database.
 *
 * So this walks the filesystem for every route the app actually serves, calls
 * each one as a signed-in super admin through the running dev server — proxy,
 * middleware, handler and all — and reports what came back.
 *
 * READ ONLY. Only GET is called. Nothing is created, updated or deleted, so it
 * is safe to run against a database with real data in it.
 *
 * Requires `npm run dev` to be running on localhost:3000.
 */

import { readdirSync, statSync, readFileSync } from 'fs';
import { join, sep } from 'path';
import { signAccessToken, currentTokenVersion } from '../lib/auth';
import { queryOne, pool } from '../lib/db';

const BASE = process.env.AUDIT_BASE ?? 'http://localhost:3000';
const APP = join(process.cwd(), 'app');

interface Result {
  kind: 'page' | 'api';
  route: string;
  status: number;
  ms: number;
  note: string;
}

/** Route groups like (admin) are organisational: they never appear in a URL. */
function toRoute(fsPath: string): string {
  const rel = fsPath.slice(APP.length).split(sep).slice(0, -1);
  const parts = rel.filter(p => p && !(p.startsWith('(') && p.endsWith(')')));
  return '/' + parts.join('/');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name === 'page.tsx' || name === 'route.ts') out.push(full);
  }
  return out;
}

async function main() {
  // Real ids, so a dynamic route is exercised against something that exists
  // rather than 404ing its way to a false pass.
  const emp = await queryOne<{ id: number }>(
    `SELECT id FROM employees WHERE is_active = 1 ORDER BY id LIMIT 1`);
  const loc = await queryOne<{ id: number }>(`SELECT id FROM locations ORDER BY id LIMIT 1`);
  const shift = await queryOne<{ id: number }>(`SELECT id FROM shifts ORDER BY id LIMIT 1`);
  const policy = await queryOne<{ id: number }>(`SELECT id FROM policies ORDER BY id LIMIT 1`);
  const doc = await queryOne<{ id: number }>(`SELECT id FROM employee_documents ORDER BY id LIMIT 1`);

  // Keyed by the segment name so [id] under /employees gets an employee id.
  const idFor = (route: string): string => {
    if (route.includes('/locations')) return String(loc?.id ?? 1);
    if (route.includes('/schedules')) return String(shift?.id ?? 1);
    if (route.includes('/policies')) return String(policy?.id ?? 1);
    return String(emp?.id ?? 1);
  };

  const admin = await queryOne<{ id: number; emp_id: string; role: string }>(
    `SELECT id, emp_id, role FROM employees WHERE role = 'super_admin' AND is_active = 1 LIMIT 1`);
  if (!admin) throw new Error('No active super_admin to sign in as.');
  const tv = await currentTokenVersion(admin.id);
  const token = signAccessToken({ id: admin.id, emp_id: admin.emp_id, role: admin.role, tv } as never);
  const cookie = `access_token=${token}`;

  const files = walk(APP);
  const pages: string[] = [];
  const apis: string[] = [];

  for (const f of files) {
    const route = toRoute(f);
    if (f.endsWith('page.tsx')) {
      pages.push(route);
    } else {
      // Only GET is safe to call, and only if the file actually exports one.
      const src = readFileSync(f, 'utf8');
      if (/export\s+async\s+function\s+GET/.test(src)) apis.push(route);
    }
  }

  const fill = (route: string) =>
    route.replace(/\[(\.\.\.)?([A-Za-z0-9_]+)\]/g, (_m, _spread, name) =>
      name.toLowerCase().includes('doc') ? String(doc?.id ?? 1) : idFor(route));

  const results: Result[] = [];

  async function hit(kind: 'page' | 'api', route: string) {
    const url = BASE + fill(route);
    const t0 = Date.now();
    try {
      const res = await fetch(url, { headers: { Cookie: cookie }, redirect: 'manual' });
      const ms = Date.now() - t0;
      let note = '';
      if (res.status >= 500) note = 'SERVER ERROR';
      else if (res.status === 401 || res.status === 403) note = 'auth refused (unexpected for an admin)';
      else if (res.status >= 300 && res.status < 400) note = `redirect -> ${res.headers.get('location') ?? '?'}`;
      else if (kind === 'api') {
        const body = await res.text();
        if (body.trim().startsWith('{')) {
          try {
            const json = JSON.parse(body) as { success?: boolean; error?: string };
            if (json.success === false) note = `success:false — ${String(json.error).slice(0, 70)}`;
          } catch { note = 'unparseable JSON'; }
        }
      }
      results.push({ kind, route, status: res.status, ms, note });
    } catch (err) {
      results.push({ kind, route, status: 0, ms: Date.now() - t0, note: `fetch failed: ${(err as Error).message}` });
    }
  }

  console.log(`Auditing ${pages.length} pages and ${apis.length} GET endpoints as super_admin…\n`);
  for (const r of pages.sort()) await hit('page', r);
  for (const r of apis.sort()) await hit('api', r);

  const bad = results.filter(r => r.status === 0 || r.status >= 500);
  const refused = results.filter(r => r.status === 401 || r.status === 403);
  const failing = results.filter(r => r.note.startsWith('success:false'));
  const slow = results.filter(r => r.ms > 3000);

  console.log('— pages —');
  for (const r of results.filter(x => x.kind === 'page')) {
    console.log(`  ${String(r.status).padStart(3)}  ${String(r.ms).padStart(5)}ms  ${r.route}${r.note ? `  [${r.note}]` : ''}`);
  }
  console.log('\n— GET endpoints —');
  for (const r of results.filter(x => x.kind === 'api')) {
    console.log(`  ${String(r.status).padStart(3)}  ${String(r.ms).padStart(5)}ms  ${r.route}${r.note ? `  [${r.note}]` : ''}`);
  }

  // ---- second pass -------------------------------------------------------
  // An endpoint that answers 'from_date is required' has NOT been exercised:
  // its validation ran and its body never did. These are the heavy ones - the
  // reports and exports - so calling them with real parameters is the only
  // part of this audit that reaches the code that does the actual work.
  const M = process.env.AUDIT_MONTH ?? '2026-09';
  const FROM = M + '-01';
  const TO = M + '-30';
  const E = emp?.id ?? 1;
  const deep: Array<[string, string]> = [
    ['exceptions', '/api/exceptions?month=' + M],
    ['daily report', '/api/reports/daily?from_date=' + FROM + '&to_date=' + TO],
    ['summary report', '/api/reports/summary?from_date=' + FROM + '&to_date=' + TO],
    ['summary xlsx', '/api/reports/summary-xlsx?from_date=' + FROM + '&to_date=' + TO],
    ['csv export', '/api/reports/csv?from_date=' + FROM + '&to_date=' + TO],
    ['pdf export', '/api/reports/pdf?from_date=' + FROM + '&to_date=' + TO],
    ['hours ledger', '/api/reports/hours-ledger?employee_id=' + E + '&from_date=' + FROM + '&to_date=' + TO],
    ['hours trend', '/api/reports/hours-trend?employee_id=' + E + '&month=' + M],
    ['payroll pack', '/api/reports/payroll-pack?month=' + M],
    ['performance', '/api/reports/performance?month=' + M],
    ['document compliance', '/api/reports/documents'],
    ['dashboard', '/api/dashboard?month=' + M],
  ];

  console.log('\n— with real parameters (' + M + ') —');
  const deepBad: string[] = [];
  for (const [name, url] of deep) {
    const t0 = Date.now();
    try {
      const res = await fetch(BASE + url, { headers: { Cookie: cookie } });
      const ms = Date.now() - t0;
      const ct = res.headers.get('content-type') ?? '';
      let detail = '';
      if (ct.includes('application/json')) {
        const j = await res.json() as { success?: boolean; error?: string };
        if (j.success === false) { detail = 'success:false — ' + j.error; deepBad.push(name + ': ' + j.error); }
        else detail = 'ok';
      } else {
        // A file export: the proof it worked is that bytes came back.
        const buf = await res.arrayBuffer();
        detail = ct.split(';')[0] + ' ' + buf.byteLength + ' bytes';
        if (buf.byteLength === 0) deepBad.push(name + ': empty file');
      }
      if (res.status >= 500) deepBad.push(name + ': HTTP ' + res.status);
      console.log('  ' + String(res.status).padStart(3) + '  ' + String(ms).padStart(5) + 'ms  ' + name.padEnd(20) + ' ' + detail);
    } catch (err) {
      console.log('    0      -  ' + name.padEnd(20) + ' fetch failed: ' + (err as Error).message);
      deepBad.push(name + ': fetch failed');
    }
  }

  console.log('\n================ SUMMARY ================');
  console.log(`routes checked        ${results.length}`);
  console.log(`server errors (5xx)   ${bad.length}`);
  console.log(`auth refused          ${refused.length}`);
  console.log(`handled errors        ${failing.length}`);
  console.log(`slower than 3s        ${slow.length}`);
  console.log(`parameterised failures ${deepBad.length}`);
  if (deepBad.length) { console.log('\nPARAMETERISED FAILURES:'); for (const b of deepBad) console.log('  ' + b); }
  if (bad.length) {
    console.log('\nSERVER ERRORS:');
    for (const r of bad) console.log(`  ${r.route} — ${r.status} ${r.note}`);
  }
  if (refused.length) {
    console.log('\nREFUSED FOR AN ADMIN:');
    for (const r of refused) console.log(`  ${r.route} — ${r.status}`);
  }
  if (failing.length) {
    console.log('\nRETURNED success:false:');
    for (const r of failing) console.log(`  ${r.route} — ${r.note}`);
  }
  if (slow.length) {
    console.log('\nSLOW:');
    for (const r of slow) console.log(`  ${r.route} — ${r.ms}ms`);
  }

  await pool.end();
  process.exit(bad.length === 0 ? 0 : 1);
}

main().catch(async err => { console.error(err); await pool.end(); process.exit(1); });

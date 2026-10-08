/**
 * scripts/verify-document-compliance.ts — who owes which papers.
 *
 *   npx tsx --env-file=.env.local scripts/verify-document-compliance.ts
 *
 * The requirements are DERIVED from each employee's policy rather than
 * configured, so the thing to prove is that the derivation is right and that it
 * never invents an obligation: somebody on no policy must be asked for proof of
 * identity and nothing else.
 *
 * Builds its own fixture and removes it, including on failure.
 */

import { NextRequest } from 'next/server';
import { GET as reportRoute } from '../app/api/reports/documents/route';
import { buildComplianceReport, requirementsFor } from '../lib/documentCompliance';
import { createPolicy, assignPolicy, getPolicy } from '../lib/policy';
import { signAccessToken, currentTokenVersion } from '../lib/auth';
import { query, queryOne, pool } from '../lib/db';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

interface Fixture { noPolicy: number; withPf: number; filed: number; policyId: number }

async function seed(adminId: number): Promise<Fixture> {
  const add = async (empId: string, name: string) => ((await query(
    `INSERT INTO employees (emp_id, name, pin_hash, role, is_active) VALUES (?, ?, 'x', 'employee', 1)`,
    [empId, name],
  )) as unknown as { insertId: number }).insertId;

  const noPolicy = await add('ZZDC1', 'ZZ No Policy');
  const withPf = await add('ZZDC2', 'ZZ With PF');
  const filed = await add('ZZDC3', 'ZZ Already Filed');

  const policy = await createPolicy({
    name: 'ZZ Compliance', code: 'ZZCOMP-1',
    pf_applicable: true, esi_applicable: true, income_tax_tds_applicable: true,
  }, adminId);

  for (const id of [withPf, filed]) {
    await assignPolicy({
      employeeId: id, policyId: policy.id, effectiveFrom: '2019-01-01', by: adminId,
    });
  }

  // The third employee has filed everything the policy asks for.
  for (const t of ['aadhaar_card', 'pan_card', 'bank_proof']) {
    await query(
      `INSERT INTO employee_documents
         (employee_id, doc_type, title, file_name, mime_type, size_bytes, file_data, uploaded_by)
       VALUES (?, ?, ?, 'a.png', 'image/png', 70, ?, ?)`,
      [filed, t, t, PNG, adminId],
    );
  }
  return { noPolicy, withPf, filed, policyId: policy.id };
}

async function cleanup(f: Fixture | null) {
  if (!f) return;
  const ids = [f.noPolicy, f.withPf, f.filed].filter(Boolean);
  if (ids.length) {
    const list = ids.map(() => '?').join(',');
    await query(`DELETE FROM employee_documents WHERE employee_id IN (${list})`, ids);
    await query(`DELETE FROM employee_policies WHERE employee_id IN (${list})`, ids);
    await query(`DELETE FROM employees WHERE id IN (${list})`, ids);
  }
  await query(`DELETE FROM policies WHERE code LIKE 'ZZCOMP%'`);
}

async function main() {
  let f: Fixture | null = null;
  try {
    const db = process.env.DB_NAME ?? '';
    if (/prod/i.test(db) || db === 'attendance_db') {
      console.log(`REFUSED: DB_NAME is "${db}" — this script writes.`);
      failed += 1;
      return;
    }
    await query(`DELETE FROM policies WHERE code LIKE 'ZZCOMP%'`);

    const admin = await queryOne<{ id: number; emp_id: string; role: string }>(
      `SELECT id, emp_id, role FROM employees WHERE role = 'super_admin' AND is_active = 1 LIMIT 1`,
    );
    if (!admin) { check('a super_admin exists', false); return; }
    f = await seed(admin.id);

    console.log('\n— no policy means no invented obligations —');
    const bare = requirementsFor(null);
    eq('exactly one requirement', bare.length, 1);
    eq('…and it is proof of identity', bare[0].key, 'identity');
    check('any identity document satisfies it, not Aadhaar specifically',
      bare[0].satisfiedBy.length > 1 && bare[0].satisfiedBy.includes('passport'),
      bare[0].satisfiedBy.join(', '));

    console.log('\n— the statutory flags decide the rest —');
    const policy = (await getPolicy(f.policyId))!;
    const reqs = requirementsFor(policy);
    const keys = reqs.map(r => r.key);
    check('PAN is required', keys.includes('pan'));
    check('Aadhaar is required', keys.includes('aadhaar'));
    check('a bank proof is required', keys.includes('bank'));
    check('every requirement says WHY it applies',
      reqs.every(r => r.reason.length > 10),
      reqs.map(r => r.reason).join(' | ').slice(0, 110));
    check('…naming the policy that produced it',
      reqs.some(r => r.reason.includes('ZZ Compliance')),
      reqs.find(r => r.reason.includes('ZZ Compliance'))?.reason ?? '');
    const offer = reqs.find(r => r.key === 'offer')!;
    eq('the offer letter is recommended, not required', offer.required, false);

    console.log('\n— a policy with no statutory flags asks for little —');
    const plain = await createPolicy({ name: 'ZZ Plain', code: 'ZZCOMP-2' }, admin.id);
    const plainReqs = requirementsFor((await getPolicy(plain.id))!);
    check('no PAN, no Aadhaar, no bank proof',
      !plainReqs.some(r => ['pan', 'aadhaar', 'bank'].includes(r.key)),
      plainReqs.map(r => r.key).join(', '));

    console.log('\n— the report —');
    const report = await buildComplianceReport();
    const noPol = report.employees.find(c => c.employee.emp_id === 'ZZDC1')!;
    const pf = report.employees.find(c => c.employee.emp_id === 'ZZDC2')!;
    const done = report.employees.find(c => c.employee.emp_id === 'ZZDC3')!;

    eq('the employee on no policy owes only identity',
      noPol.missing.filter(m => m.required).map(m => m.key).join(','), 'identity');
    eq('the PF employee owes four things',
      pf.missing.filter(m => m.required).length, 4);
    check('…identity, PAN, Aadhaar and a bank proof',
      ['identity', 'pan', 'aadhaar', 'bank'].every(k =>
        pf.missing.some(m => m.key === k)),
      pf.missing.map(m => m.key).join(', '));

    check('the employee who filed everything is complete', done.complete,
      `missing: ${done.missing.map(m => m.key).join(', ') || 'nothing required'}`);
    check('…even though the optional offer letter is absent',
      done.missing.some(m => m.key === 'offer' && !m.required),
      'a missing offer letter must not make somebody look non-compliant beside somebody with no ID at all');
    eq('their Aadhaar satisfied the Aadhaar requirement',
      done.satisfied.some(r => r.key === 'aadhaar'), true);
    eq('and three documents are on file', done.onFile.length, 3);

    check('the no-policy case is explained in the notes',
      report.notes.some(n => /on no policy/i.test(n)),
      report.notes.join(' | ').slice(0, 110));

    console.log('\n— completeness counts only what is REQUIRED —');
    eq('the filed employee counts as complete', done.complete, true);
    eq('the PF employee does not', pf.complete, false);
    check('the totals add up',
      report.totals.complete + report.totals.incomplete === report.totals.employees,
      `${report.totals.complete} + ${report.totals.incomplete} vs ${report.totals.employees}`);

    console.log('\n— the route —');
    eq('no cookie is rejected',
      (await reportRoute(new NextRequest('http://localhost:3000/api/reports/documents'))).status, 401);
    const tv = await currentTokenVersion(admin.id);
    const token = signAccessToken({ id: admin.id, emp_id: admin.emp_id, role: admin.role, tv } as never);
    const res = await reportRoute(new NextRequest('http://localhost:3000/api/reports/documents', {
      headers: { Cookie: `access_token=${token}` },
    }));
    eq('an administrator gets the report', res.status, 200);
    const body = (await res.json()).data as { storage: { configured: boolean }; totals: { employees: number } };
    check('it carries the storage setup so the page can state the real size limit',
      typeof body.storage.configured === 'boolean');
    check('…and never the credentials',
      !JSON.stringify(body.storage).match(/AKIA|SECRET/));

    const emp = await queryOne<{ id: number; emp_id: string; role: string }>(
      `SELECT id, emp_id, role FROM employees WHERE role = 'employee' AND is_active = 1 LIMIT 1`,
    );
    if (emp) {
      const etv = await currentTokenVersion(emp.id);
      const etoken = signAccessToken({ id: emp.id, emp_id: emp.emp_id, role: emp.role, tv: etv } as never);
      eq('a plain employee cannot read everybody\'s compliance',
        (await reportRoute(new NextRequest('http://localhost:3000/api/reports/documents', {
          headers: { Cookie: `access_token=${etoken}` },
        }))).status, 403);
    }
  } finally {
    await cleanup(f);
    const left = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM employees WHERE emp_id LIKE 'ZZDC%'`,
    );
    check('fixture cleaned up', Number(left?.n ?? 0) === 0, `${left?.n} left`);
    console.log(`\n${passed} passed, ${failed} failed`);
  }
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });

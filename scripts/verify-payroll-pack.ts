/**
 * scripts/verify-payroll-pack.ts — the file somebody gets paid from.
 *
 *   npx tsx --env-file=.env.local scripts/verify-payroll-pack.ts
 *
 * The checksum is the point, and a checksum is only worth having if it is
 * stable against noise and sensitive to data. Both are checked here against a
 * fixture month, which is removed afterwards including on failure.
 */

import { NextRequest } from 'next/server';
import { buildPayrollPack, payrollPackToXlsx } from '../lib/payrollExport';
import { GET } from '../app/api/reports/payroll-pack/route';
import { closeMonth } from '../lib/monthClose';
import { signAccessToken, currentTokenVersion } from '../lib/auth';
import { query, queryOne, pool } from '../lib/db';

const MONTH = '2019-07';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.parse(`${date}T00:00:00Z`) + (h * 60 + m - 330) * 60_000)
    .toISOString().slice(0, 19).replace('T', ' ');
};

interface Fixture { shiftId: number; a: number; b: number; }

async function seed(): Promise<Fixture> {
  const shift = (await query(
    `INSERT INTO shifts (name, type, start_time, end_time, grace_minutes, working_days)
     VALUES ('__pay_shift', 'fixed', '09:00:00', '18:00:00', 10,
             '["Mon","Tue","Wed","Thu","Fri","Sat"]')`,
  )) as unknown as { insertId: number };
  const shiftId = shift.insertId;

  const add = async (empId: string, name: string) => {
    const r = (await query(
      `INSERT INTO employees (emp_id, name, pin_hash, role, is_active) VALUES (?, ?, 'x', 'employee', 1)`,
      [empId, name],
    )) as unknown as { insertId: number };
    await query(
      `INSERT INTO employee_schedules (employee_id, shift_id, effective_from) VALUES (?, ?, '2019-01-01')`,
      [r.insertId, shiftId],
    );
    return r.insertId;
  };

  const a = await add('__PAY1', '__Pay Alpha');
  const b = await add('__PAY2', '__Pay Beta');

  for (let d = 1; d <= 31; d++) {
    const date = `2019-07-${String(d).padStart(2, '0')}`;
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) continue;
    await query(
      `INSERT INTO attendance (employee_id, work_date, status, clock_in_utc, clock_out_utc, total_minutes, session_count, banked_minutes)
       VALUES (?, ?, 'present', ?, ?, 540, 1, 0)`,
      [a, date, at(date, '09:00'), at(date, '18:00')],
    );
    await query(
      `INSERT INTO attendance (employee_id, work_date, status, clock_in_utc, clock_out_utc, total_minutes, session_count, banked_minutes)
       VALUES (?, ?, 'present', ?, ?, 420, 1, 0)`,
      [b, date, at(date, '09:00'), at(date, '16:00')],
    );
  }
  return { shiftId, a, b };
}

async function cleanup(f: Fixture | null) {
  if (!f) return;
  const ids = [f.a, f.b].filter(Boolean);
  if (ids.length) {
    const list = ids.map(() => '?').join(',');
    await query(`DELETE FROM attendance WHERE employee_id IN (${list})`, ids);
    await query(`DELETE FROM employee_schedules WHERE employee_id IN (${list})`, ids);
    await query(`DELETE FROM employees WHERE id IN (${list})`, ids);
  }
  if (f.shiftId) await query(`DELETE FROM shifts WHERE id = ?`, [f.shiftId]);
  await query(`DELETE FROM month_closures WHERE period_month = ?`, [`${MONTH}-01`]);
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
    f = await seed();

    console.log('\n— the pack —');
    const pack = await buildPayrollPack(MONTH);
    check('it has rows', pack.rows.length >= 2, `${pack.rows.length} employees`);
    const alpha = pack.rows.find(r => r.emp_id === '__PAY1')!;
    const beta = pack.rows.find(r => r.emp_id === '__PAY2')!;
    check('both fixture employees are in it', Boolean(alpha && beta));
    eq('a full-time employee has no shortfall', alpha.shortage_minutes, 0);
    check('the short employee does', beta.shortage_minutes > 0, `${beta.shortage_minutes} min`);
    eq('…of two hours per working day', beta.shortage_minutes, beta.working_days * 120);

    console.log('\n— the checksum is stable against noise —');
    const again = await buildPayrollPack(MONTH);
    eq('re-running on unchanged data gives the same checksum', again.checksum, pack.checksum);
    check('…even though the generated time differs',
      again.generated_at !== pack.generated_at,
      `${pack.generated_at} vs ${again.generated_at}`);
    check('the checksum looks like a SHA-256', /^[0-9a-f]{64}$/.test(pack.checksum), pack.checksum.slice(0, 16));

    console.log('\n— and sensitive to the figures —');
    await query(
      `UPDATE attendance SET total_minutes = total_minutes - 30
        WHERE employee_id = ? AND work_date = '2019-07-02'`, [f.a],
    );
    const changed = await buildPayrollPack(MONTH);
    check('changing one day changes the checksum', changed.checksum !== pack.checksum);
    await query(
      `UPDATE attendance SET total_minutes = total_minutes + 30
        WHERE employee_id = ? AND work_date = '2019-07-02'`, [f.a],
    );
    const restored = await buildPayrollPack(MONTH);
    eq('putting it back restores the original checksum', restored.checksum, pack.checksum);

    console.log('\n— provenance travels with the figures —');
    check('the rules in force are carried', pack.policy.shifts.length > 0);
    const mine = pack.policy.shifts.find(s => s.name === '__pay_shift')!;
    eq('the shift span is recorded', mine.span_minutes, 540);
    eq('no break policy is recorded as none', mine.unpaid_break_minutes, null);
    eq('so the required figure equals the span', mine.required_minutes, 540);
    check('the stated monthly standard is carried', pack.policy.standard_monthly_minutes > 0);

    console.log('\n— an unclosed month says so —');
    eq('closure is absent', pack.closure, null);
    check('…and a warning says not to pay from it yet',
      pack.warnings.some(w => /has not been closed/i.test(w)),
      pack.warnings.join(' | '));

    const admin = await queryOne<{ id: number; emp_id: string; role: string }>(
      `SELECT id, emp_id, role FROM employees WHERE role = 'super_admin' AND is_active = 1 LIMIT 1`,
    );
    if (admin) {
      await closeMonth({ month: MONTH, closedBy: admin.id, notes: 'verify-payroll-pack' });
      const closedPack = await buildPayrollPack(MONTH);
      check('once closed, the pack says who signed it off',
        closedPack.closure?.is_closed === true && Boolean(closedPack.closure?.closed_by_name),
        closedPack.closure?.closed_by_name ?? 'nobody');
      check('…and the not-closed warning is gone',
        !closedPack.warnings.some(w => /has not been closed/i.test(w)));
      eq('closing does not change the figures, so the checksum holds',
        closedPack.checksum, pack.checksum);
    }

    console.log('\n— the workbook —');
    const buf = payrollPackToXlsx(pack);
    check('it is a real xlsx', buf.length > 2000 && buf[0] === 0x50 && buf[1] === 0x4b,
      `${buf.length} bytes, magic ${buf[0]?.toString(16)}${buf[1]?.toString(16)}`);

    console.log('\n— the route —');
    eq('no cookie is rejected',
      (await GET(new NextRequest(`http://localhost:3000/api/reports/payroll-pack?month=${MONTH}`))).status, 401);
    if (admin) {
      const tv = await currentTokenVersion(admin.id);
      const token = signAccessToken({ id: admin.id, emp_id: admin.emp_id, role: admin.role, tv } as never);
      const get = (qs: string) => GET(new NextRequest(`http://localhost:3000/api/reports/payroll-pack?${qs}`, {
        headers: { Cookie: `access_token=${token}` },
      }));
      eq('a malformed month is refused', (await get('month=2019-7')).status, 400);
      eq('an unknown format is refused', (await get(`month=${MONTH}&format=pdf`)).status, 400);
      const json = await get(`month=${MONTH}`);
      eq('json returns 200', json.status, 200);
      const xlsx = await get(`month=${MONTH}&format=xlsx`);
      eq('xlsx returns 200', xlsx.status, 200);
      check('…with a spreadsheet content type',
        (xlsx.headers.get('content-type') ?? '').includes('spreadsheetml'),
        xlsx.headers.get('content-type') ?? '');
      check('…as an attachment named for the month',
        (xlsx.headers.get('content-disposition') ?? '').includes(`working-hours-${MONTH}.xlsx`));

      const logged = await queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payroll_pack_downloaded'`,
      );
      check('every download is audited', Number(logged?.n ?? 0) > 0, `${logged?.n} entries`);
    }

    const emp = await queryOne<{ id: number; emp_id: string; role: string }>(
      `SELECT id, emp_id, role FROM employees WHERE role = 'employee' AND is_active = 1 LIMIT 1`,
    );
    if (emp) {
      const tv = await currentTokenVersion(emp.id);
      const token = signAccessToken({ id: emp.id, emp_id: emp.emp_id, role: emp.role, tv } as never);
      eq('a plain employee cannot download it',
        (await GET(new NextRequest(`http://localhost:3000/api/reports/payroll-pack?month=${MONTH}`, {
          headers: { Cookie: `access_token=${token}` },
        }))).status, 403);
    }
  } finally {
    await cleanup(f);
    const left = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM employees WHERE emp_id LIKE '__PAY%'`,
    );
    check('fixture cleaned up', Number(left?.n ?? 0) === 0, `${left?.n} left`);
    console.log(`\n${passed} passed, ${failed} failed`);
  }
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });

/**
 * scripts/verify-permissions-queue.ts — the permission queue's badge and list must agree.
 *
 *   npx tsx --env-file=.env.local scripts/verify-permissions-queue.ts
 *
 * The reported bug: the Pending tab showed a badge of 1 above an empty table.
 * The badge counts every outstanding request by design, ignoring the other
 * filters; the list respected a date floor that defaulted to the start of the
 * current month. A request from the previous month was therefore counted and
 * hidden at the same time — and the one that had been waiting longest was
 * exactly the one nobody could see.
 *
 * These checks pin the API behaviour that made it possible, so the page can
 * rely on it. Builds its own fixture and removes it, including on failure.
 */

import { NextRequest } from 'next/server';
import { GET } from '../app/api/permissions/route';
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

/** The date floor the page used to apply by default. */
const monthStart = () => {
  const t = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return `${t.slice(0, 7)}-01`;
};

/** A date comfortably before this month — where the hidden request lived. */
const lastMonth = () => {
  const ms = monthStart();
  const [y, m] = ms.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 15));
  return d.toISOString().slice(0, 10);
};

async function main() {
  let employeeId: number | null = null;
  let requestId: number | null = null;
  try {
    const db = process.env.DB_NAME ?? '';
    if (/prod/i.test(db) || db === 'attendance_db') {
      console.log(`REFUSED: DB_NAME is "${db}" — this script writes.`);
      failed += 1;
      return;
    }

    const admin = await queryOne<{ id: number; emp_id: string; role: string }>(
      `SELECT id, emp_id, role FROM employees WHERE role = 'super_admin' AND is_active = 1 LIMIT 1`,
    );
    if (!admin) { check('a super_admin exists', false); return; }
    const tv = await currentTokenVersion(admin.id);
    const token = signAccessToken({ id: admin.id, emp_id: admin.emp_id, role: admin.role, tv } as never);

    const e = (await query(
      `INSERT INTO employees (emp_id, name, pin_hash, role, is_active)
       VALUES ('__PQ1', '__Perm Queue', 'x', 'employee', 1)`,
    )) as unknown as { insertId: number };
    employeeId = e.insertId;

    const old = lastMonth();
    const r = (await query(
      `INSERT INTO permission_requests
         (employee_id, request_type, permission_date, start_time, end_time, minutes, reason, status, requested_by)
       VALUES (?, 'permission', ?, '10:00:00', '12:00:00', 120, 'Waiting since last month', 'pending', ?)`,
      [employeeId, old, employeeId],
    )) as unknown as { insertId: number };
    requestId = r.insertId;

    const get = (qs: string) => GET(new NextRequest(
      `http://localhost:3000/api/permissions?${qs}`, { headers: { Cookie: `access_token=${token}` } },
    ));
    const body = async (qs: string) => (await (await get(qs)).json()) as {
      data: { permissions: Array<{ id: number }>; pending_count: number };
    };

    console.log(`\n— a request from ${old}, with the page's old default floor of ${monthStart()} —`);

    const filtered = await body(`status=pending&from_date=${monthStart()}`);
    check('the badge counts it, because the badge ignores the filters',
      filtered.data.pending_count >= 1, `${filtered.data.pending_count}`);
    check('…but the list does not contain it',
      !filtered.data.permissions.some(p => p.id === requestId),
      `${filtered.data.permissions.length} row(s)`);
    check('THIS is the contradiction the page must never show again',
      filtered.data.pending_count > 0 && !filtered.data.permissions.some(p => p.id === requestId));

    console.log('\n— with no date floor, which is what the Pending tab now sends —');
    const unfiltered = await body('status=pending');
    check('the list contains it',
      unfiltered.data.permissions.some(p => p.id === requestId),
      `${unfiltered.data.permissions.length} row(s)`);
    check('and the badge still counts it', unfiltered.data.pending_count >= 1);
    check('so badge and list now agree',
      unfiltered.data.permissions.filter(p => p.id === requestId).length === 1
      && unfiltered.data.pending_count >= 1);

    console.log('\n— the request is actionable, which is the point —');
    const row = unfiltered.data.permissions.find(p => p.id === requestId) as
      | { id: number; status?: string }
      | undefined;
    eq('it comes back as pending', row?.status, 'pending');

    console.log('\n— the badge is deliberately filter-independent —');
    const byEmployee = await body(`status=pending&employee_id=${employeeId}`);
    check('narrowing to one employee still reports the global pending count',
      byEmployee.data.pending_count >= 1, `${byEmployee.data.pending_count}`);
    const otherDates = await body('status=pending&from_date=2099-01-01');
    check('an impossible date range empties the list',
      otherDates.data.permissions.length === 0);
    check('…while the badge still reports outstanding work',
      otherDates.data.pending_count >= 1, `${otherDates.data.pending_count}`);

    console.log('\n— authority —');
    eq('an unauthenticated caller is rejected',
      (await GET(new NextRequest('http://localhost:3000/api/permissions'))).status, 401);
  } finally {
    if (requestId) await query(`DELETE FROM permission_requests WHERE id = ?`, [requestId]);
    if (employeeId) await query(`DELETE FROM employees WHERE id = ?`, [employeeId]);
    const left = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM employees WHERE emp_id = '__PQ1'`,
    );
    check('fixture cleaned up', Number(left?.n ?? 0) === 0);
    console.log(`\n${passed} passed, ${failed} failed`);
  }
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });

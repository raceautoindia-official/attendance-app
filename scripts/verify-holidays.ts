/**
 * scripts/verify-holidays.ts — verify the holiday calendar against the real DB.
 *
 * Exercises import idempotency, the verification gate, per-location scoping, and
 * that un-observing reverses exactly what observing did. No model calls.
 *
 * Mutates holiday_calendar / holiday_observances / leave_records and may touch
 * attendance rows — it cleans up after itself and reports anything it could not
 * undo. Run against a development database.
 *
 *   npx tsx --env-file=.env.local scripts/verify-holidays.ts
 */

import {
  importBundledYear,
  availableBundledYears,
  listHolidays,
  setObservance,
  addManualHoliday,
  HolidayError,
} from '../lib/holidays';
import { query, queryOne, pool } from '../lib/db';

const ACTOR = 1;
let pass = 0;
let fail = 0;
const ok = (l: string, d = '') => { pass++; console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`); };
const bad = (l: string, d: string) => { fail++; console.log(`  FAIL  ${l} — ${d}`); };

async function countLeaveHolidays(date: string, locationId: number | null) {
  const r = await queryOne<{ n: number }>(
    `SELECT COUNT(*) n FROM leave_records
      WHERE employee_id IS NULL AND leave_type='holiday' AND leave_date=?
        AND ((location_id IS NULL AND ? IS NULL) OR location_id = ?)`,
    [date, locationId, locationId],
  );
  return Number(r?.n ?? 0);
}

async function attendanceStatuses(date: string) {
  const rows = await query<{ employee_id: number; status: string }>(
    `SELECT employee_id, status FROM attendance WHERE work_date = ? ORDER BY employee_id`,
    [date],
  );
  return rows.map(r => `${r.employee_id}:${r.status}`).join(' ');
}

async function main() {
  console.log('\n— bundled datasets on disk —');
  const years = await availableBundledYears();
  if (years.length > 0) { ok('years found', years.join(', ')); } else { bad('years', 'none found'); }

  console.log('\n— import is idempotent —');
  const first = await importBundledYear(2026);
  const second = await importBundledYear(2026);
  if (first.errors.length) bad('import 2026', first.errors.join('; '));
  else ok('import 2026', `${first.found} found, ${first.inserted} inserted`);
  if (second.inserted === 0) ok('re-import inserts nothing', `${second.skipped} skipped`);
  else bad('re-import', `inserted ${second.inserted} on the second run`);

  const missing = await importBundledYear(1999);
  if (missing.errors.length > 0 && missing.found === 0) ok('missing year reports cleanly', missing.errors[0].slice(0, 60));
  else bad('missing year', 'did not report an error');

  console.log('\n— listing —');
  const list = await listHolidays(2026);
  ok('listed 2026', `${list.length} candidates`);
  const verified = list.filter(h => !h.needs_verification);
  const unverified = list.filter(h => h.needs_verification);
  ok('fixed vs variable split', `${verified.length} fixed, ${unverified.length} need verification`);
  if (list.every(h => !h.observed_anywhere)) ok('nothing observed by default', 'importing changed no attendance');
  else bad('default state', 'something is already observed after a plain import');

  console.log('\n— verification gate —');
  const lunar = unverified[0];
  if (!lunar) { bad('gate', 'no needs_verification holiday to test'); }
  else {
    try {
      await setObservance({ holidayId: lunar.id, locationId: null, isObserved: true, actorId: ACTOR });
      bad('gate blocks unverified', 'observed a lunar holiday with no confirmed date');
    } catch (e) {
      if (e instanceof HolidayError && e.status === 422) ok('gate blocks unverified', `${lunar.name}: 422`);
      else bad('gate', `unexpected: ${(e as Error).message}`);
    }
  }

  console.log('\n— observe for ALL locations, then reverse —');
  const fixed = verified.find(h => h.name.includes('Republic'));
  if (!fixed) { bad('fixed holiday', 'Republic Day not found'); }
  else {
    const before = await attendanceStatuses(fixed.holiday_date);
    const applied = await setObservance({
      holidayId: fixed.id, locationId: null, isObserved: true, actorId: ACTOR,
    });
    const leaveN = await countLeaveHolidays(fixed.holiday_date, null);
    if (leaveN === 1) ok('leave_records row created', `${fixed.name} ${fixed.holiday_date}`);
    else bad('leave_records', `expected 1 row, got ${leaveN}`);
    ok('scope computed', `${applied.employees_in_scope} employees, ${applied.attendance_rows_changed} attendance rows touched`);

    // Observing twice must not duplicate.
    await setObservance({ holidayId: fixed.id, locationId: null, isObserved: true, actorId: ACTOR });
    const leaveN2 = await countLeaveHolidays(fixed.holiday_date, null);
    if (leaveN2 === 1) { ok('observing twice is idempotent'); } else { bad('double observe', `${leaveN2} rows`); }

    await setObservance({ holidayId: fixed.id, locationId: null, isObserved: false, actorId: ACTOR });
    const leaveN3 = await countLeaveHolidays(fixed.holiday_date, null);
    if (leaveN3 === 0) { ok('un-observe removes the leave row'); } else { bad('un-observe', `${leaveN3} rows remain`); }
    const after = await attendanceStatuses(fixed.holiday_date);
    if (after === before) {
      ok('attendance restored exactly', before || '(no rows on that date)');
    } else {
      bad('attendance not restored', `before="${before}" after="${after}"`);
    }
  }

  console.log('-- pruning and observance de-duplication --');
  {
    // An unobserved stale bundled row must be pruned...
    const stale = await query<{ id: number }>(
      `INSERT INTO holiday_calendar (year, holiday_date, name, holiday_type, state_code, needs_verification, source, notes)
       VALUES (2026, '2026-12-19', 'Prune Guard Holiday', 'national', NULL, FALSE, 'bundled', 'test')`,
    );
    const staleId = (stale as unknown as { insertId: number }).insertId;
    const r1 = await importBundledYear(2026);
    const gone = await queryOne<{ n: number }>(
      'SELECT COUNT(*) n FROM holiday_calendar WHERE id = ?', [staleId]);
    if (Number(gone?.n) === 0) ok('unobserved stale bundled row pruned', `pruned=${r1.pruned}`);
    else bad('prune', 'stale unobserved row survived');

    // ...but an OBSERVED one must survive, or its leave_records row is orphaned.
    const kept = await query<{ id: number }>(
      `INSERT INTO holiday_calendar (year, holiday_date, name, holiday_type, state_code, needs_verification, source, notes)
       VALUES (2026, '2026-12-22', 'Prune Guard Observed', 'national', NULL, FALSE, 'bundled', 'test')`,
    );
    const keptId = (kept as unknown as { insertId: number }).insertId;
    await setObservance({ holidayId: keptId, locationId: null, isObserved: true, actorId: ACTOR });
    await importBundledYear(2026);
    const still = await queryOne<{ n: number }>(
      'SELECT COUNT(*) n FROM holiday_calendar WHERE id = ?', [keptId]);
    if (Number(still?.n) === 1) ok('observed row survives pruning', 'its leave_records row is safe');
    else bad('prune safety', 'pruned a holiday that was in force');
    const lr = await countLeaveHolidays('2026-12-22', null);
    if (lr === 1) ok('its leave_records row intact');
    else bad('leave row', `expected 1, got ${lr}`);

    // Regression guard: a UNIQUE on (holiday_id, location_id) does NOT dedupe
    // all-locations rows, because MySQL treats NULLs in a unique key as distinct.
    await setObservance({ holidayId: keptId, locationId: null, isObserved: true, actorId: ACTOR });
    await setObservance({ holidayId: keptId, locationId: null, isObserved: true, actorId: ACTOR });
    const obsN = await queryOne<{ n: number }>(
      'SELECT COUNT(*) n FROM holiday_observances WHERE holiday_id = ?', [keptId]);
    if (Number(obsN?.n) === 1) ok('all-locations observance never duplicates', 'NULL-safe unique key holds');
    else bad('observance duplication', `${obsN?.n} rows for one holiday + location`);

    await setObservance({ holidayId: keptId, locationId: null, isObserved: false, actorId: ACTOR });
    await query('DELETE FROM holiday_calendar WHERE id = ?', [keptId]);
  }

  console.log('\n— per-location scoping —');
  const locs = await query<{ id: number; name: string }>(
    `SELECT id, name FROM locations WHERE is_active = TRUE ORDER BY id`,
  );
  const headOffice = locs[0];
  if (!headOffice) { bad('locations', 'no active location'); }
  else {
    const id = await addManualHoliday({
      date: '2026-12-11', name: 'Scoping Test Holiday', type: 'company', actorId: ACTOR,
    });
    ok('manual holiday added', `id=${id}`);

    const allScope = await setObservance({ holidayId: id, locationId: null, isObserved: true, actorId: ACTOR });
    await setObservance({ holidayId: id, locationId: null, isObserved: false, actorId: ACTOR });
    const locScope = await setObservance({ holidayId: id, locationId: headOffice.id, isObserved: true, actorId: ACTOR });

    if (locScope.employees_in_scope < allScope.employees_in_scope) {
      ok('location scope is narrower than all-locations',
         `${headOffice.name}=${locScope.employees_in_scope} vs all=${allScope.employees_in_scope}`);
    } else {
      bad('location scope', `all=${allScope.employees_in_scope} location=${locScope.employees_in_scope} — expected fewer`);
    }

    const locLeave = await countLeaveHolidays('2026-12-11', headOffice.id);
    const allLeave = await countLeaveHolidays('2026-12-11', null);
    if (locLeave === 1 && allLeave === 0) ok('leave row is location-scoped', `location_id=${headOffice.id}`);
    else bad('leave scoping', `location rows=${locLeave}, all-location rows=${allLeave}`);

    // Clean up the test holiday (cascades to observances).
    await setObservance({ holidayId: id, locationId: headOffice.id, isObserved: false, actorId: ACTOR });
    await query('DELETE FROM holiday_calendar WHERE id = ?', [id]);
    const left = await countLeaveHolidays('2026-12-11', headOffice.id);
    if (left === 0) { ok('test holiday cleaned up'); } else { bad('cleanup', `${left} leave rows left behind`); }
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async e => {
  console.error('\nverification crashed:', e);
  await pool.end();
  process.exit(1);
});

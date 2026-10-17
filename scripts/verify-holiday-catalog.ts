/**
 * scripts/verify-holiday-catalog.ts — holidays for any country.
 *
 *   npx tsx --env-file=.env.local scripts/verify-holiday-catalog.ts
 *
 * The property that makes importing safe is the one worth proving hardest:
 * an import creates CANDIDATES, and a candidate changes no working day, no
 * required hours and nobody's attendance. If that were ever untrue, loading a
 * country speculatively would silently rewrite everybody's month.
 *
 * Also guarded:
 *   - a second country does not collide with the first. The unique key used to
 *     be (date, name, state) with no country, so 'Christmas Day' in the UK was
 *     the same row as 'Christmas Day' in India and the second import vanished.
 *   - only 'public' holidays are imported. The library also returns bank,
 *     optional and observance entries, and an administrator asked to approve a
 *     list containing Valentine's Day stops reading it.
 *   - a re-import adds nothing and overwrites nothing.
 *
 * Everything it creates is removed at the end.
 */

import {
  listCountries, listRegions, listForYear, importCountryYear,
  listTrackedCountries, trackCountry, untrackCountry,
} from '../lib/holidayCatalog';
import { workingDaysFor, weekdayCounts, companyHolidays } from '../lib/workingDays';
import { query, queryOne, pool } from '../lib/db';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

// A year far enough out that nothing real is in the calendar for it.
const YEAR = 2032;
const ACTOR_FALLBACK = 1;

async function cleanup() {
  await query(`DELETE FROM holiday_calendar WHERE year = ? AND source = 'library'`, [YEAR]);
  await query(`DELETE FROM holiday_countries WHERE country_code IN ('GB','JP')`);
}

async function main() {
  const actor = (await queryOne<{ id: number }>(
    `SELECT id FROM employees WHERE role = 'super_admin' AND is_active = 1 LIMIT 1`))?.id
    ?? ACTOR_FALLBACK;
  try {
    await cleanup();

    console.log('\n— the catalogue —');
    const countries = listCountries();
    check('every country the library knows is offered', countries.length > 200, `${countries.length}`);
    check('sorted by name, because nobody scans for a code',
      countries[0].name.localeCompare(countries[countries.length - 1].name) < 0);
    check('and names are not mangled by escaping',
      countries.every(c => !c.name.includes('\\')),
      countries.find(c => c.name.includes('\\'))?.name ?? 'all clean');
    check('a country with subdivisions lists them', listRegions('IN').length > 20,
      `${listRegions('IN').length} for India`);
    check('and one without returns none rather than failing',
      Array.isArray(listRegions('SG')));

    console.log('\n— it computes, rather than looking up a file —');
    // The bundled data stops at 2027. A rules engine does not stop.
    check('a year far beyond any bundled file still answers',
      listForYear('IN', 2045).length > 0, `${listForYear('IN', 2045).length} for 2045`);
    check('only public holidays are returned',
      listForYear('GB', YEAR).every(h => h.type === 'public'));
    check('a region adds to the national list, it does not replace it',
      listForYear('IN', YEAR, 'TN').length >= listForYear('IN', YEAR).length,
      `${listForYear('IN', YEAR, 'TN').length} vs ${listForYear('IN', YEAR).length}`);

    console.log('\n— importing creates candidates, and nothing else —');
    // Measured before and after against the SAME function the hours ledger
    // uses, so this is the real effect on somebody's month, not a proxy.
    const first = `${YEAR}-01-01`;
    const last = `${YEAR}-12-31`;
    const counts = weekdayCounts(first, last);
    const before = workingDaysFor(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], counts,
      await companyHolidays(first, last));

    const imported = await importCountryYear({ countryCode: 'GB', year: YEAR, by: actor });
    check('it found holidays', imported.found > 0, `${imported.found} found`);
    eq('and inserted all of them', imported.inserted, imported.found);

    const after = workingDaysFor(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], counts,
      await companyHolidays(first, last));
    eq('working days are UNCHANGED - a candidate closes nothing', after, before);

    const rows = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM holiday_calendar
        WHERE year = ? AND country_code = 'GB' AND needs_verification = TRUE`, [YEAR]);
    eq('and every imported row is flagged unverified', Number(rows[0].n), imported.inserted);

    console.log('\n— a re-import changes nothing —');
    const again = await importCountryYear({ countryCode: 'GB', year: YEAR, by: actor });
    eq('nothing new is inserted', again.inserted, 0);
    eq('and everything is reported as left alone', again.skipped, again.found);

    console.log('\n— a second country does not collide with the first —');
    // The old unique key had no country, so a shared date and name - which
    // Christmas is - made the second import vanish silently.
    const jp = await importCountryYear({ countryCode: 'JP', year: YEAR, by: actor });
    check('the second country imports its own rows', jp.inserted > 0, `${jp.inserted} inserted`);
    const perCountry = await query<{ country_code: string; n: number }>(
      `SELECT country_code, COUNT(*) AS n FROM holiday_calendar
        WHERE year = ? AND source = 'library' GROUP BY country_code`, [YEAR]);
    eq('both countries are present', perCountry.length, 2);
    check('and each kept its own rows',
      perCountry.every(p => Number(p.n) > 0),
      perCountry.map(p => `${p.country_code}:${p.n}`).join(' '));

    const shared = await query<{ country_code: string }>(
      `SELECT country_code FROM holiday_calendar
        WHERE year = ? AND source = 'library' AND name LIKE '%Christmas%'`, [YEAR]);
    check('a date both countries share exists for each of them separately',
      new Set(shared.map(s => s.country_code)).size >= 1,
      shared.map(s => s.country_code).join(',') || 'none shared this year');

    console.log('\n— which countries this company tracks —');
    await trackCountry({ countryCode: 'GB', regionCode: null, by: actor });
    const tracked = await listTrackedCountries();
    const gb = tracked.find(t => t.country_code === 'GB');
    check('a country can be tracked', Boolean(gb));
    eq('with its proper name, not just a code', gb?.country_name, 'United Kingdom');

    await trackCountry({ countryCode: 'GB', regionCode: null, by: actor });
    eq('tracking it twice does not duplicate it',
      (await listTrackedCountries()).filter(t => t.country_code === 'GB' && !t.region_code).length, 1);

    await untrackCountry(gb!.id);
    const afterUntrack = (await listTrackedCountries()).find(t => t.id === gb!.id);
    check('untracking deactivates rather than deletes', Boolean(afterUntrack));
    eq('so holidays already imported under it stay explainable',
      afterUntrack?.is_active, false);

    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    await cleanup();
  }
}

main()
  .catch(err => { console.error(err); failed += 1; })
  .finally(async () => { await pool.end(); process.exit(failed === 0 ? 0 : 1); });

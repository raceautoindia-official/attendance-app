import Holidays from 'date-holidays';
import { query, insertAuditLog } from '@/lib/db';

/**
 * lib/holidayCatalog.ts — public holidays for any of 207 countries.
 *
 * Wraps `date-holidays`, which computes from rules rather than shipping a
 * list. That is why it can answer 2030 as readily as 2026, and why no file has
 * to be maintained per country per year — which is exactly why the bundled
 * data stopped at 2027.
 *
 * HOW THIS SITS BESIDE THE BUNDLED INDIA DATA, stated plainly because the
 * difference is large enough to mislead somebody:
 *
 *   date-holidays, Tamil Nadu 2026 ....  7 public holidays
 *   the bundled file, 2026 ............ 24, including Pongal and Deepavali
 *
 * So the library is NOT a replacement. It is the only way to cover a country
 * nobody has written a file for, and for India it is thinner than what is
 * already here. Both import as CANDIDATES, both are tagged with where they
 * came from, and nothing affects a single working day until somebody marks it
 * observed. An import that silently replaced the richer list would quietly
 * turn Deepavali into a working day.
 */

export interface CountryOption { code: string; name: string }
export interface RegionOption { code: string; name: string }

export interface CatalogHoliday {
  date: string;
  name: string;
  /** 'public' is the only type imported; see listForYear. */
  type: string;
  /** Null for a national holiday, a subdivision code for a regional one. */
  region: string | null;
}

/** All 207, sorted by name rather than code - nobody scans for 'IN'. */
export function listCountries(): CountryOption[] {
  const hd = new Holidays();
  const all = hd.getCountries() as Record<string, string>;
  return Object.entries(all)
    // The library's own data carries a few escaped apostrophes, so Lesotho
    // arrives as "\'Muso oa Lesotho" - which also sorts it to the very top.
    .map(([code, name]) => ({ code, name: name.replace(/\\(['"])/g, '$1').trim() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** States, provinces or equivalent. Empty when a country has none. */
export function listRegions(countryCode: string): RegionOption[] {
  const hd = new Holidays();
  const states = (hd.getStates(countryCode) ?? {}) as Record<string, string>;
  return Object.entries(states)
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * What a country observes in a year.
 *
 * Filtered to `public`. The library also returns 'bank', 'optional' and
 * 'observance', and those are not days a workplace closes — importing them
 * would put Valentine's Day in a list an administrator is being asked to
 * approve, and the real entries would be lost among them.
 */
export function listForYear(
  countryCode: string, year: number, regionCode?: string | null,
): CatalogHoliday[] {
  const hd = regionCode
    ? new Holidays(countryCode, regionCode)
    : new Holidays(countryCode);

  const raw = hd.getHolidays(year) ?? [];
  const seen = new Set<string>();
  const out: CatalogHoliday[] = [];

  for (const h of raw) {
    if (h.type !== 'public') continue;
    const date = String(h.date).slice(0, 10);
    // The same holiday can appear twice when a region repeats a national one.
    const key = `${date}|${h.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, name: String(h.name), type: h.type, region: regionCode ?? null });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export interface CatalogImportResult {
  country: string;
  region: string | null;
  year: number;
  found: number;
  inserted: number;
  /** Already present from any source, so left exactly as they were. */
  skipped: number;
  notes: string[];
}

/**
 * Bring a country's year into `holiday_calendar` as CANDIDATES.
 *
 * Inert by construction: a candidate changes no working day, no required
 * hours and nobody's attendance until it is observed. That is what makes it
 * safe to import a country speculatively and look at the result.
 *
 * Existing rows are never overwritten. A hand-entered date, or a richer
 * bundled one, outranks a computed guess — and the import reports how many it
 * left alone rather than quietly reconciling them.
 */
export async function importCountryYear(params: {
  countryCode: string;
  year: number;
  regionCode?: string | null;
  by: number;
  ip?: string | null;
}): Promise<CatalogImportResult> {
  const { countryCode, year, regionCode = null, by, ip = null } = params;
  const notes: string[] = [];

  const holidays = listForYear(countryCode, year, regionCode);

  // Two statements for the whole import, not two per holiday. A country
  // year is a few dozen dates, and the obvious loop was a SELECT and an
  // INSERT each - which also made the result non-atomic, so a failure
  // part-way left the year half imported with nothing to say so.
  const existingRows = holidays.length === 0 ? [] : await query<{ k: string }>(
    `SELECT CONCAT(DATE_FORMAT(holiday_date, '%Y-%m-%d'), '|', name) AS k
       FROM holiday_calendar
      WHERE country_code = ? AND year = ?
        AND COALESCE(state_code, '-') = COALESCE(?, '-')`,
    [countryCode, year, regionCode]);
  const already = new Set(existingRows.map(r => r.k));

  const fresh = holidays.filter(h => !already.has(`${h.date}|${h.name}`));
  const inserted = fresh.length;
  const skipped = holidays.length - fresh.length;

  if (fresh.length > 0) {
    const values: unknown[] = [];
    const rows = fresh.map(h => {
      values.push(year, countryCode, regionCode, h.date, h.name,
        regionCode ? 'regional' : 'national', regionCode);
      // 'library' is a literal rather than a bound parameter because it is the
      // same for every row of this statement and never comes from input.
      return "(?, ?, ?, ?, ?, ?, ?, TRUE, 'library')";
    });
    await query(
      `INSERT INTO holiday_calendar
         (year, country_code, region_code, holiday_date, name, holiday_type,
          state_code, needs_verification, source)
       VALUES ${rows.join(', ')}`,
      values,
    );
  }

  if (holidays.length === 0) {
    notes.push(
      `No public holidays were computed for ${countryCode}${regionCode ? `-${regionCode}` : ''} `
      + `in ${year}. The library covers the country but may have no rules for that `
      + 'subdivision; try the country without a region.',
    );
  }
  if (countryCode === 'IN') {
    notes.push(
      'For India the bundled dataset is richer than the library - it carries the '
      + 'regional festivals the library does not compute. Both are listed as '
      + 'candidates; neither affects a working day until it is observed.',
    );
  }

  await insertAuditLog({
    action: 'holiday_library_imported', entity: 'holiday_calendar', entity_id: year,
    performed_by: by, ip_address: ip,
    details: { country: countryCode, region: regionCode, year, found: holidays.length, inserted, skipped },
  });

  return { country: countryCode, region: regionCode, year, found: holidays.length, inserted, skipped, notes };
}

// ---------------------------------------------------------------------------
// Which countries this company cares about
// ---------------------------------------------------------------------------

export interface TrackedCountry {
  id: number;
  country_code: string;
  country_name: string;
  region_code: string | null;
  region_name: string | null;
  is_active: boolean;
}

export async function listTrackedCountries(): Promise<TrackedCountry[]> {
  const rows = await query<Omit<TrackedCountry, 'is_active'> & { is_active: number }>(
    `SELECT id, country_code, country_name, region_code, region_name, is_active
       FROM holiday_countries ORDER BY country_name, region_name`);
  return rows.map(r => ({ ...r, is_active: Boolean(r.is_active) }));
}

export async function trackCountry(params: {
  countryCode: string; regionCode?: string | null; by: number;
}): Promise<void> {
  const { countryCode, regionCode = null, by } = params;
  const country = listCountries().find(c => c.code === countryCode);
  if (!country) throw new Error('No such country.');
  const region = regionCode
    ? listRegions(countryCode).find(r => r.code === regionCode) ?? null
    : null;

  await query(
    `INSERT INTO holiday_countries (country_code, country_name, region_code, region_name, added_by)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE is_active = TRUE, country_name = VALUES(country_name),
                             region_name = VALUES(region_name)`,
    [countryCode, country.name, regionCode, region?.name ?? null, by]);
}

export async function untrackCountry(id: number): Promise<void> {
  // Deactivated rather than deleted: holidays already imported under it stay
  // readable, and a past month must still be able to explain why a day was
  // closed.
  await query(`UPDATE holiday_countries SET is_active = FALSE WHERE id = ?`, [id]);
}

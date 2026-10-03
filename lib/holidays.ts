/**
 * lib/holidays.ts — the holiday calendar: candidates, and the admin's decision.
 *
 * MODEL: "propose, don't apply."
 *
 *   data/holidays/IN-<year>.json  →  holiday_calendar   (candidates, inert)
 *                                          ↓  admin observes, per location
 *                                    leave_records      (what the app acts on)
 *                                          ↓
 *                                    attendance.status = 'holiday'
 *
 * Importing the bundled dataset changes nothing an employee would notice. Only
 * `setObservance` writes to `leave_records`, and only for the locations the
 * admin picked — because applying a holiday rewrites `attendance` for everyone
 * in scope, and that feeds payroll.
 */

import fs from 'fs/promises';
import path from 'path';
import { formatInTimeZone } from 'date-fns-tz';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { TIMEZONE } from '@/lib/constants';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export type HolidayType = 'national' | 'regional' | 'company';

export interface BundledHoliday {
  date: string;
  name: string;
  type: HolidayType;
  state_code: string | null;
  needs_verification: boolean;
  notes?: string | null;
}

export interface HolidayRow {
  id: number;
  year: number;
  holiday_date: string;
  name: string;
  holiday_type: HolidayType;
  state_code: string | null;
  needs_verification: boolean;
  source: 'bundled' | 'manual';
  notes: string | null;
}

/** One location's decision about one holiday. */
export interface ObservanceRow {
  location_id: number | null;
  location_name: string | null;
  is_observed: boolean;
  decided_by_name: string | null;
  decided_at: string | null;
}

export interface HolidayWithObservances extends HolidayRow {
  observances: ObservanceRow[];
  /** True when any location observes it — the quick "is this live?" signal. */
  observed_anywhere: boolean;
}

/** A DATE column from mysql2 (a Date at midnight UTC) as YYYY-MM-DD. */
function ymd(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return formatInTimeZone(value, 'UTC', 'yyyy-MM-dd');
  return String(value).slice(0, 10);
}

/** "Mon".."Sun" for an IST date, matching the values in shifts.working_days. */
function weekdayAbbr(workDate: string): string {
  // Noon IST avoids any midnight edge.
  return formatInTimeZone(new Date(`${workDate}T12:00:00+05:30`), TIMEZONE, 'EEE');
}

// ---------------------------------------------------------------------------
// Importing the bundled dataset
// ---------------------------------------------------------------------------

export interface ImportResult {
  year: number;
  found: number;
  inserted: number;
  /** Existing bundled rows whose metadata was refreshed from the file. */
  refreshed: number;
  /**
   * Stale bundled candidates removed because the dataset no longer lists them —
   * e.g. a date or spelling was corrected in the file. Only ever untouched,
   * unobserved bundled rows.
   */
  pruned: number;
  skipped: number;
  errors: string[];
}

/**
 * Load `data/holidays/IN-<year>.json` into `holiday_calendar`.
 *
 * Idempotent: the unique key makes re-running insert nothing new.
 *
 * Rows still marked `source = 'bundled'` have their metadata refreshed from the
 * file — type, state, notes and the needs_verification flag — so a corrected
 * dataset reaches an existing deployment. Their DATE is left alone, and rows an
 * admin has edited (`source = 'manual'`) are never touched at all, so a
 * confirmed date can never be clobbered by a re-import.
 */
export async function importBundledYear(year: number): Promise<ImportResult> {
  const result: ImportResult = {
    year, found: 0, inserted: 0, refreshed: 0, pruned: 0, skipped: 0, errors: [],
  };

  const file = path.join(process.cwd(), 'data', 'holidays', `IN-${year}.json`);
  let parsed: { year?: number; holidays?: BundledHoliday[] };

  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    const code = (err as { code?: string }).code;
    result.errors.push(
      code === 'ENOENT'
        ? `No bundled holiday list for ${year}. Add data/holidays/IN-${year}.json, or add holidays by hand.`
        : `Could not read data/holidays/IN-${year}.json: ${(err as Error).message}`,
    );
    return result;
  }

  const list = Array.isArray(parsed.holidays) ? parsed.holidays : [];
  result.found = list.length;

  for (const h of list) {
    if (!h?.date || !YMD.test(h.date) || !h.name) {
      result.errors.push(`Skipped a malformed entry: ${JSON.stringify(h).slice(0, 80)}`);
      result.skipped += 1;
      continue;
    }
    if (!h.date.startsWith(String(year))) {
      result.errors.push(`${h.name}: date ${h.date} is not in ${year}`);
      result.skipped += 1;
      continue;
    }

    // INSERT IGNORE relies on uq_holiday_calendar, so a re-import is a no-op
    // and never overwrites a date an admin has corrected.
    const res = await query<{ affectedRows?: number }>(
      `INSERT IGNORE INTO holiday_calendar
         (year, holiday_date, name, holiday_type, state_code, needs_verification, source, notes)
       VALUES (?, ?, ?, ?, ?, ?, 'bundled', ?)`,
      [
        year,
        h.date,
        h.name,
        h.type ?? 'national',
        h.state_code ?? null,
        h.needs_verification ? 1 : 0,
        h.notes ?? null,
      ],
    );
    const affected = (res as unknown as { affectedRows: number }).affectedRows ?? 0;
    if (affected > 0) {
      result.inserted += 1;
      continue;
    }

    // The row already exists. Refresh its metadata only while it is still
    // untouched bundled data — never an admin's own edit, and never the date.
    const upd = await query<{ affectedRows?: number }>(
      `UPDATE holiday_calendar
          SET holiday_type = ?, needs_verification = ?, notes = ?
        WHERE holiday_date = ?
          AND name = ?
          AND COALESCE(state_code, '-') = COALESCE(?, '-')
          AND source = 'bundled'
          AND (holiday_type <> ? OR needs_verification <> ? OR NOT (notes <=> ?))`,
      [
        h.type ?? 'national',
        h.needs_verification ? 1 : 0,
        h.notes ?? null,
        h.date,
        h.name,
        h.state_code ?? null,
        h.type ?? 'national',
        h.needs_verification ? 1 : 0,
        h.notes ?? null,
      ],
    );
    const changed = (upd as unknown as { affectedRows: number }).affectedRows ?? 0;
    if (changed > 0) result.refreshed += 1;
    else result.skipped += 1;
  }

  // Prune stale candidates. When a date or spelling is corrected in the dataset
  // the old entry no longer matches the unique key, so a plain re-import would
  // leave it behind as an orphan and the calendar would accumulate junk.
  //
  // Strictly limited to rows that are safe to drop: still `source = 'bundled'`
  // (so never an admin's edit) and not observed anywhere (so no leave_records
  // row depends on them). Anything else is kept, even if absent from the file.
  const keep = list
    .filter(h => h?.date && YMD.test(h.date) && h.name)
    .map(h => `${h.date}|${h.name}|${h.state_code ?? '-'}`);

  if (keep.length > 0) {
    const del = await query<{ affectedRows?: number }>(
      `DELETE hc FROM holiday_calendar hc
        WHERE hc.year = ?
          AND hc.source = 'bundled'
          AND CONCAT(DATE_FORMAT(hc.holiday_date, '%Y-%m-%d'), '|', hc.name, '|',
                     COALESCE(hc.state_code, '-')) NOT IN (${keep.map(() => '?').join(', ')})
          AND NOT EXISTS (
                SELECT 1 FROM holiday_observances o
                 WHERE o.holiday_id = hc.id AND o.is_observed = TRUE
              )`,
      [year, ...keep],
    );
    result.pruned = (del as unknown as { affectedRows: number }).affectedRows ?? 0;
  }

  return result;
}

/** Years that have a bundled dataset on disk. */
export async function availableBundledYears(): Promise<number[]> {
  try {
    const dir = path.join(process.cwd(), 'data', 'holidays');
    const files = await fs.readdir(dir);
    return files
      .map(f => f.match(/^IN-(\d{4})\.json$/)?.[1])
      .filter((y): y is string => Boolean(y))
      .map(Number)
      .sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Reading the calendar
// ---------------------------------------------------------------------------

export async function listHolidays(year: number): Promise<HolidayWithObservances[]> {
  const holidays = await query<{
    id: number;
    year: number;
    holiday_date: Date | string;
    name: string;
    holiday_type: HolidayType;
    state_code: string | null;
    needs_verification: 0 | 1;
    source: 'bundled' | 'manual';
    notes: string | null;
  }>(
    `SELECT id, year, holiday_date, name, holiday_type, state_code,
            needs_verification, source, notes
       FROM holiday_calendar
      WHERE year = ?
      ORDER BY holiday_date ASC, name ASC`,
    [year],
  );

  if (holidays.length === 0) return [];

  const obs = await query<{
    holiday_id: number;
    location_id: number | null;
    location_name: string | null;
    is_observed: 0 | 1;
    decided_by_name: string | null;
    decided_at: Date | null;
  }>(
    `SELECT o.holiday_id, o.location_id, l.name AS location_name,
            o.is_observed, e.name AS decided_by_name, o.decided_at
       FROM holiday_observances o
       JOIN holiday_calendar h ON h.id = o.holiday_id
       LEFT JOIN locations l ON l.id = o.location_id
       LEFT JOIN employees e ON e.id = o.decided_by
      WHERE h.year = ?`,
    [year],
  );

  const byHoliday = new Map<number, ObservanceRow[]>();
  for (const o of obs) {
    if (!byHoliday.has(o.holiday_id)) byHoliday.set(o.holiday_id, []);
    byHoliday.get(o.holiday_id)!.push({
      location_id: o.location_id,
      location_name: o.location_name,
      is_observed: Boolean(Number(o.is_observed)),
      decided_by_name: o.decided_by_name,
      decided_at: o.decided_at ? o.decided_at.toISOString() : null,
    });
  }

  return holidays.map(h => {
    const observances = byHoliday.get(h.id) ?? [];
    return {
      id: h.id,
      year: Number(h.year),
      holiday_date: ymd(h.holiday_date),
      name: h.name,
      holiday_type: h.holiday_type,
      state_code: h.state_code,
      needs_verification: Boolean(Number(h.needs_verification)),
      source: h.source,
      notes: h.notes,
      observances,
      observed_anywhere: observances.some(o => o.is_observed),
    };
  });
}

// ---------------------------------------------------------------------------
// Observing / un-observing
// ---------------------------------------------------------------------------

export class HolidayError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'HolidayError';
  }
}

/**
 * Employees in scope for a holiday at `locationId` on `workDate`.
 *
 * locationId null  -> every active employee, including those with no location.
 * locationId set   -> only employees whose schedule effective on that date
 *                     points at that location.
 */
async function employeesInScope(
  workDate: string,
  locationId: number | null,
): Promise<number[]> {
  if (locationId === null) {
    const rows = await query<{ id: number }>(
      `SELECT id FROM employees WHERE is_active = TRUE`,
    );
    return rows.map(r => Number(r.id));
  }

  const rows = await query<{ id: number }>(
    `SELECT DISTINCT e.id
       FROM employees e
       JOIN employee_schedules es
         ON  es.employee_id = e.id
         AND es.effective_from <= ?
         AND (es.effective_to IS NULL OR es.effective_to >= ?)
      WHERE e.is_active = TRUE
        AND es.location_id = ?`,
    [workDate, workDate, locationId],
  );
  return rows.map(r => Number(r.id));
}

export interface ObservanceChange {
  holiday_id: number;
  holiday_name: string;
  holiday_date: string;
  location_id: number | null;
  is_observed: boolean;
  employees_in_scope: number;
  attendance_rows_changed: number;
}

/**
 * Observe or un-observe a holiday for one location.
 *
 * A holiday flagged `needs_verification` cannot be observed until the caller
 * supplies `confirmed_date`. That is deliberate friction: the bundled date for
 * a lunar festival is a placeholder, and observing a wrong date rewrites
 * attendance for every employee in scope. Supplying the date clears the flag.
 */
export async function setObservance(args: {
  holidayId: number;
  locationId: number | null;
  isObserved: boolean;
  confirmedDate?: string;
  actorId: number;
  ip?: string | null;
}): Promise<ObservanceChange> {
  const { holidayId, locationId, isObserved, confirmedDate, actorId, ip } = args;

  const holiday = await queryOne<{
    id: number;
    holiday_date: Date | string;
    name: string;
    needs_verification: 0 | 1;
  }>(
    `SELECT id, holiday_date, name, needs_verification
       FROM holiday_calendar WHERE id = ? LIMIT 1`,
    [holidayId],
  );
  if (!holiday) throw new HolidayError('No such holiday in the calendar.', 404);

  if (locationId !== null) {
    const loc = await queryOne<{ id: number }>(
      'SELECT id FROM locations WHERE id = ? LIMIT 1',
      [locationId],
    );
    if (!loc) throw new HolidayError('No such location.', 404);
  }

  let workDate = ymd(holiday.holiday_date);

  // Verification gate.
  if (isObserved && Number(holiday.needs_verification) === 1) {
    if (!confirmedDate || !YMD.test(confirmedDate)) {
      throw new HolidayError(
        `"${holiday.name}" is on a variable calendar, so the date in the bundled list is only a placeholder (${workDate}). Confirm the correct date before observing it.`,
        422,
      );
    }
    workDate = confirmedDate;
    await query(
      `UPDATE holiday_calendar
          SET holiday_date = ?, needs_verification = FALSE, source = 'manual'
        WHERE id = ?`,
      [workDate, holidayId],
    );
  } else if (isObserved && confirmedDate && YMD.test(confirmedDate) && confirmedDate !== workDate) {
    // Admin corrected an already-verified date.
    workDate = confirmedDate;
    await query(
      `UPDATE holiday_calendar SET holiday_date = ?, source = 'manual' WHERE id = ?`,
      [workDate, holidayId],
    );
  }

  const scope = await employeesInScope(workDate, locationId);
  let changed = 0;

  if (isObserved) {
    // 1. The leave_records row the rest of the app already understands.
    //    location_id NULL keeps the existing company-wide meaning.
    const existing = await queryOne<{ id: number }>(
      `SELECT id FROM leave_records
        WHERE employee_id IS NULL
          AND leave_date = ?
          AND leave_type = 'holiday'
          AND ((location_id IS NULL AND ? IS NULL) OR location_id = ?)
        LIMIT 1`,
      [workDate, locationId, locationId],
    );

    let leaveRecordId = existing?.id ?? null;
    if (!leaveRecordId) {
      const res = await query(
        `INSERT INTO leave_records (employee_id, location_id, leave_date, leave_type, notes, created_by)
         VALUES (NULL, ?, ?, 'holiday', ?, ?)`,
        [locationId, workDate, holiday.name, actorId],
      );
      leaveRecordId = (res as unknown as { insertId: number }).insertId ?? null;
    }

    // 2. Flip existing attendance rows for employees in scope only.
    if (scope.length > 0) {
      const res = await query(
        `UPDATE attendance
            SET status = 'holiday'
          WHERE work_date = ?
            AND employee_id IN (${scope.map(() => '?').join(', ')})
            AND clock_in_utc IS NULL`,
        [workDate, ...scope],
      );
      changed = (res as unknown as { affectedRows: number }).affectedRows ?? 0;
    }

    await query(
      `INSERT INTO holiday_observances (holiday_id, location_id, is_observed, leave_record_id, decided_by)
       VALUES (?, ?, TRUE, ?, ?)
       ON DUPLICATE KEY UPDATE is_observed = TRUE, leave_record_id = VALUES(leave_record_id), decided_by = VALUES(decided_by)`,
      [holidayId, locationId, leaveRecordId, actorId],
    );
  } else {
    // Un-observe: drop the leave_records row, then put the attendance rows back.
    const obs = await queryOne<{ leave_record_id: number | null }>(
      `SELECT leave_record_id FROM holiday_observances
        WHERE holiday_id = ? AND ((location_id IS NULL AND ? IS NULL) OR location_id = ?)
        LIMIT 1`,
      [holidayId, locationId, locationId],
    );

    // Delete by predicate rather than only the linked id: if a duplicate row
    // ever exists for the same date and location, deleting just the one we
    // recorded would silently leave the holiday in force.
    void obs; // the link is kept for the audit trail, not for the delete
    await query(
      `DELETE FROM leave_records
        WHERE employee_id IS NULL AND leave_date = ? AND leave_type = 'holiday'
          AND ((location_id IS NULL AND ? IS NULL) OR location_id = ?)`,
      [workDate, locationId, locationId],
    );

    // Revert only rows this holiday could have set: no clock-in, still
    // 'holiday', and a working day for that employee's shift. The working-day
    // test is what stops a Sunday week-off being turned into an absence.
    if (scope.length > 0) {
      const abbr = weekdayAbbr(workDate);
      const res = await query(
        `UPDATE attendance a
           JOIN employees e ON e.id = a.employee_id
           JOIN employee_schedules es
             ON  es.employee_id = e.id
             AND es.effective_from <= ?
             AND (es.effective_to IS NULL OR es.effective_to >= ?)
           JOIN shifts s ON s.id = es.shift_id
            SET a.status = 'absent'
          WHERE a.work_date = ?
            AND a.employee_id IN (${scope.map(() => '?').join(', ')})
            AND a.clock_in_utc IS NULL
            AND a.status = 'holiday'
            AND JSON_CONTAINS(s.working_days, JSON_QUOTE(?))`,
        [workDate, workDate, workDate, ...scope, abbr],
      );
      changed = (res as unknown as { affectedRows: number }).affectedRows ?? 0;
    }

    await query(
      `INSERT INTO holiday_observances (holiday_id, location_id, is_observed, leave_record_id, decided_by)
       VALUES (?, ?, FALSE, NULL, ?)
       ON DUPLICATE KEY UPDATE is_observed = FALSE, leave_record_id = NULL, decided_by = VALUES(decided_by)`,
      [holidayId, locationId, actorId],
    );
  }

  await insertAuditLog({
    action: isObserved ? 'holiday_observed' : 'holiday_unobserved',
    entity: 'holiday',
    entity_id: holidayId,
    performed_by: actorId,
    ip_address: ip ?? null,
    details: {
      holiday_name: holiday.name,
      work_date: workDate,
      location_id: locationId,
      employees_in_scope: scope.length,
      attendance_rows_changed: changed,
      date_confirmed: confirmedDate ?? null,
    },
  });

  return {
    holiday_id: holidayId,
    holiday_name: holiday.name,
    holiday_date: workDate,
    location_id: locationId,
    is_observed: isObserved,
    employees_in_scope: scope.length,
    attendance_rows_changed: changed,
  };
}

/** Add a holiday by hand — for a festival the bundled list does not carry. */
export async function addManualHoliday(args: {
  date: string;
  name: string;
  type?: HolidayType;
  stateCode?: string | null;
  notes?: string | null;
  actorId: number;
}): Promise<number> {
  if (!YMD.test(args.date)) throw new HolidayError('Date must be YYYY-MM-DD.');
  if (!args.name.trim()) throw new HolidayError('A name is required.');

  const res = await query(
    `INSERT INTO holiday_calendar
       (year, holiday_date, name, holiday_type, state_code, needs_verification, source, notes)
     VALUES (?, ?, ?, ?, ?, FALSE, 'manual', ?)
     ON DUPLICATE KEY UPDATE notes = VALUES(notes)`,
    [
      Number(args.date.slice(0, 4)),
      args.date,
      args.name.trim(),
      args.type ?? 'company',
      args.stateCode ?? null,
      args.notes ?? null,
    ],
  );

  const id = (res as unknown as { insertId: number }).insertId ?? 0;

  await insertAuditLog({
    action: 'holiday_added',
    entity: 'holiday',
    entity_id: id || null,
    performed_by: args.actorId,
    details: { date: args.date, name: args.name, type: args.type ?? 'company' },
  });

  return id;
}

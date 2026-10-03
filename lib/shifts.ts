import { query } from '@/lib/db';
import { REQUIRED_SHIFT_MINUTES, WEEKLY_OFF_DAYS } from '@/lib/constants';

// ---------------------------------------------------------------------------
// A day resolves to a LIST of shifts, not one.
//
// employee_schedules has no unique key, so an employee may hold several rows in
// force at once — that is exactly how a double shift is expressed: assign a
// morning shift AND an evening shift. Nothing changes for anyone with a single
// assignment; "one shift" is simply a list of one.
//
// Every query used to take `ORDER BY effective_from DESC LIMIT 1`, which
// silently used whichever row was created last and ignored the second shift.
// These helpers replace that so hours, working days and lateness all account
// for every shift the employee is rostered on.
// ---------------------------------------------------------------------------

export interface DayShift {
  schedule_id: number;
  shift_id: number;
  name: string;
  type: string;
  start_time: string | null;
  end_time: string | null;
  required_hours: number | string | null;
  grace_minutes: number;
  working_days: string[] | null;
  location_id: number | null;
  geofencing_enabled: boolean;
}

/** Length of one shift in minutes, wrapping past midnight. */
export function shiftMinutes(shift: {
  required_hours?: number | string | null;
  start_time?: string | null;
  end_time?: string | null;
}): number | null {
  if (shift.required_hours != null) {
    const hours = Number(shift.required_hours);
    if (Number.isFinite(hours) && hours > 0) return Math.round(hours * 60);
  }
  if (shift.start_time && shift.end_time) {
    const toMin = (t: string) => {
      const m = t.match(/^(\d{1,2}):(\d{2})/);
      return m ? Number(m[1]) * 60 + Number(m[2]) : null;
    };
    const s = toMin(shift.start_time);
    const e = toMin(shift.end_time);
    if (s !== null && e !== null) {
      const span = ((e - s) % 1440 + 1440) % 1440;
      if (span > 0) return span;
    }
  }
  return null;
}

/**
 * The same shift assigned twice is ONE shift, not a double shift.
 *
 * employee_schedules has no unique key, and a back-dated assignment does not
 * expire a row that starts on the same day or later — so an employee can end up
 * holding two rows pointing at the same shift. Under the old LIMIT 1 that was
 * harmless; summing would silently double their hours. A genuine double shift
 * means two DIFFERENT shifts.
 */
function dedupeByShift(shifts: DayShift[]): DayShift[] {
  const seen = new Set<number>();
  return shifts.filter(s => (seen.has(s.shift_id) ? false : (seen.add(s.shift_id), true)));
}

/** Every distinct shift in force for an employee on a date, earliest start first. */
export async function shiftsForDay(employeeId: number, workDate: string): Promise<DayShift[]> {
  const rows = await query<DayShift & { working_days: unknown }>(
    `SELECT es.id AS schedule_id, s.id AS shift_id, s.name, s.type,
            s.start_time, s.end_time, s.required_hours, s.grace_minutes,
            s.working_days, es.location_id, es.geofencing_enabled
     FROM employee_schedules es
     JOIN shifts s ON s.id = es.shift_id
     WHERE es.employee_id = ?
       AND es.effective_from <= ?
       AND (es.effective_to IS NULL OR es.effective_to >= ?)
     ORDER BY COALESCE(s.start_time, '00:00:00') ASC, es.id ASC`,
    [employeeId, workDate, workDate],
  );
  return dedupeByShift(rows.map(r => ({
    ...r,
    working_days: parseDays(r.working_days),
  })));
}

/** mysql2 hands back JSON columns as a value or a string depending on driver mode. */
function parseDays(value: unknown): string[] | null {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
  }
  return null;
}

/**
 * All in-force shifts for many employees at once, keyed by employee id.
 * Reports need this per employee; doing it as one query beats threading extra
 * joins (and their parameters) through the big aggregate statements.
 */
export async function shiftsForEmployees(
  employeeIds: number[],
  onDate: string,
): Promise<Map<number, DayShift[]>> {
  const out = new Map<number, DayShift[]>();
  if (!employeeIds.length) return out;

  const rows = await query<DayShift & { employee_id: number; working_days: unknown }>(
    `SELECT es.employee_id, es.id AS schedule_id, s.id AS shift_id, s.name, s.type,
            s.start_time, s.end_time, s.required_hours, s.grace_minutes,
            s.working_days, es.location_id, es.geofencing_enabled
     FROM employee_schedules es
     JOIN shifts s ON s.id = es.shift_id
     WHERE es.employee_id IN (${employeeIds.map(() => '?').join(',')})
       AND es.effective_from <= ?
       AND (es.effective_to IS NULL OR es.effective_to >= ?)
     ORDER BY COALESCE(s.start_time, '00:00:00') ASC, es.id ASC`,
    [...employeeIds, onDate, onDate],
  );

  for (const r of rows) {
    const shift: DayShift = { ...r, working_days: parseDays(r.working_days) };
    const list = out.get(r.employee_id);
    if (list) list.push(shift);
    else out.set(r.employee_id, [shift]);
  }
  for (const [id, list] of out) out.set(id, dedupeByShift(list));
  return out;
}

/** Total minutes rostered across every shift; null when there are none. */
export function totalShiftMinutes(shifts: DayShift[] | undefined): number | null {
  if (!shifts?.length) return null;
  let total = 0;
  for (const s of shifts) total += shiftMinutes(s) ?? REQUIRED_SHIFT_MINUTES;
  return total;
}

/** Length of one shift, in SQL, over an aliased `shifts` row. */
const shiftLengthSql = (alias: string) => `COALESCE(
  ${alias}.required_hours * 60,
  IF(${alias}.start_time IS NOT NULL AND ${alias}.end_time IS NOT NULL,
     NULLIF(MOD(TIME_TO_SEC(TIMEDIFF(${alias}.end_time, ${alias}.start_time)) / 60 + 1440, 1440), 0),
     NULL),
  ${REQUIRED_SHIFT_MINUTES}
)`;

/**
 * Shift ids in force for the employee on the date.
 *
 * `IN (...)` rather than a join so two schedule rows pointing at the SAME shift
 * collapse to one — see dedupeByShift().
 *
 * With `onlyThisWeekday`, a shift only counts on the weekdays it actually works,
 * so a Mon-Fri shift plus a Saturday-only shift asks for 8h on a Tuesday and 4h
 * on a Saturday — not 12h on both. ELT/DAYOFWEEK rather than DATE_FORMAT('%a')
 * so the abbreviation never depends on the server's lc_time_names.
 */
function scheduledShiftIds(
  empColumn: string,
  dateColumn: string,
  onlyThisWeekday: boolean,
): string {
  const weekday = `ELT(DAYOFWEEK(${dateColumn}), 'Sun','Mon','Tue','Wed','Thu','Fri','Sat')`;
  return `SELECT es_r.shift_id
          FROM employee_schedules es_r
          ${onlyThisWeekday ? 'JOIN shifts s_w ON s_w.id = es_r.shift_id' : ''}
          WHERE es_r.employee_id = ${empColumn}
            AND es_r.effective_from <= ${dateColumn}
            AND (es_r.effective_to IS NULL OR es_r.effective_to >= ${dateColumn})
            ${onlyThisWeekday
              ? `AND (s_w.working_days IS NULL
                      OR JSON_CONTAINS(s_w.working_days, JSON_QUOTE(${weekday})))`
              : ''}`;
}

/**
 * SQL scalar subquery: minutes the employee is rostered for on a day, summed
 * across every distinct shift that works that weekday. A double-shift employee
 * gets both lengths; a single-shift employee is unchanged.
 *
 * Zero when they are scheduled but the day isn't one they work (a Sunday
 * call-in then credits the hours actually worked, and demands nothing).
 * Falls back to the standard shift only when there is no schedule at all.
 */
export function dayRequiredMinutesSelect(empColumn: string, dateColumn: string): string {
  return `COALESCE(
    (SELECT SUM(${shiftLengthSql('s_r')}) FROM shifts s_r
      WHERE s_r.id IN (${scheduledShiftIds(empColumn, dateColumn, true)})),
    IF(EXISTS (${scheduledShiftIds(empColumn, dateColumn, false)}),
       0, ${REQUIRED_SHIFT_MINUTES})
  )`;
}

/** Same, but NULL (not a fallback) when the employee has no schedule — used by
 *  reports, which say "No shift" rather than inventing an expectation. */
export function dayRequiredMinutesOrNullSelect(empColumn: string, dateColumn: string): string {
  return `IF(EXISTS (${scheduledShiftIds(empColumn, dateColumn, false)}),
             COALESCE((SELECT SUM(${shiftLengthSql('s_r')}) FROM shifts s_r
                        WHERE s_r.id IN (${scheduledShiftIds(empColumn, dateColumn, true)})), 0),
             NULL)`;
}

/**
 * The shift a clock-in belongs to: the one whose window contains it, else the
 * one starting nearest. Without this a double-shift employee arriving for the
 * evening shift would be judged late against the morning start.
 */
export function shiftForClockIn(shifts: DayShift[], clockInHHMM: string): DayShift | null {
  if (!shifts.length) return null;
  const toMin = (t: string) => {
    const m = t.match(/^(\d{1,2}):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const at = toMin(clockInHHMM);
  if (at === null) return shifts[0];

  let best: DayShift | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const s of shifts) {
    if (!s.start_time) continue;
    const start = toMin(s.start_time);
    if (start === null) continue;
    const len = shiftMinutes(s) ?? REQUIRED_SHIFT_MINUTES;
    // Inside the window (including the stretch past midnight) — a definite match.
    const offset = ((at - start) % 1440 + 1440) % 1440;
    if (offset <= len) return s;
    // Otherwise remember the closest start in either direction.
    const distance = Math.min(offset, 1440 - offset);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = s;
    }
  }
  return best ?? shifts[0];
}

/** Union of the weekdays worked across all the employee's shifts. */
export function workingWeekdays(shifts: DayShift[]): string[] | null {
  const withDays = shifts.filter(s => s.working_days?.length);
  if (!withDays.length) return null;
  const set = new Set<string>();
  for (const s of withDays) for (const d of s.working_days!) set.add(d);
  return [...set];
}

const ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Minutes rostered on one weekday: only the shifts that work it. */
export function minutesOnWeekday(shifts: DayShift[], abbr: string): number {
  const defaultDays = ABBR.filter(d => !WEEKLY_OFF_DAYS.includes(d));
  let total = 0;
  for (const s of shifts) {
    const days = s.working_days?.length ? s.working_days : defaultDays;
    if (days.includes(abbr)) total += shiftMinutes(s) ?? REQUIRED_SHIFT_MINUTES;
  }
  return total;
}

/**
 * Expected minutes over a period, counted weekday by weekday.
 *
 * Summing every shift and multiplying by the union of their working days
 * over-counts the moment two shifts differ: a Mon-Fri 8h plus a Saturday-only
 * 4h would charge 12h on all 26 days instead of 8h on weekdays and 4h on
 * Saturdays. When both shifts share the same days — the ordinary double shift —
 * this returns exactly perDay × workingDays, as before.
 */
export function expectedMinutesFor(
  shifts: DayShift[],
  counts: number[],
  holidays: string[],
): number {
  let total = 0;
  for (let i = 0; i < 7; i++) total += minutesOnWeekday(shifts, ABBR[i]) * counts[i];
  // A company holiday removes whatever that weekday would have required.
  for (const h of holidays) {
    const dow = new Date(`${h}T00:00:00Z`).getUTCDay();
    total -= minutesOnWeekday(shifts, ABBR[dow]);
  }
  return Math.max(0, total);
}

/** True when the shifts don't all work the same weekdays, so there is no single
 *  "hours per day" figure to show. */
export function hasMixedWorkingDays(shifts: DayShift[]): boolean {
  if (shifts.length < 2) return false;
  const key = (s: DayShift) => [...(s.working_days ?? [])].sort().join(',');
  const first = key(shifts[0]);
  return shifts.some(s => key(s) !== first);
}

/**
 * Pairs of shifts whose clock windows overlap — 09:00-18:00 and 10:00-14:00
 * cannot both be worked, so their sum is not a real expectation. A genuine
 * double shift (morning then evening) never overlaps; this is a misconfiguration
 * worth surfacing rather than silently inflating someone's target.
 */
export function overlappingShiftNames(shifts: DayShift[]): string[] {
  const spans = shifts
    .filter(s => s.start_time)
    .map(s => {
      const m = s.start_time!.match(/^(\d{1,2}):(\d{2})/);
      const start = m ? Number(m[1]) * 60 + Number(m[2]) : 0;
      return { name: s.name, days: s.working_days, start, len: shiftMinutes(s) ?? REQUIRED_SHIFT_MINUTES };
    });

  const clash = new Set<string>();
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i], b = spans[j];
      // Only a clash if they can fall on the same day.
      const sharedDay = !a.days?.length || !b.days?.length || a.days.some(d => b.days!.includes(d));
      if (!sharedDay) continue;
      // Both windows recur daily, so compare them on a 24h circle: they clash if
      // either one's start falls inside the other's run (covers past-midnight).
      const offset = ((b.start - a.start) % 1440 + 1440) % 1440;
      const bStartsInsideA = offset < a.len;
      const aStartsInsideB = ((1440 - offset) % 1440) < b.len;
      if (bStartsInsideA || aStartsInsideB) { clash.add(a.name); clash.add(b.name); }
    }
  }
  return [...clash];
}

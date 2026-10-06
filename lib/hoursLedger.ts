import { query, queryOne } from '@/lib/db';
import { STANDARD_MONTHLY_MINUTES } from '@/lib/constants';
import { toYmd } from '@/lib/date';
import { istToday } from '@/lib/chat/dates';
import { lockFor, type MonthClosure } from '@/lib/monthClose';
import { breakMinutes, lateMinutes } from '@/lib/attendance';
import { hasOnDutyColumn, hasPermissionTable, timeOffOnly } from '@/lib/permissions';
import { hasFirstClockInColumn } from '@/lib/employeeDetails';
import { companyHolidays, parseWorkingDays } from '@/lib/workingDays';
import { fetchLocationHolidays } from '@/lib/reportClassification';
import {
  minutesOnWeekday,
  shiftForClockIn,
  shiftMinutes,
  shiftRequiredMinutes,
  type DayShift,
} from '@/lib/shifts';

// ---------------------------------------------------------------------------
// The hours ledger: one employee, one period, day by day, with the shortage
// stated rather than left for the reader to work out.
//
// WHY THIS EXISTS
// ---------------
// Every operand needed to answer "is this person short this month, and by how
// much" was already in the app — `expected_minutes` and `total_minutes_credited`
// in lib/reportSummary.ts. The subtraction was never done anywhere, and no view
// broke the month down by day, so a short day was invisible inside a monthly
// total.
//
// It is ONE module because the figure has to survive being quoted in four
// places: the statement on screen, the Excel export, the PDF, and the
// assistant's answer. Four implementations would mean four numbers, and the
// first person to notice would be an employee disputing their pay. The same
// reasoning is written at the top of lib/reportSummary.ts, which exists so the
// screen and the Excel export compute the aggregate the same way; this module
// extends that to the per-day view.
//
// WHAT IT DOES NOT DO
// -------------------
// No writes, no salary figures, and no opinion about pay. It reports hours
// required, hours delivered, and the gap, with every component of the gap
// itemised so the reader can see what is leave, what is a holiday, what is a
// week off, and what is genuinely unworked.
// ---------------------------------------------------------------------------

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * What kind of day it was, independent of whether anybody clocked in.
 *
 * 'future' is a working day that has not happened yet. Without it, opening the
 * current month showed every remaining day as a full 9h shortfall — on the 6th
 * of October that was 22 days short and 185h unworked, for a month six days
 * old. A day nobody could have worked yet cannot be a shortage.
 */
export type DayKind = 'working' | 'week_off' | 'holiday' | 'leave' | 'future';

export interface LedgerDay {
  /** YYYY-MM-DD */
  date: string;
  weekday: string;
  kind: DayKind;
  /** The holiday's name, or the leave type — why the day asked for nothing. */
  kind_label: string | null;
  /** attendance.status, or null when no row exists for the day at all. */
  status: string | null;
  clock_in_utc: string | null;
  clock_out_utc: string | null;
  sessions: number;
  /** Null when the employee has no roster covering this day. */
  required_minutes: number | null;
  worked_minutes: number | null;
  /** Derived: time between first clock-in and last clock-out that was not worked. */
  break_minutes: number | null;
  permission_minutes: number;
  /** Worked + approved permission, never credited beyond the day's requirement. */
  credited_minutes: number;
  /** Required less credited, floored at zero. Always 0 on a non-working day. */
  shortage_minutes: number;
  /** Credited beyond the requirement. */
  overtime_minutes: number;
  late_minutes: number | null;
  /** True when the day is still open — the figures are provisional. */
  open: boolean;
  notes: string | null;
}

export interface LedgerPolicy {
  /** Minutes of unpaid break deducted per day, or null when no shift sets one. */
  unpaid_break_minutes: number | null;
  /** The clock window, before any break deduction. */
  gross_minutes_per_day: number | null;
  /** What the roster actually asks for, after the deduction. */
  net_minutes_per_day: number | null;
  shift_names: string[];
  /** True when shifts disagree on working days, so there is no single per-day figure. */
  mixed: boolean;
}

/**
 * Why an employee is or is not counted in rankings.
 *
 * `excluded` — an admin or management role, or nobody has rostered them, so no
 * expectation can be computed. Per the operator's rule: management "will work
 * or not work", so holding them to rostered hours is meaningless.
 * `dormant`  — rostered, but not a single clock-in in the period. Kept visible
 * in its own group rather than topping the shortage ranking, where seven
 * departed or unstarted employees would bury the people who actually need
 * attention.
 */
export type LedgerStanding = 'counted' | 'dormant' | 'excluded';

export interface LedgerTotals {
  calendar_days: number;
  /** Working days that have ALREADY happened — the basis for every comparison. */
  working_days: number;
  /**
   * Working days in the whole period, including ones still to come. For a past
   * month this equals `working_days`; for the current month it is larger.
   */
  scheduled_working_days: number;
  /** Working days still in the future. */
  future_days: number;
  week_off_days: number;
  holiday_days: number;
  leave_days: number;
  days_present: number;
  days_late: number;
  days_absent: number;
  /** Days with a requirement where something was clocked. */
  days_worked: number;
  /** Days with a requirement that fell short of it. */
  days_short: number;
  /** Required over the days that have happened. Shortage is measured against this. */
  required_minutes: number;
  /** Required over the WHOLE period, future days included. */
  scheduled_minutes: number;
  worked_minutes: number;
  break_minutes: number;
  permission_minutes: number;
  credited_minutes: number;
  /**
   * Sum of the per-day shortfalls — hours owed on the days that fell short,
   * with no credit for long days elsewhere. This is the attendance-discipline
   * figure: it answers "how much time went unworked on days that asked for it".
   */
  shortage_minutes: number;
  overtime_minutes: number;
  /**
   * Credited less required across the whole period, signed. Negative means
   * short on the month; positive means ahead.
   *
   * Deliberately separate from `shortage_minutes`, because the two genuinely
   * disagree and both are wanted. Measured in September 2026: KADALI worked
   * 318h against a 225h requirement but missed one full Monday, so his daily
   * shortfall is 9h while his monthly net is 93h AHEAD. Reporting only the
   * first would call the hardest worker in the company short; reporting only
   * the second would hide a missed day behind unrelated overtime.
   */
  net_minutes: number;
  late_minutes: number;
  /** The figure the assistant could not previously produce. Null with no worked days. */
  avg_worked_minutes_per_day: number | null;
  /** Shortest and longest worked day, for spotting half-days and marathons. */
  shortest_day: { date: string; minutes: number } | null;
  longest_day: { date: string; minutes: number } | null;
  /** True when any day in the period is still open, so totals may still move. */
  has_open_days: boolean;
}

export interface HoursLedger {
  employee: {
    id: number;
    emp_id: string;
    name: string;
    department: string | null;
    role: string;
    is_active: boolean;
  };
  period: { from_date: string; to_date: string; label: string };
  policy: LedgerPolicy;
  standing: LedgerStanding;
  standing_reason: string | null;
  totals: LedgerTotals;
  /** The company-wide monthly norm, for sanity-checking the roster figure. */
  standard: {
    stated_minutes: number;
    roster_minutes: number;
    /** Difference between what the roster asks and the stated norm. */
    difference_minutes: number;
  };
  /**
   * The closure locking this period, if any. Non-null means the figures are
   * final: they were reviewed and signed off, and cannot change without the
   * month being reopened on the record.
   */
  closure: MonthClosure | null;
  days: LedgerDay[];
  /** Anything the reader needs to know before trusting the numbers. */
  warnings: string[];
}

/** Every date from `from` to `to` inclusive. */
function eachDate(from: string, to: string, cap = 400): string[] {
  const out: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return out;
  for (let t = start; t <= end && out.length < cap; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

function periodLabel(from: string, to: string): string {
  const fmt = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
    });
  if (from === to) return fmt(from);
  // A whole calendar month reads better as "September 2026".
  const [fy, fm, fd] = from.split('-');
  const [ty, tm, td] = to.split('-');
  if (fy === ty && fm === tm && fd === '01') {
    const last = new Date(Date.UTC(Number(ty), Number(tm), 0)).getUTCDate();
    if (Number(td) === last) {
      return new Date(`${from}T00:00:00Z`).toLocaleDateString('en-IN', {
        month: 'long', year: 'numeric', timeZone: 'UTC',
      });
    }
  }
  return `${fmt(from)} – ${fmt(to)}`;
}

interface ScheduleRow extends Omit<DayShift, 'working_days'> {
  effective_from: Date | string;
  effective_to: Date | string | null;
  working_days: unknown;
}

export interface LedgerParams {
  employeeId: number;
  fromDate: string;
  toDate: string;
}

/**
 * Build the ledger for one employee over one period.
 *
 * Walks the calendar rather than the attendance rows: a day nobody clocked in
 * is exactly the day a shortage report is about, and iterating the rows would
 * skip it. This is the same reason app/api/reports/daily/route.ts walks the
 * calendar.
 */
export async function buildHoursLedger(params: LedgerParams): Promise<HoursLedger | null> {
  const { employeeId, fromDate, toDate } = params;

  const employee = await queryOne<{
    id: number; emp_id: string; name: string;
    department: string | null; role: string; is_active: number;
  }>(
    `SELECT id, emp_id, name, department, role, is_active
       FROM employees WHERE id = ?`,
    [employeeId],
  );
  if (!employee) return null;

  const [permissionsAvailable, hasType, firstInCol] = await Promise.all([
    hasPermissionTable(),
    hasOnDutyColumn(),
    hasFirstClockInColumn(),
  ]);

  const [schedules, attendance, permissions, leaves, holidayNames] = await Promise.all([
    // Every schedule overlapping the period, so a mid-month shift change is
    // honoured day by day instead of the whole month taking the latest shift.
    query<ScheduleRow>(
      `SELECT es.id AS schedule_id, es.effective_from, es.effective_to,
              es.location_id, es.geofencing_enabled,
              s.id AS shift_id, s.name, s.type, s.start_time, s.end_time,
              s.required_hours, s.unpaid_break_minutes, s.grace_minutes, s.working_days
         FROM employee_schedules es
         JOIN shifts s ON s.id = es.shift_id
        WHERE es.employee_id = ?
          AND es.effective_from <= ?
          AND (es.effective_to IS NULL OR es.effective_to >= ?)
        ORDER BY COALESCE(s.start_time, '00:00:00') ASC, es.id ASC`,
      [employeeId, toDate, fromDate],
    ),
    query<{
      work_date: Date | string; status: string;
      clock_in_utc: Date | null; clock_out_utc: Date | null;
      first_clock_in_utc: Date | null;
      total_minutes: number | null; banked_minutes: number;
      session_count: number; notes: string | null;
    }>(
      `SELECT a.work_date, a.status, a.clock_in_utc, a.clock_out_utc,
              ${firstInCol ? 'a.first_clock_in_utc' : 'NULL AS first_clock_in_utc'},
              a.total_minutes, a.banked_minutes, a.session_count, a.notes
         FROM attendance a
        WHERE a.employee_id = ?
          AND a.work_date BETWEEN ? AND ?
        ORDER BY a.work_date ASC`,
      [employeeId, fromDate, toDate],
    ),
    permissionsAvailable
      ? query<{ permission_date: Date | string; minutes: number }>(
          `SELECT pr.permission_date, SUM(pr.minutes) AS minutes
             FROM permission_requests pr
            WHERE pr.employee_id = ?
              AND pr.status = 'approved'
              ${timeOffOnly(hasType, 'pr')}
              AND pr.permission_date BETWEEN ? AND ?
            GROUP BY pr.permission_date`,
          [employeeId, fromDate, toDate],
        )
      : Promise.resolve([]),
    query<{ leave_date: Date | string; leave_type: string; notes: string | null }>(
      `SELECT lr.leave_date, lr.leave_type, lr.notes
         FROM leave_records lr
        WHERE lr.employee_id = ?
          AND lr.leave_date BETWEEN ? AND ?`,
      [employeeId, fromDate, toDate],
    ),
    // Holiday names, for saying WHICH holiday rather than just "holiday".
    query<{ holiday_date: Date | string; name: string }>(
      `SELECT hc.holiday_date, hc.name
         FROM holiday_calendar hc
         JOIN holiday_observances ho ON ho.holiday_id = hc.id
        WHERE ho.is_observed = TRUE
          AND hc.holiday_date BETWEEN ? AND ?`,
      [fromDate, toDate],
    ).catch(() => []),
  ]);

  // Company-wide holidays, plus any declared for this employee's own site.
  // fetchLocationHolidays resolves the site from the employee's schedule and
  // keys its result BY EMPLOYEE, so a one-site holiday never leaks to everyone —
  // the bug that had all seven employees observing a single site's holiday.
  const [companyList, locationMap] = await Promise.all([
    companyHolidays(fromDate, toDate),
    fetchLocationHolidays(fromDate, toDate).catch(() => new Map<number, Set<string>>()),
  ]);
  const holidays = new Set<string>([
    ...companyList,
    ...(locationMap.get(employeeId) ?? []),
  ]);
  const holidayNameByDate = new Map(holidayNames.map(h => [toYmd(h.holiday_date), h.name]));

  const attendanceByDate = new Map(attendance.map(a => [toYmd(a.work_date), a]));
  const permissionByDate = new Map(permissions.map(p => [toYmd(p.permission_date), Number(p.minutes)]));
  const leaveByDate = new Map(leaves.map(l => [toYmd(l.leave_date), l]));

  /** Schedules in force on a given date, deduped by shift. */
  function shiftsOn(date: string): DayShift[] {
    const seen = new Set<number>();
    const out: DayShift[] = [];
    for (const s of schedules) {
      const from = toYmd(s.effective_from);
      const to = s.effective_to ? toYmd(s.effective_to) : null;
      // A row whose window is inverted (effective_to before effective_from) is
      // a misconfiguration; this test naturally excludes it, as the rest of the
      // app does. check-status.sql reports those rows.
      if (from > date) continue;
      if (to && to < date) continue;
      if (seen.has(s.shift_id)) continue;
      seen.add(s.shift_id);
      out.push({ ...s, working_days: parseWorkingDays(s.working_days) } as DayShift);
    }
    return out;
  }

  const days: LedgerDay[] = [];
  const t: LedgerTotals = {
    calendar_days: 0, working_days: 0, scheduled_working_days: 0, future_days: 0,
    week_off_days: 0, holiday_days: 0, leave_days: 0,
    days_present: 0, days_late: 0, days_absent: 0, days_worked: 0, days_short: 0,
    required_minutes: 0, scheduled_minutes: 0, worked_minutes: 0, break_minutes: 0, permission_minutes: 0,
    credited_minutes: 0, shortage_minutes: 0, overtime_minutes: 0, net_minutes: 0, late_minutes: 0,
    avg_worked_minutes_per_day: null, shortest_day: null, longest_day: null,
    has_open_days: false,
  };

  // Anything after today in IST has not happened yet — see DayKind 'future'.
  const today = istToday();

  const dates = eachDate(fromDate, toDate);
  t.calendar_days = dates.length;

  for (const date of dates) {
    const weekday = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
    const shifts = shiftsOn(date);
    const row = attendanceByDate.get(date) ?? null;
    const leave = leaveByDate.get(date) ?? null;
    const permission = permissionByDate.get(date) ?? 0;

    // Rostered minutes for THIS weekday — zero when the shift does not work it.
    const rosteredToday = shifts.length ? minutesOnWeekday(shifts, weekday) : null;

    // What kind of day is it? Order matters: a holiday that lands on a week off
    // is a week off (it was never going to be worked), and declared leave beats
    // the attendance row's own status, which lib/chat trusts `day_type` over.
    let kind: DayKind;
    let kindLabel: string | null = null;
    if (holidays.has(date) && rosteredToday !== 0) {
      kind = 'holiday';
      kindLabel = holidayNameByDate.get(date) ?? 'Company holiday';
    } else if (rosteredToday === 0 || (shifts.length === 0 && weekday === 'Sun')) {
      kind = 'week_off';
      kindLabel = 'Week off';
    } else if (leave && leave.leave_type !== 'holiday') {
      kind = 'leave';
      kindLabel = `${leave.leave_type} leave`;
    } else if (row?.status === 'leave') {
      kind = 'leave';
      kindLabel = 'Leave';
    } else if (date > today) {
      // A working day that has not arrived yet. It is still scheduled — it
      // counts towards what the month will ask for — but nobody can be short
      // of hours they have not had the chance to work.
      kind = 'future';
      kindLabel = 'Not yet';
    } else {
      kind = 'working';
    }

    // Only a working day that has already happened demands anything. A holiday,
    // week off, approved leave or future date asks for nothing, so none of them
    // can produce a shortage — the bug this whole exercise started from was a
    // Sunday counted as a missed holiday.
    const required = kind === 'working'
      ? (shifts.length ? (rosteredToday ?? 0) : null)
      : 0;

    const worked = row?.total_minutes == null ? null : Number(row.total_minutes);
    const open = Boolean(row?.clock_in_utc && !row?.clock_out_utc);

    const brk = row
      ? breakMinutes(
          row.first_clock_in_utc ? new Date(row.first_clock_in_utc) : null,
          row.clock_in_utc ? new Date(row.clock_in_utc) : null,
          row.clock_out_utc ? new Date(row.clock_out_utc) : null,
          worked,
          Number(row.banked_minutes ?? 0),
        )
      : null;

    // Credit worked time plus approved permission, but never past the day's
    // requirement: permission covers an absence, it does not earn overtime.
    const credited = required == null
      ? (worked ?? 0)
      : Math.min((worked ?? 0) + permission, Math.max(worked ?? 0, required));

    const shortage = required == null || required === 0
      ? 0
      : Math.max(0, required - credited);
    const overtime = required == null || required === 0
      ? Math.max(0, worked ?? 0)
      : Math.max(0, credited - required);

    let late: number | null = null;
    if (row?.clock_in_utc && shifts.length) {
      const firstIn = new Date(row.first_clock_in_utc ?? row.clock_in_utc);
      const hhmm = firstIn.toISOString().slice(11, 16);
      const matched = shiftForClockIn(shifts, hhmm) ?? shifts[0];
      late = lateMinutes(firstIn, matched.start_time, matched.grace_minutes, matched.type);
    }

    days.push({
      date, weekday, kind, kind_label: kindLabel,
      status: row?.status ?? null,
      // The FIRST clock-in of the day, not the last.
      //
      // On a multi-session day `clock_in_utc` holds the most recent session's
      // start, so showing it made rows self-contradictory: Reena on 1 Oct read
      // "in 06:08 pm, out 06:40 pm, worked 7h 54m" when she actually started at
      // 09:53 am. `first_clock_in_utc` is the start of the day, which is what a
      // day row means by "in" — the same COALESCE the daily report uses.
      clock_in_utc: row?.first_clock_in_utc
        ? new Date(row.first_clock_in_utc).toISOString()
        : row?.clock_in_utc ? new Date(row.clock_in_utc).toISOString() : null,
      clock_out_utc: row?.clock_out_utc ? new Date(row.clock_out_utc).toISOString() : null,
      sessions: Number(row?.session_count ?? 0),
      required_minutes: required,
      worked_minutes: worked,
      break_minutes: brk,
      permission_minutes: permission,
      credited_minutes: credited,
      shortage_minutes: shortage,
      overtime_minutes: overtime,
      late_minutes: late,
      open,
      notes: row?.notes ?? null,
    });

    // Totals
    if (kind === 'working') t.working_days += 1;
    if (kind === 'future') t.future_days += 1;
    // Scheduled covers the whole period: days worked so far AND days still to
    // come, so "the month asks 216h" stays true on the 6th of the month.
    if (kind === 'working' || kind === 'future') {
      t.scheduled_working_days += 1;
      t.scheduled_minutes += shifts.length ? (rosteredToday ?? 0) : 0;
    }
    if (kind === 'week_off') t.week_off_days += 1;
    if (kind === 'holiday') t.holiday_days += 1;
    if (kind === 'leave') t.leave_days += 1;
    if (row?.status === 'present') t.days_present += 1;
    if (row?.status === 'late') t.days_late += 1;
    if (row?.status === 'absent' && kind === 'working') t.days_absent += 1;
    if (open) t.has_open_days = true;

    t.required_minutes += required ?? 0;
    t.worked_minutes += worked ?? 0;
    t.break_minutes += brk ?? 0;
    t.permission_minutes += permission;
    t.credited_minutes += credited;
    t.shortage_minutes += shortage;
    t.overtime_minutes += overtime;
    t.late_minutes += late ?? 0;

    if (worked != null && worked > 0) {
      t.days_worked += 1;
      if (!t.shortest_day || worked < t.shortest_day.minutes) t.shortest_day = { date, minutes: worked };
      if (!t.longest_day || worked > t.longest_day.minutes) t.longest_day = { date, minutes: worked };
    }
    if (shortage > 0) t.days_short += 1;
  }

  t.net_minutes = t.credited_minutes - t.required_minutes;

  t.avg_worked_minutes_per_day = t.days_worked > 0
    ? Math.round(t.worked_minutes / t.days_worked)
    : null;

  // Policy, described from the shifts in force at the end of the period.
  const endShifts = shiftsOn(toDate);
  const grossPerDay = endShifts.length
    ? endShifts.reduce((sum, s) => sum + (shiftMinutes(s) ?? 0), 0)
    : null;
  const netPerDay = endShifts.length
    ? endShifts.reduce((sum, s) => sum + (shiftRequiredMinutes(s) ?? 0), 0)
    : null;
  const breakPolicy = endShifts.reduce<number | null>((acc, s) => {
    const v = s.unpaid_break_minutes;
    return v == null ? acc : (acc ?? 0) + Number(v);
  }, null);
  const dayKeys = endShifts.map(s => [...(s.working_days ?? [])].sort().join(','));
  const policy: LedgerPolicy = {
    unpaid_break_minutes: breakPolicy,
    gross_minutes_per_day: grossPerDay,
    net_minutes_per_day: netPerDay,
    shift_names: endShifts.map(s => s.name),
    mixed: dayKeys.length > 1 && dayKeys.some(k => k !== dayKeys[0]),
  };

  // Standing
  let standing: LedgerStanding = 'counted';
  let standingReason: string | null = null;
  if (employee.role === 'super_admin' || employee.role === 'manager') {
    standing = 'excluded';
    standingReason = `${employee.role === 'manager' ? 'Management' : 'Administrator'} role — not held to rostered hours.`;
  } else if (schedules.length === 0) {
    standing = 'excluded';
    standingReason = 'No shift rostered for this period, so no requirement can be computed.';
  } else if (t.days_worked === 0) {
    standing = 'dormant';
    standingReason = 'Rostered but no clock-in at all in this period.';
  }

  const warnings: string[] = [];
  if (t.has_open_days) {
    warnings.push('One or more days are still open — those hours are provisional until clock-out.');
  }
  if (t.future_days > 0) {
    warnings.push(
      `This period is still running: ${t.future_days} working day${t.future_days === 1 ? '' : 's'} `
      + 'have not happened yet and are not counted as shortage. Figures are month-to-date.',
    );
  }
  if (policy.mixed) {
    warnings.push('This employee holds shifts with different working days, so there is no single hours-per-day figure.');
  }
  if (policy.unpaid_break_minutes == null && days.some(d => d.sessions > 1)) {
    warnings.push(
      'This employee clocked out and back in on some days, but no unpaid-break allowance is set on their shift. '
      + 'Their recorded break is being counted as a shortfall. Set the break policy on the shift to compare them fairly.',
    );
  }
  if (!employee.is_active) {
    warnings.push('This employee is inactive.');
  }

  // Locked by the END of the period: a part-month close locks what it covers,
  // and a statement that straddles the boundary is still partly provisional.
  const closure = await lockFor(toDate);

  return {
    employee: {
      id: employee.id, emp_id: employee.emp_id, name: employee.name,
      department: employee.department, role: employee.role,
      is_active: Boolean(employee.is_active),
    },
    period: { from_date: fromDate, to_date: toDate, label: periodLabel(fromDate, toDate) },
    policy,
    standing,
    standing_reason: standingReason,
    totals: t,
    standard: {
      stated_minutes: STANDARD_MONTHLY_MINUTES,
      // The WHOLE period's ask, not just the elapsed part — "does this month
      // work out to the 225h standard" is a question about the month, and
      // comparing a part-month against a monthly norm would always look short.
      roster_minutes: t.scheduled_minutes,
      difference_minutes: t.scheduled_minutes - STANDARD_MONTHLY_MINUTES,
    },
    closure,
    days,
    warnings,
  };
}

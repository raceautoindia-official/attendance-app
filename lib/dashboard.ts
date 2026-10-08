/**
 * lib/dashboard.ts — everything the home page shows, in one query pass.
 *
 * The page it feeds is the first thing an administrator sees each morning, so
 * what goes on it is chosen by one test: does it change what somebody does
 * today? A figure that is merely interesting pushes a figure that needs acting
 * on below the fold.
 *
 * Three bands, in that order:
 *   1. TODAY       — who is in, who is not, what is still open right now
 *   2. THIS MONTH  — hours against what was asked for, and where the gap is
 *   3. NEEDS YOU   — the queues: approvals, corrections, missing documents
 *
 * Charts are returned as ChartSpec, the same shape the assistant produces, so
 * the page renders them with the same component and the same palette. A chart
 * here can only say "these labels have these values" — it cannot invent one.
 *
 * Every figure is DERIVED at read time. Nothing is cached or stored, for the
 * same reason the payroll pack derives its numbers: a dashboard that snapshots
 * figures starts disagreeing with the pages it links to, and the dashboard is
 * where somebody looks first, so its version wins the argument wrongly.
 */

import { query, queryOne } from '@/lib/db';
import { toYmd } from '@/lib/date';
import { STANDARD_MONTHLY_MINUTES } from '@/lib/constants';
import type { ChartSpec } from '@/lib/charts/types';

export interface DashboardKpi {
  key: string;
  label: string;
  value: number;
  /** null when the figure cannot be measured, which is not the same as zero. */
  measured: boolean;
  /** Short line under the number saying what it means. */
  hint: string;
  /** Where clicking it should go. */
  href?: string;
  tone: 'neutral' | 'good' | 'warn' | 'bad';
}

export interface DashboardQueueItem {
  key: string;
  label: string;
  count: number;
  href: string;
}

export interface Dashboard {
  as_of: string;
  month: string;
  today: {
    date: string;
    headcount: number;
    clocked_in: number;
    still_working: number;
    on_leave: number;
    holiday: string | null;
    not_in_yet: number;
  };
  month_totals: {
    worked_minutes: number;
    required_minutes: number;
    /** Sum of each employee's stated monthly standard — policy, else global. */
    stated_minutes: number;
    employees_counted: number;
  };
  kpis: DashboardKpi[];
  queues: DashboardQueueItem[];
  charts: ChartSpec[];
  /** Said out loud rather than left for the reader to infer. */
  notes: string[];
}

function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number);
  const start = `${month}-01`;
  const end = toYmd(new Date(Date.UTC(y, m, 0)));
  return { start, end };
}

/** Rounds to one decimal so a chart axis does not carry false precision. */
const hrs = (minutes: number) => Math.round((minutes / 60) * 10) / 10;

export async function buildDashboard(params: { month?: string } = {}): Promise<Dashboard> {
  const now = new Date();
  const today = toYmd(now);
  const month = params.month ?? today.slice(0, 7);
  const { start, end } = monthBounds(month);
  // Never read past today: a month in progress must not report the days that
  // have not happened as though nobody worked them.
  const periodEnd = end > today ? today : end;
  const notes: string[] = [];

  // ---- headcount ---------------------------------------------------------
  const head = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM employees WHERE is_active = TRUE AND role = 'employee'`,
  );
  const headcount = Number(head?.n ?? 0);

  // ---- today -------------------------------------------------------------
  const todayRow = await queryOne<{
    clocked_in: number; still_working: number;
  }>(
    `SELECT COUNT(*) AS clocked_in,
            SUM(CASE WHEN clock_out_utc IS NULL THEN 1 ELSE 0 END) AS still_working
       FROM attendance a
       JOIN employees e ON e.id = a.employee_id
      WHERE a.work_date = ? AND e.is_active = TRUE AND e.role = 'employee'
        AND a.first_clock_in_utc IS NOT NULL`,
    [today],
  );

  const onLeave = await queryOne<{ n: number }>(
    `SELECT COUNT(DISTINCT lr.employee_id) AS n FROM leave_records lr
       JOIN employees e ON e.id = lr.employee_id
      WHERE lr.leave_date = ? AND lr.leave_type <> 'holiday' AND e.is_active = TRUE`,
    [today],
  );

  const holiday = await queryOne<{ notes: string | null }>(
    `SELECT notes FROM leave_records
      WHERE employee_id IS NULL AND leave_type = 'holiday' AND leave_date = ?
      LIMIT 1`,
    [today],
  );

  const clockedIn = Number(todayRow?.clocked_in ?? 0);
  const stillWorking = Number(todayRow?.still_working ?? 0);
  const leaveToday = Number(onLeave?.n ?? 0);
  const notInYet = Math.max(0, headcount - clockedIn - leaveToday);

  if (holiday?.notes) {
    notes.push(`Today is a company holiday (${holiday.notes}), so nobody is expected in.`);
  }

  // ---- the month ---------------------------------------------------------
  const worked = await queryOne<{ total: number; employees: number }>(
    `SELECT COALESCE(SUM(a.total_minutes), 0) AS total,
            COUNT(DISTINCT a.employee_id) AS employees
       FROM attendance a
       JOIN employees e ON e.id = a.employee_id
      WHERE a.work_date BETWEEN ? AND ?
        AND e.is_active = TRUE AND e.role = 'employee'`,
    [start, periodEnd],
  );

  // The stated standard per employee: their policy's figure where they have
  // one, the global constant where they do not. Summed, this is what the month
  // is nominally asking of the whole team.
  const stated = await queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(
              COALESCE(p.monthly_hours * 60, ?)
            ), 0) AS total
       FROM employees e
       LEFT JOIN employee_policies ep
              ON ep.employee_id = e.id
             AND ep.effective_from <= ?
             AND (ep.effective_to IS NULL OR ep.effective_to >= ?)
       LEFT JOIN policies p ON p.id = ep.policy_id
      WHERE e.is_active = TRUE AND e.role = 'employee'`,
    [STANDARD_MONTHLY_MINUTES, periodEnd, periodEnd],
  );

  const workedMinutes = Number(worked?.total ?? 0);
  const statedMinutes = Number(stated?.total ?? 0);

  // ---- lateness, and whether it could be measured at all ------------------
  const late = await queryOne<{ late_days: number; measurable_employees: number }>(
    `SELECT COALESCE(SUM(CASE WHEN a.status = 'late' THEN 1 ELSE 0 END), 0) AS late_days,
            COUNT(DISTINCT CASE WHEN s.type <> 'flexible' THEN e.id END) AS measurable_employees
       FROM employees e
       LEFT JOIN employee_schedules es
              ON es.employee_id = e.id
             AND es.effective_from <= ?
             AND (es.effective_to IS NULL OR es.effective_to >= ?)
       LEFT JOIN shifts s ON s.id = es.shift_id
       LEFT JOIN attendance a
              ON a.employee_id = e.id AND a.work_date BETWEEN ? AND ?
      WHERE e.is_active = TRUE AND e.role = 'employee'`,
    [periodEnd, periodEnd, start, periodEnd],
  );
  const measurableEmployees = Number(late?.measurable_employees ?? 0);
  if (measurableEmployees < headcount) {
    notes.push(
      `Lateness cannot be measured for ${headcount - measurableEmployees} of ${headcount} `
      + 'employees — they are on a flexible shift, which is not judged against a start time. '
      + 'The late figure covers only the rest.',
    );
  }

  // ---- the queues --------------------------------------------------------
  const pendingPermissions = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM permission_requests WHERE status = 'pending'`,
  ).catch(() => ({ n: 0 }));

  const pendingFence = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM attendance
      WHERE out_of_fence_status = 'pending' AND work_date >= ?`, [start],
  ).catch(() => ({ n: 0 }));

  const pendingRegularisation = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM regularisation_requests WHERE status = 'pending'`,
  ).catch(() => ({ n: 0 }));

  const noPolicy = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM employees e
      WHERE e.is_active = TRUE AND e.role = 'employee'
        AND NOT EXISTS (
          SELECT 1 FROM employee_policies ep
           WHERE ep.employee_id = e.id
             AND ep.effective_from <= ?
             AND (ep.effective_to IS NULL OR ep.effective_to >= ?))`,
    [today, today],
  ).catch(() => ({ n: 0 }));

  const noSchedule = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM employees e
      WHERE e.is_active = TRUE AND e.role = 'employee'
        AND NOT EXISTS (
          SELECT 1 FROM employee_schedules es
           WHERE es.employee_id = e.id
             AND es.effective_from <= ?
             AND (es.effective_to IS NULL OR es.effective_to >= ?))`,
    [today, today],
  ).catch(() => ({ n: 0 }));

  const queues: DashboardQueueItem[] = [
    { key: 'permissions', label: 'Permission requests', count: Number(pendingPermissions?.n ?? 0), href: '/permissions' },
    { key: 'fence', label: 'Out-of-fence to review', count: Number(pendingFence?.n ?? 0), href: '/attendance' },
    { key: 'regularisations', label: 'Attendance corrections', count: Number(pendingRegularisation?.n ?? 0), href: '/attendance' },
    { key: 'no_policy', label: 'Employees with no policy', count: Number(noPolicy?.n ?? 0), href: '/policies' },
    { key: 'no_schedule', label: 'Employees with no shift', count: Number(noSchedule?.n ?? 0), href: '/schedules' },
  ].filter(q => q.count > 0);

  if (Number(noSchedule?.n ?? 0) > 0) {
    notes.push(
      `${noSchedule?.n} employee(s) have no shift, so the nightly absent-marking job skips them `
      + 'and they contribute no required hours.',
    );
  }

  // ---- charts ------------------------------------------------------------
  // Daily attendance across the month so far: the shape of the month at a
  // glance, and where the gaps are.
  const daily = await query<{ d: string; present: number; late_n: number; absent: number }>(
    `SELECT DATE_FORMAT(a.work_date, '%Y-%m-%d') AS d,
            SUM(CASE WHEN a.status IN ('present','late') THEN 1 ELSE 0 END) AS present,
            SUM(CASE WHEN a.status = 'late'   THEN 1 ELSE 0 END) AS late_n,
            SUM(CASE WHEN a.status = 'absent' THEN 1 ELSE 0 END) AS absent
       FROM attendance a
       JOIN employees e ON e.id = a.employee_id
      WHERE a.work_date BETWEEN ? AND ?
        AND e.is_active = TRUE AND e.role = 'employee'
      GROUP BY a.work_date ORDER BY a.work_date`,
    [start, periodEnd],
  );

  // Hours by department: where the month's work actually went.
  const byDept = await query<{ dept: string | null; minutes: number }>(
    `SELECT COALESCE(NULLIF(e.department, ''), 'Unassigned') AS dept,
            COALESCE(SUM(a.total_minutes), 0) AS minutes
       FROM employees e
       LEFT JOIN attendance a
              ON a.employee_id = e.id AND a.work_date BETWEEN ? AND ?
      WHERE e.is_active = TRUE AND e.role = 'employee'
      GROUP BY dept HAVING minutes > 0 ORDER BY minutes DESC LIMIT 8`,
    [start, periodEnd],
  );

  // Six months of worked hours, so this month has something to be judged
  // against. A single month's figure answers no question on its own.
  const trend = await query<{ m: string; minutes: number }>(
    `SELECT DATE_FORMAT(a.work_date, '%Y-%m') AS m,
            COALESCE(SUM(a.total_minutes), 0) AS minutes
       FROM attendance a
       JOIN employees e ON e.id = a.employee_id
      WHERE a.work_date >= DATE_SUB(?, INTERVAL 5 MONTH)
        AND a.work_date <= ?
        AND e.is_active = TRUE AND e.role = 'employee'
      GROUP BY m ORDER BY m`,
    [start, periodEnd],
  );

  const charts: ChartSpec[] = [];

  if (daily.length > 0) {
    charts.push({
      // Columns, not a stacked bar: a stacked bar shows the parts of ONE
      // whole, and this is three measures across many days.
      type: 'column',
      title: 'Attendance by day',
      subtitle: month,
      unit: 'count',
      series: [
        { label: 'On time', points: daily.map(r => ({ label: r.d.slice(8), value: Number(r.present) - Number(r.late_n) })) },
        { label: 'Late', points: daily.map(r => ({ label: r.d.slice(8), value: Number(r.late_n) })) },
        { label: 'Absent', points: daily.map(r => ({ label: r.d.slice(8), value: Number(r.absent) })) },
      ],
      note: measurableEmployees < headcount
        ? 'Late counts only employees on a fixed shift; it is not measured on a flexible one.'
        : undefined,
    });
  }

  if (trend.length > 1) {
    charts.push({
      type: 'line',
      title: 'Hours worked by month',
      subtitle: 'Last six months',
      unit: 'hours',
      series: [{ label: 'Worked', points: trend.map(r => ({ label: r.m, value: hrs(Number(r.minutes)) })) }],
      note: 'The current month is still in progress, so its point is month-to-date.',
    });
  }

  if (byDept.length > 0) {
    charts.push({
      type: 'bar',
      title: 'Hours by department',
      subtitle: month,
      unit: 'hours',
      series: [{ label: 'Worked', points: byDept.map(r => ({ label: r.dept ?? 'Unassigned', value: hrs(Number(r.minutes)) })) }],
    });
  }

  const todaySlices = [
    { label: 'Working now', value: stillWorking },
    { label: 'Clocked out', value: Math.max(0, clockedIn - stillWorking) },
    { label: 'On leave', value: leaveToday },
    { label: 'Not in yet', value: notInYet },
  ].filter(p => p.value > 0);

  // One slice is not a composition, it is a number - and before anybody has
  // clocked in, 'Not in yet' is the only slice there is.
  if (todaySlices.length >= 2) {
    charts.push({
      type: 'pie',
      title: 'Where everyone is today',
      subtitle: today,
      unit: 'count',
      series: [{ label: 'People', points: todaySlices }],
    });
  }

  // ---- the headline figures ---------------------------------------------
  // Month-to-date hours against the WHOLE month's target is an honest figure
  // and a misleading one: on the 7th it reads 8% and looks like a collapse.
  // So the comparison is scaled to the part of the month that has actually
  // happened, and the headline says which it is.
  const monthInProgress = periodEnd < end;
  const daysElapsed = Number(periodEnd.slice(8)) ;
  const daysInMonth = Number(end.slice(8));
  const expectedToDate = monthInProgress
    ? Math.round(statedMinutes * (daysElapsed / daysInMonth))
    : statedMinutes;
  const pct = expectedToDate > 0 ? Math.round((workedMinutes / expectedToDate) * 100) : 0;
  if (monthInProgress) {
    notes.push(
      `${month} is still running: ${daysElapsed} of ${daysInMonth} days. Hours are compared `
      + `against ${hrs(expectedToDate)}h, the share of the month's ${hrs(statedMinutes)}h that `
      + 'has elapsed — not against the full month, which would read as a shortfall all month.',
    );
  }
  const kpis: DashboardKpi[] = [
    {
      key: 'in_today', label: 'In today', value: clockedIn, measured: true,
      hint: `of ${headcount} active${leaveToday ? `, ${leaveToday} on leave` : ''}`,
      href: '/attendance',
      tone: holiday?.notes ? 'neutral' : notInYet > headcount / 2 ? 'warn' : 'good',
    },
    {
      key: 'working_now', label: 'Working now', value: stillWorking, measured: true,
      hint: 'clocked in, not yet out', href: '/live-tracking', tone: 'neutral',
    },
    {
      key: 'hours_month', label: monthInProgress ? 'Hours month to date' : 'Hours this month',
      value: hrs(workedMinutes), measured: true,
      hint: monthInProgress
        ? `${pct}% of the ${hrs(expectedToDate)}h due by day ${daysElapsed}`
        : `${pct}% of the ${hrs(statedMinutes)}h the month states`,
      href: '/hours',
      tone: pct >= 95 ? 'good' : pct >= 75 ? 'neutral' : 'warn',
    },
    {
      key: 'late_days', label: 'Late days', value: Number(late?.late_days ?? 0),
      measured: measurableEmployees > 0,
      hint: measurableEmployees > 0
        ? `across ${measurableEmployees} on a fixed shift`
        : 'nobody is on a shift where lateness can be measured',
      href: '/hours',
      tone: Number(late?.late_days ?? 0) > 0 ? 'warn' : 'good',
    },
  ];

  return {
    as_of: now.toISOString(),
    month,
    today: {
      date: today,
      headcount,
      clocked_in: clockedIn,
      still_working: stillWorking,
      on_leave: leaveToday,
      holiday: holiday?.notes ?? null,
      not_in_yet: notInYet,
    },
    month_totals: {
      worked_minutes: workedMinutes,
      required_minutes: statedMinutes,
      stated_minutes: statedMinutes,
      employees_counted: Number(worked?.employees ?? 0),
    },
    kpis,
    queues,
    charts,
    notes,
  };
}

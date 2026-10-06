import { buildHoursLedger } from '@/lib/hoursLedger';
import { queryOne } from '@/lib/db';
import { requireSuperAdmin, type ChatContext, type ToolResult } from '../types';
import { minutesToHours, resolveRange, type RangeInput } from '../dates';

/**
 * lib/chat/tools/hours.ts — required vs worked hours, and the gap.
 *
 * WHY THIS TOOL EXISTS
 * --------------------
 * The assistant was refusing questions like "what is X's average working day",
 * and it was right to: the system prompt forbids it from doing arithmetic, and
 * no tool returned an average. The fault was never the model's reasoning, it
 * was that the tools were starved. Loosening the no-arithmetic rule would have
 * traded a visible refusal for invisible wrong numbers.
 *
 * So the figures are computed in SQL and TypeScript and handed over finished.
 * Every duration arrives twice — as minutes for comparison, and as a formatted
 * string for quoting — so the model never has to convert anything either.
 *
 * It reads lib/hoursLedger.ts, the same module behind the Working Hours screen
 * and the reports. An employee who is told one figure on screen and a different
 * one by the assistant would be right to distrust both.
 */

interface LedgerDaySummary {
  date: string;
  weekday: string;
  kind: string;
  required_display: string;
  worked_display: string;
  shortage_display: string;
  shortage_minutes: number;
}

export interface HoursLedgerResult {
  employee: { id: number; emp_id: string; name: string; department: string | null };
  period: { from_date: string; to_date: string; label: string };
  /** 'counted' | 'dormant' | 'excluded' — see lib/hoursLedger.ts. */
  standing: string;
  standing_reason: string | null;
  requirement: {
    per_day_display: string | null;
    gross_per_day_display: string | null;
    unpaid_break_display: string | null;
    shift_names: string[];
    working_days: number;
    explanation: string;
  };
  totals: {
    required_minutes: number;
    required_display: string;
    worked_minutes: number;
    worked_display: string;
    credited_minutes: number;
    credited_display: string;
    /** Signed: negative means short for the period. */
    net_minutes: number;
    net_display: string;
    month_verdict: string;
    daily_shortfall_minutes: number;
    daily_shortfall_display: string;
    overtime_minutes: number;
    overtime_display: string;
    average_per_worked_day_display: string;
    average_per_worked_day_minutes: number | null;
    shortest_day: string | null;
    longest_day: string | null;
    days_worked: number;
    days_short: number;
    days_present: number;
    days_late: number;
    days_absent: number;
    leave_days: number;
    holiday_days: number;
    week_off_days: number;
    late_display: string;
    permission_display: string;
    break_display: string;
  };
  worst_days: LedgerDaySummary[];
  days?: LedgerDaySummary[];
  warnings: string[];
}

const signed = (m: number) => (m < 0 ? `-${minutesToHours(-m)}` : minutesToHours(m));

function summarise(d: {
  date: string; weekday: string; kind: string;
  required_minutes: number | null; worked_minutes: number | null; shortage_minutes: number;
}): LedgerDaySummary {
  return {
    date: d.date,
    weekday: d.weekday,
    kind: d.kind,
    required_display: d.required_minutes == null ? 'no roster' : minutesToHours(d.required_minutes),
    worked_display: d.worked_minutes == null ? 'nothing clocked' : minutesToHours(d.worked_minutes),
    shortage_display: minutesToHours(d.shortage_minutes),
    shortage_minutes: d.shortage_minutes,
  };
}

/**
 * Required vs worked hours for one employee over a period, with the shortage
 * already worked out and every figure pre-formatted.
 */
export async function getHoursLedger(
  ctx: ChatContext,
  args: { employee_id: number; include_days?: boolean } & RangeInput,
): Promise<ToolResult<HoursLedgerResult>> {
  requireSuperAdmin(ctx);

  if (!Number.isInteger(args.employee_id)) {
    throw new Error('employee_id is required — resolve the person with resolve_employee first.');
  }

  const range = resolveRange(args);
  const ledger = await buildHoursLedger({
    employeeId: args.employee_id,
    fromDate: range.from,
    toDate: range.to,
  });

  if (!ledger) {
    const exists = await queryOne<{ id: number }>(
      `SELECT id FROM employees WHERE id = ?`, [args.employee_id],
    );
    return {
      range,
      count: 0,
      rows: [],
      notes: [
        exists
          ? `Could not build an hours ledger for employee ${args.employee_id}.`
          : `There is no employee with id ${args.employee_id}. Use resolve_employee first — do not guess an id.`,
      ],
    };
  }

  const t = ledger.totals;
  const p = ledger.policy;

  const explanation = p.mixed
    ? 'This employee works shifts with different working days, so there is no single hours-per-day figure.'
    : p.net_minutes_per_day == null
      ? 'No shift is rostered for this employee, so nothing is required of them.'
      : p.unpaid_break_minutes
        ? `${minutesToHours(p.gross_minutes_per_day ?? 0)} on the clock less `
          + `${minutesToHours(p.unpaid_break_minutes)} unpaid break = `
          + `${minutesToHours(p.net_minutes_per_day)} per working day, over ${t.working_days} working days.`
        : `${minutesToHours(p.net_minutes_per_day)} per working day over ${t.working_days} working days. `
          + 'No unpaid break is deducted.';

  // State the month verdict in words so it cannot be mis-signed in the retelling.
  const monthVerdict = t.net_minutes < 0
    ? `${minutesToHours(-t.net_minutes)} SHORT for the period`
    : t.net_minutes > 0
      ? `${minutesToHours(t.net_minutes)} AHEAD for the period`
      : 'exactly on target for the period';

  const worst = [...ledger.days]
    .filter(d => d.shortage_minutes > 0)
    .sort((a, b) => b.shortage_minutes - a.shortage_minutes)
    .slice(0, 5)
    .map(summarise);

  const warnings = [...ledger.warnings];
  // The two shortage figures disagree whenever someone misses a day and works
  // extra on others. Say so, rather than letting one be quoted as the truth.
  if (t.net_minutes >= 0 && t.shortage_minutes > 0) {
    warnings.push(
      `The period total is met, but ${minutesToHours(t.shortage_minutes)} went unworked on `
      + `${t.days_short} day(s) that required hours, offset by overtime elsewhere. `
      + 'Report both figures — do not call this person simply "short" or simply "on target".',
    );
  }

  const result: HoursLedgerResult = {
    employee: {
      id: ledger.employee.id,
      emp_id: ledger.employee.emp_id,
      name: ledger.employee.name,
      department: ledger.employee.department,
    },
    period: ledger.period,
    standing: ledger.standing,
    standing_reason: ledger.standing_reason,
    requirement: {
      per_day_display: p.net_minutes_per_day == null ? null : minutesToHours(p.net_minutes_per_day),
      gross_per_day_display: p.gross_minutes_per_day == null ? null : minutesToHours(p.gross_minutes_per_day),
      unpaid_break_display: p.unpaid_break_minutes == null ? null : minutesToHours(p.unpaid_break_minutes),
      shift_names: p.shift_names,
      working_days: t.working_days,
      explanation,
    },
    totals: {
      required_minutes: t.required_minutes,
      required_display: minutesToHours(t.required_minutes),
      worked_minutes: t.worked_minutes,
      worked_display: minutesToHours(t.worked_minutes),
      credited_minutes: t.credited_minutes,
      credited_display: minutesToHours(t.credited_minutes),
      net_minutes: t.net_minutes,
      net_display: signed(t.net_minutes),
      month_verdict: monthVerdict,
      daily_shortfall_minutes: t.shortage_minutes,
      daily_shortfall_display: minutesToHours(t.shortage_minutes),
      overtime_minutes: t.overtime_minutes,
      overtime_display: minutesToHours(t.overtime_minutes),
      average_per_worked_day_display: t.avg_worked_minutes_per_day == null
        ? 'no days worked'
        : minutesToHours(t.avg_worked_minutes_per_day),
      average_per_worked_day_minutes: t.avg_worked_minutes_per_day,
      shortest_day: t.shortest_day
        ? `${t.shortest_day.date} (${minutesToHours(t.shortest_day.minutes)})` : null,
      longest_day: t.longest_day
        ? `${t.longest_day.date} (${minutesToHours(t.longest_day.minutes)})` : null,
      days_worked: t.days_worked,
      days_short: t.days_short,
      days_present: t.days_present,
      days_late: t.days_late,
      days_absent: t.days_absent,
      leave_days: t.leave_days,
      holiday_days: t.holiday_days,
      week_off_days: t.week_off_days,
      late_display: minutesToHours(t.late_minutes),
      permission_display: minutesToHours(t.permission_minutes),
      break_display: minutesToHours(t.break_minutes),
    },
    worst_days: worst,
    days: args.include_days ? ledger.days.map(summarise) : undefined,
    warnings,
  };

  return { range, count: 1, rows: [result] };
}

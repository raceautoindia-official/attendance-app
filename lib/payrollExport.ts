import { createHash } from 'crypto';
import * as XLSX from 'xlsx';
import { query } from '@/lib/db';
import { STANDARD_MONTHLY_MINUTES } from '@/lib/constants';
import { buildHoursLedger } from '@/lib/hoursLedger';
import { getClosure, lastDayOfMonth, type MonthClosure } from '@/lib/monthClose';

/**
 * lib/payrollExport.ts — the month's hours, in a form a dispute can be settled against.
 *
 * WHY THIS AND NOT THE EXISTING EXPORTS
 * -------------------------------------
 * The other exports answer "what happened". This one answers "what were we
 * looking at when we decided". The difference matters the first time somebody
 * disagrees with their pay: the question is not what the numbers are now, it is
 * whether the file in their hand is the same one that was used, and under which
 * rules.
 *
 * So the pack carries its own provenance — the period, the break policy in
 * force on each shift, the stated monthly standard, whether the month was
 * closed and by whom — and a checksum over the figures. Re-running it on
 * unchanged data reproduces the same checksum, so a disputed file can be
 * verified rather than argued about.
 *
 * The checksum covers the FIGURES ONLY, deliberately. It must not change
 * because the file was regenerated on a different day or by a different person,
 * or it would prove nothing.
 *
 * It reads lib/hoursLedger.ts per employee rather than a faster aggregate,
 * because this is the file somebody gets paid from. Correctness over speed.
 */

export interface PayrollRow {
  emp_id: string;
  name: string;
  department: string | null;
  shift: string;
  /** The rule set in force, or "none" — payroll needs to know which applied. */
  policy: string;
  /** Which statutory deductions that policy says apply to this person. */
  statutory: string;
  /** Minutes, so the checksum is over integers rather than formatted strings. */
  required_minutes: number;
  worked_minutes: number;
  permission_minutes: number;
  credited_minutes: number;
  shortage_minutes: number;
  overtime_minutes: number;
  net_minutes: number;
  working_days: number;
  days_present: number;
  days_late: number;
  days_absent: number;
  leave_days: number;
  holiday_days: number;
  week_off_days: number;
  late_minutes: number;
  standing: string;
}

export interface PayrollPack {
  month: string;
  period: { from_date: string; to_date: string };
  generated_at: string;
  closure: MonthClosure | null;
  policy: {
    standard_monthly_minutes: number;
    shifts: Array<{ name: string; span_minutes: number | null; unpaid_break_minutes: number | null; required_minutes: number | null }>;
  };
  rows: PayrollRow[];
  totals: { employees: number; required_minutes: number; worked_minutes: number; shortage_minutes: number };
  /** SHA-256 over the figures alone. Same data in, same checksum out. */
  checksum: string;
  warnings: string[];
}

const hm = (m: number) => {
  const v = Math.max(0, Math.round(m));
  return `${Math.floor(v / 60)}h ${String(v % 60).padStart(2, '0')}m`;
};

/**
 * Canonical serialisation of the figures, for the checksum.
 *
 * Sorted by employee id and written field by field in a fixed order, so the
 * digest depends on the data and nothing else — not on row order out of MySQL,
 * not on JSON key order, not on when the file was made.
 */
function digest(rows: PayrollRow[]): string {
  const canonical = [...rows]
    .sort((a, b) => a.emp_id.localeCompare(b.emp_id))
    .map(r => [
      r.emp_id,
      r.required_minutes, r.worked_minutes, r.permission_minutes, r.credited_minutes,
      r.shortage_minutes, r.overtime_minutes, r.net_minutes,
      r.working_days, r.days_present, r.days_late, r.days_absent,
      r.leave_days, r.holiday_days, r.week_off_days, r.late_minutes,
      // Policy name and statutory flags are deliberately NOT in the digest.
      // The checksum answers "are these the same FIGURES", and renaming a
      // policy or ticking a box that changes no hours must not make a filed
      // pack look falsified. Anything that does move an hour moves a figure
      // above, and the digest catches it there.
    ].join('|'))
    .join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export async function buildPayrollPack(month: string): Promise<PayrollPack> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('month must be YYYY-MM.');
  const fromDate = `${month}-01`;
  const toDate = lastDayOfMonth(month);

  const employees = await query<{ id: number }>(
    `SELECT id FROM employees WHERE is_active = TRUE ORDER BY emp_id`,
  );

  const rows: PayrollRow[] = [];
  const warnings: string[] = [];

  for (const e of employees) {
    const l = await buildHoursLedger({ employeeId: e.id, fromDate, toDate });
    if (!l) continue;
    // Admins, management and the unrostered are listed in the review, not here:
    // a payroll pack with rows nobody is held to invites them being paid from.
    if (l.standing === 'excluded') continue;

    const t = l.totals;
    rows.push({
      emp_id: l.employee.emp_id,
      name: l.employee.name,
      department: l.employee.department,
      shift: l.policy.shift_names.join(' + ') || 'none',
      policy: l.assigned_policy ? `${l.assigned_policy.name} (${l.assigned_policy.code})` : 'none',
      statutory: l.assigned_policy?.statutory.join(', ') || '—',
      required_minutes: t.required_minutes,
      worked_minutes: t.worked_minutes,
      permission_minutes: t.permission_minutes,
      credited_minutes: t.credited_minutes,
      shortage_minutes: t.shortage_minutes,
      overtime_minutes: t.overtime_minutes,
      net_minutes: t.net_minutes,
      working_days: t.working_days,
      days_present: t.days_present,
      days_late: t.days_late,
      days_absent: t.days_absent,
      leave_days: t.leave_days,
      holiday_days: t.holiday_days,
      week_off_days: t.week_off_days,
      late_minutes: t.late_minutes,
      standing: l.standing,
    });

    if (t.has_open_days) {
      warnings.push(`${l.employee.name} has a day still clocked in — those hours are provisional.`);
    }
    if (t.future_days > 0) {
      warnings.push(`${month} has not finished: ${t.future_days} working day(s) are still to come.`);
    }
  }

  const shifts = await query<{
    name: string; start_time: string | null; end_time: string | null;
    required_hours: number | string | null; unpaid_break_minutes: number | null;
  }>(
    `SELECT name, start_time, end_time, required_hours, unpaid_break_minutes FROM shifts ORDER BY name`,
  );

  const span = (s: { start_time: string | null; end_time: string | null; required_hours: number | string | null }) => {
    if (s.required_hours != null) return Math.round(Number(s.required_hours) * 60);
    if (!s.start_time || !s.end_time) return null;
    const toMin = (t: string) => {
      const m = t.match(/^(\d{1,2}):(\d{2})/);
      return m ? Number(m[1]) * 60 + Number(m[2]) : null;
    };
    const a = toMin(s.start_time); const b = toMin(s.end_time);
    if (a == null || b == null) return null;
    return ((b - a) % 1440 + 1440) % 1440;
  };

  const closure = await getClosure(month);
  if (!closure?.is_closed) {
    warnings.push(
      `${month} has not been closed, so these figures can still change. `
      + 'Close the month before paying from this file.',
    );
  }

  return {
    month,
    period: { from_date: fromDate, to_date: toDate },
    generated_at: new Date().toISOString(),
    closure,
    policy: {
      standard_monthly_minutes: STANDARD_MONTHLY_MINUTES,
      shifts: shifts.map(s => {
        const sp = span(s);
        const brk = s.unpaid_break_minutes == null ? null : Number(s.unpaid_break_minutes);
        return {
          name: s.name,
          span_minutes: sp,
          unpaid_break_minutes: brk,
          required_minutes: sp == null ? null : Math.max(0, sp - (brk ?? 0)),
        };
      }),
    },
    rows,
    totals: {
      employees: rows.length,
      required_minutes: rows.reduce((s, r) => s + r.required_minutes, 0),
      worked_minutes: rows.reduce((s, r) => s + r.worked_minutes, 0),
      shortage_minutes: rows.reduce((s, r) => s + r.shortage_minutes, 0),
    },
    checksum: digest(rows),
    warnings: [...new Set(warnings)],
  };
}

const COLUMNS: Array<[keyof PayrollRow | 'blank', string, 'text' | 'minutes' | 'number']> = [
  ['emp_id', 'Employee ID', 'text'],
  ['name', 'Name', 'text'],
  ['department', 'Department', 'text'],
  ['shift', 'Shift', 'text'],
  ['policy', 'Policy', 'text'],
  ['statutory', 'Statutory', 'text'],
  ['working_days', 'Working days', 'number'],
  ['required_minutes', 'Required', 'minutes'],
  ['worked_minutes', 'Worked', 'minutes'],
  ['permission_minutes', 'Permission', 'minutes'],
  ['credited_minutes', 'Credited', 'minutes'],
  ['shortage_minutes', 'Short on short days', 'minutes'],
  ['net_minutes', 'Net for the month', 'minutes'],
  ['overtime_minutes', 'Overtime', 'minutes'],
  ['days_present', 'Present', 'number'],
  ['days_late', 'Late', 'number'],
  ['late_minutes', 'Late by', 'minutes'],
  ['days_absent', 'Absent', 'number'],
  ['leave_days', 'Leave', 'number'],
  ['holiday_days', 'Holidays', 'number'],
  ['week_off_days', 'Week offs', 'number'],
];

/**
 * The pack as a workbook: a cover sheet carrying the provenance, and the
 * figures. The cover comes first because the rules a figure was produced under
 * are part of the figure.
 */
export function payrollPackToXlsx(pack: PayrollPack): Buffer {
  const cover: Array<Array<string | number>> = [
    ['Working hours pack'],
    [],
    ['Period', `${pack.period.from_date} to ${pack.period.to_date}`],
    ['Generated', new Date(pack.generated_at).toUTCString()],
    ['Employees', pack.rows.length],
    [],
    ['STATUS'],
    pack.closure?.is_closed
      ? ['Month closed', `Yes — signed off${pack.closure.closed_by_name ? ` by ${pack.closure.closed_by_name}` : ''} on ${new Date(pack.closure.closed_at).toUTCString()}`]
      : ['Month closed', 'NO — these figures can still change'],
    ['Checksum (SHA-256)', pack.checksum],
    ['', 'Re-running this export on unchanged data reproduces the same checksum.'],
    [],
    ['RULES IN FORCE'],
    ['Stated monthly standard', hm(pack.policy.standard_monthly_minutes)],
    ['', 'The requirement below is derived from each roster, not from this figure —'],
    ['', 'the number of working days genuinely differs month to month.'],
    [],
    ['Shift', 'On the clock', 'Unpaid break', 'Required per working day'],
    ...pack.policy.shifts.map(s => [
      s.name,
      s.span_minutes == null ? 'n/a' : hm(s.span_minutes),
      s.unpaid_break_minutes == null ? 'none deducted' : hm(s.unpaid_break_minutes),
      s.required_minutes == null ? 'n/a' : hm(s.required_minutes),
    ]),
    [],
    ['TOTALS'],
    ['Required', hm(pack.totals.required_minutes)],
    ['Worked', hm(pack.totals.worked_minutes)],
    ['Short on short days', hm(pack.totals.shortage_minutes)],
  ];

  if (pack.warnings.length) {
    cover.push([], ['WORTH KNOWING'], ...pack.warnings.map(w => ['', w]));
  }

  const coverSheet = XLSX.utils.aoa_to_sheet(cover);
  coverSheet['!cols'] = [{ wch: 26 }, { wch: 46 }, { wch: 18 }, { wch: 24 }];

  const header = COLUMNS.map(([, h]) => h);
  const body = pack.rows.map(r =>
    COLUMNS.map(([key, , kind]) => {
      const v = r[key as keyof PayrollRow];
      if (kind === 'minutes') return hm(Number(v ?? 0));
      if (kind === 'number') return Number(v ?? 0);
      return v == null ? '' : String(v);
    }),
  );
  const figures = XLSX.utils.aoa_to_sheet([header, ...body]);
  figures['!cols'] = COLUMNS.map(([, h]) => ({ wch: Math.max(h.length + 2, 11) }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, coverSheet, 'Cover');
  XLSX.utils.book_append_sheet(wb, figures, 'Hours');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

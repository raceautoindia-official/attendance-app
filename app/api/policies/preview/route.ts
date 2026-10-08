import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { queryOne } from '@/lib/db';
import { shiftRequiredMinutes } from '@/lib/shifts';
import { weekdayCounts, companyHolidays, workingDaysFor, parseWorkingDays } from '@/lib/workingDays';
import { toYmd } from '@/lib/date';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// What a shift actually produces, month by month.
//
// "Week offs per month" was a number somebody typed, and it cannot be right:
// October 2026 has four Sundays, November has five, and a holiday landing on a
// working day moves the figure again. A single stored number is wrong in most
// months and silently so.
//
// So the form stops asking and starts showing. The same three functions the
// hours ledger uses answer it — weekdayCounts, companyHolidays and
// workingDaysFor — which means the preview cannot drift from the figures the
// employee is actually judged against.
// ---------------------------------------------------------------------------

export interface MonthPreview {
  month: string;
  label: string;
  days_in_month: number;
  working_days: number;
  week_offs: number;
  holidays: number;
  /** Derived requirement for the month, in minutes. Null if the shift has none. */
  required_minutes: number | null;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const sp = new URL(request.url).searchParams;
  const shiftId = Number(sp.get('shift_id'));
  const months = Math.min(Math.max(Number(sp.get('months')) || 6, 1), 12);

  if (!Number.isInteger(shiftId) || shiftId <= 0) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'shift_id is required' }, { status: 400 },
    );
  }

  const shift = await queryOne<{
    id: number; name: string; type: string;
    start_time: string | null; end_time: string | null;
    required_hours: number | string | null;
    unpaid_break_minutes: number | null;
    working_days: unknown;
  }>(
    `SELECT id, name, type, start_time, end_time, required_hours,
            unpaid_break_minutes, working_days
       FROM shifts WHERE id = ?`,
    [shiftId],
  );
  if (!shift) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'No such shift' }, { status: 404 },
    );
  }

  const workingDays = parseWorkingDays(shift.working_days);
  const perDay = shiftRequiredMinutes(shift);

  // Start from the current month: the question being asked is always "what
  // will this ask of somebody", not "what did it ask last year".
  const now = new Date();
  const startYear = now.getUTCFullYear();
  const startMonth = now.getUTCMonth();

  const rows: MonthPreview[] = [];
  for (let i = 0; i < months; i++) {
    const y = startYear + Math.floor((startMonth + i) / 12);
    const m = (startMonth + i) % 12;
    const first = toYmd(new Date(Date.UTC(y, m, 1)));
    const last = toYmd(new Date(Date.UTC(y, m + 1, 0)));
    const daysInMonth = Number(last.slice(8));

    const counts = weekdayCounts(first, last);
    const holidays = await companyHolidays(first, last);
    const working = workingDaysFor(workingDays, counts, holidays);

    // Holidays that actually fall on a day this shift would have worked. A
    // holiday on a week off costs nobody anything, and counting it would
    // overstate what the month gives back.
    const active = new Set(workingDays ?? []);
    const holidaysOnWorkingDays = workingDays?.length
      ? holidays.filter(h => {
          const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][
            new Date(`${h}T00:00:00Z`).getUTCDay()
          ];
          return active.has(dow);
        }).length
      : holidays.length;

    rows.push({
      month: `${y}-${String(m + 1).padStart(2, '0')}`,
      label: `${MONTH_NAMES[m]} ${y}`,
      days_in_month: daysInMonth,
      working_days: working,
      // Everything that is not a working day and not a holiday taken off it.
      week_offs: daysInMonth - working - holidaysOnWorkingDays,
      holidays: holidaysOnWorkingDays,
      required_minutes: perDay == null ? null : working * perDay,
    });
  }

  return NextResponse.json<ApiResponse<{
    shift: { id: number; name: string; type: string };
    per_day_minutes: number | null;
    months: MonthPreview[];
  }>>({
    success: true,
    data: {
      shift: { id: shift.id, name: shift.name, type: shift.type },
      per_day_minutes: perDay,
      months: rows,
    },
  });
}

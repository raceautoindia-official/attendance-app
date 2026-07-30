import { NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { getWorkDateIST } from '@/lib/attendance';
import type { ApiResponse } from '@/lib/types';

/** Live tracking may only be recorded during an active shift.
 *
 * Phones can keep their background tracking service alive long after a shift —
 * e.g. the employee never clocked out and attendance was auto-closed at
 * midnight, or the stop call failed — and then they keep reporting location on
 * days the employee never logged in, which looks like app misuse on the admin
 * map. So: no open attendance (clocked in, not yet out, today) → refuse the
 * data AND close any lingering session so the map clears immediately. The app
 * shuts down its tracking service when it receives this 403. */
export async function requireOpenShift(employeeId: number): Promise<NextResponse | null> {
  const open = await queryOne<{ id: number }>(
    `SELECT id FROM attendance
     WHERE employee_id = ? AND work_date = ?
       AND clock_in_utc IS NOT NULL AND clock_out_utc IS NULL`,
    [employeeId, getWorkDateIST()],
  );
  if (open) return null;

  await query(
    `UPDATE live_tracking_sessions
     SET is_active = FALSE, ended_at_utc = UTC_TIMESTAMP()
     WHERE employee_id = ? AND is_active = TRUE`,
    [employeeId],
  );
  return NextResponse.json<ApiResponse>(
    { success: false, error: 'Not clocked in — live tracking only runs during an active shift' },
    { status: 403 },
  );
}

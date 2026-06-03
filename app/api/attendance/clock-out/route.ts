import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import {
  getWorkDateIST,
  getClientIp,
  toMySQLDatetime,
} from '@/lib/attendance';
import type { ApiResponse, AttendanceRecord } from '@/lib/types';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ClockOutSchema = z.object({
  latitude: z.number({ error: 'latitude must be a number' }),
  longitude: z.number({ error: 'longitude must be a number' }),
});

// ---------------------------------------------------------------------------
// Shape of the attendance + shift info we need
// ---------------------------------------------------------------------------

interface AttendanceWithShift {
  id: number;
  employee_id: number;
  work_date: string;
  clock_in_utc: Date;
  clock_out_utc: Date | null;
  status: string;
  // Joined shift data (may be null if no schedule)
  end_time: string | null;
  shift_type: string | null;
  grace_minutes: number | null;
}

// ---------------------------------------------------------------------------
// POST /api/attendance/clock-out
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  if (auth.role === 'employee') {
    const ua = request.headers.get('user-agent')?.toLowerCase() ?? '';
    const mobileHint = request.headers.get('sec-ch-ua-mobile');
    const isMobile = mobileHint === '?1' || /android|iphone|ipad|ipod|mobile|windows phone/.test(ua);
    if (!isMobile) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'Attendance marking is mobile-only for employees' },
        { status: 403 },
      );
    }
  }

  // 1. Parse + validate body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const parsed = ClockOutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Validation error' },
      { status: 400 },
    );
  }

  const { latitude: lat, longitude: lng } = parsed.data;
  const workDate = getWorkDateIST();
  const ip = getClientIp(request);

  // 2. Find the employee's open (clocked-in but not yet clocked-out) session.
  //    We deliberately do NOT filter by a.work_date = today: if the server's
  //    clock/timezone drifts, or an employee forgot to clock out on a previous
  //    day, the open session may carry a different work_date. Matching on the
  //    open session itself (clock_in present, clock_out NULL) makes clock-out
  //    robust to those date mismatches. The schedule join keys off the record's
  //    own work_date so the right shift end_time is used for early-departure.
  const record = await queryOne<AttendanceWithShift>(
    `SELECT
       a.id, a.employee_id, a.work_date, a.clock_in_utc,
       a.clock_out_utc, a.status,
       s.end_time, s.type AS shift_type, s.grace_minutes
     FROM attendance a
     LEFT JOIN employee_schedules es
       ON es.employee_id = a.employee_id
       AND es.effective_from <= a.work_date
       AND (es.effective_to IS NULL OR es.effective_to >= a.work_date)
     LEFT JOIN shifts s ON es.shift_id = s.id
     WHERE a.employee_id = ?
       AND a.clock_in_utc IS NOT NULL
       AND a.clock_out_utc IS NULL
     ORDER BY a.clock_in_utc DESC, es.effective_from DESC
     LIMIT 1`,
    [auth.id],
  );

  if (!record) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'No open clock-in found' },
      { status: 404 },
    );
  }

  // 3. Calculate totals
  const nowUtc = new Date();
  const clockInUtc = new Date(record.clock_in_utc);
  const totalMinutes = Math.round(
    (nowUtc.getTime() - clockInUtc.getTime()) / 60_000,
  );

  // 4. Status is left unchanged on clock-out — we do not evaluate the clock-out
  //    time against the shift end (no early-departure check). Each day stands on
  //    its own; sessions left open are auto-closed at midnight by the
  //    /api/cron/close-sessions job.
  const newStatus = record.status;

  // 5. Update the record
  await query(
    `UPDATE attendance
     SET clock_out_utc = ?,
         clock_out_lat = ?,
         clock_out_lng = ?,
         total_minutes = ?,
         status        = ?
     WHERE id = ?`,
    [
      toMySQLDatetime(nowUtc),
      lat,
      lng,
      totalMinutes,
      newStatus,
      record.id,
    ],
  );

  // 6. Audit log
  await insertAuditLog({
    action: 'clock_out',
    entity: 'attendance',
    entity_id: record.id,
    performed_by: auth.id,
    details: { work_date: workDate, total_minutes: totalMinutes, status: newStatus },
    ip_address: ip,
  });

  // 7. Return the updated record
  const updated = await queryOne<AttendanceRecord>(
    `SELECT a.*, e.name AS employee_name, e.emp_id
     FROM attendance a
     JOIN employees e ON a.employee_id = e.id
     WHERE a.id = ?`,
    [record.id],
  );

  return NextResponse.json<ApiResponse<AttendanceRecord>>(
    { success: true, data: updated! },
  );
}

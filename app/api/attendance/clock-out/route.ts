import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import {
  getWorkDateIST,
  isEarlyDeparture,
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
  grace_minutes: number | null;
}

// ---------------------------------------------------------------------------
// POST /api/attendance/clock-out
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

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

  // 2. Find today's open (not yet clocked-out) record, joining the active schedule
  //    for shift end_time to detect early departure.
  const record = await queryOne<AttendanceWithShift>(
    `SELECT
       a.id, a.employee_id, a.work_date, a.clock_in_utc,
       a.clock_out_utc, a.status,
       s.end_time, s.grace_minutes
     FROM attendance a
     LEFT JOIN employee_schedules es
       ON es.employee_id = a.employee_id
       AND es.effective_from <= CURDATE()
       AND (es.effective_to IS NULL OR es.effective_to >= CURDATE())
     LEFT JOIN shifts s ON es.shift_id = s.id
     WHERE a.employee_id = ?
       AND a.work_date = ?
       AND a.clock_out_utc IS NULL
     ORDER BY es.effective_from DESC
     LIMIT 1`,
    [auth.id, workDate],
  );

  if (!record) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'No open clock-in found for today' },
      { status: 404 },
    );
  }

  // 3. Calculate totals
  const nowUtc = new Date();
  const clockInUtc = new Date(record.clock_in_utc);
  const totalMinutes = Math.round(
    (nowUtc.getTime() - clockInUtc.getTime()) / 60_000,
  );

  // 4. Determine if early departure
  let newStatus = record.status;
  if (
    record.end_time &&
    isEarlyDeparture(nowUtc, record.end_time, record.work_date)
  ) {
    // Only downgrade to early_departure if currently 'present' or 'late'
    if (newStatus === 'present' || newStatus === 'late') {
      newStatus = 'early_departure';
    }
  }

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

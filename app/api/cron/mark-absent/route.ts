import { NextRequest, NextResponse } from 'next/server';
import { query, insertAuditLog } from '@/lib/db';

// ---------------------------------------------------------------------------
// POST /api/cron/mark-absent
//
// Called nightly (e.g. 23:59 IST) by a cron job:
//   59 23 * * * curl -X POST https://yourdomain.com/api/cron/mark-absent \
//     -H "x-cron-secret: YOUR_SECRET"
//
// Marks absent any employee who:
//   • has an active schedule today
//   • today is a working day per that schedule's working_days JSON array
//   • has no attendance record for today
//   • has no leave record for today
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const secret = request.headers.get('x-cron-secret');
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  // Find employees who should be marked absent
  const employees = await query<{ id: number; name: string }>(
    `SELECT DISTINCT e.id, e.name
     FROM employees e
     JOIN employee_schedules es
       ON  es.employee_id = e.id
       AND es.effective_from <= CURDATE()
       AND (es.effective_to IS NULL OR es.effective_to >= CURDATE())
     JOIN shifts s ON s.id = es.shift_id
     WHERE e.is_active = TRUE
       AND JSON_CONTAINS(s.working_days, JSON_QUOTE(DATE_FORMAT(CURDATE(), '%a')))
       AND NOT EXISTS (
             SELECT 1 FROM attendance a
             WHERE a.employee_id = e.id AND a.work_date = CURDATE()
           )
       AND NOT EXISTS (
             SELECT 1 FROM leave_records lr
             WHERE lr.employee_id = e.id AND lr.leave_date = CURDATE()
           )`,
  );

  if (employees.length === 0) {
    return NextResponse.json({ success: true, message: 'No absent employees to mark', count: 0 });
  }

  // Bulk INSERT — one row per employee
  // ON DUPLICATE KEY UPDATE is a no-op safety net; the NOT EXISTS above should prevent conflicts
  const placeholders = employees.map(() => '(?, CURDATE(), \'absent\')').join(', ');
  const values = employees.map(e => e.id);

  await query(
    `INSERT INTO attendance (employee_id, work_date, status)
     VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE status = status`,
    values,
  );

  await insertAuditLog({
    action: 'bulk_absent_marked',
    entity: 'attendance',
    performed_by: null,
    details: {
      count: employees.length,
      employee_ids: employees.map(e => e.id),
    },
    ip_address: null,
  });

  return NextResponse.json({
    success: true,
    message: `Marked ${employees.length} employee(s) as absent`,
    count: employees.length,
    employees: employees.map(e => e.name),
  });
}

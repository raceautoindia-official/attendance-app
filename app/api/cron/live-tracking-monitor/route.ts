import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { sendLiveTrackingAlert } from '@/lib/mailer';

interface StaleSessionRow {
  session_id: number;
  employee_id: number;
  employee_name: string;
  emp_id: string;
  last_ping_utc: Date | null;
}

export async function POST(request: NextRequest) {
  const secret = request.headers.get('x-cron-secret');
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const staleMinutes = Math.max(1, Number(process.env.LIVE_TRACKING_STALE_MINUTES) || 3);

  const staleSessions = await query<StaleSessionRow>(
    `SELECT
       s.id AS session_id,
       s.employee_id,
       e.name AS employee_name,
       e.emp_id,
       s.last_ping_utc
     FROM live_tracking_sessions s
     JOIN employees e ON e.id = s.employee_id
     WHERE s.is_active = TRUE
       AND e.is_active = TRUE
       AND s.last_ping_utc IS NOT NULL
       AND TIMESTAMPDIFF(MINUTE, s.last_ping_utc, UTC_TIMESTAMP()) >= ?`,
    [staleMinutes],
  );

  if (!staleSessions.length) {
    return NextResponse.json({ success: true, message: 'No stale live-tracking sessions', count: 0 });
  }

  const admins = await query<{ email: string | null }>(
    `SELECT DISTINCT email
     FROM employees
     WHERE is_active = TRUE
       AND role IN ('super_admin', 'manager')
       AND email IS NOT NULL`,
  );
  const adminEmails = admins.map(a => a.email).filter((email): email is string => !!email);

  let alertsSent = 0;

  for (const session of staleSessions) {
    const recentAlert = await queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total
       FROM audit_log
       WHERE action = 'live_tracking_signal_lost'
         AND JSON_EXTRACT(details, '$.session_id') = ?
         AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 MINUTE)`,
      [session.session_id],
    );

    if (Number(recentAlert?.total ?? 0) > 0) continue;

    await insertAuditLog({
      action: 'live_tracking_signal_lost',
      entity: 'attendance',
      entity_id: session.session_id,
      performed_by: null,
      details: {
        session_id: session.session_id,
        employee_id: session.employee_id,
        emp_id: session.emp_id,
        last_ping_utc: session.last_ping_utc,
        stale_minutes_threshold: staleMinutes,
      },
      ip_address: null,
    });

    await query(
      `UPDATE live_tracking_sessions
       SET is_active = FALSE, ended_at_utc = UTC_TIMESTAMP()
       WHERE id = ? AND is_active = TRUE`,
      [session.session_id],
    );

    await Promise.all(
      adminEmails.map(email => sendLiveTrackingAlert(email, {
        employeeName: session.employee_name,
        empId: session.emp_id,
        reason: 'stale_ping',
        detectedAt: new Date(),
        sessionId: session.session_id,
      })),
    );
    alertsSent++;
  }

  return NextResponse.json({
    success: true,
    message: `Processed ${staleSessions.length} stale session(s)`,
    count: staleSessions.length,
    alerts_sent: alertsSent,
  });
}

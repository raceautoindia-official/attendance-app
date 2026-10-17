import { query } from '@/lib/db';
import { sendAlertDigestEmail } from '@/lib/mailer';
import { listAlerts } from '@/lib/alerts';

/**
 * lib/alertDigest.ts — one email a day, or none.
 *
 * ONE EMAIL, NOT ONE PER ALERT. A message per event is how a mail rule gets
 * written, and after that nobody sees any of them. The digest says what is open
 * this morning and links to the queue; the queue is where people act.
 *
 * OFF BY DEFAULT. `ALERT_DIGEST=on` switches it on. An env flag rather than a
 * settings row on purpose: this app has no settings surface, and inventing one
 * for a single boolean is a worse answer than a line in `.env` beside the SMTP
 * credentials the mail already depends on.
 *
 * SENT ONCE. `alert_deliveries` is unique on (channel, recipient, period_key),
 * so the INSERT is the lock - a second attempt the same day writes nothing and
 * sends nothing, whether it came from another sweep or another process.
 *
 * NOTHING TO SAY MEANS NOTHING SENT. A daily email that reads "all clear"
 * teaches people to delete it unread, and the one that matters goes with it.
 */

export interface DigestResult {
  enabled: boolean;
  recipients: number;
  sent: number;
  /** Already sent to this person today. */
  skipped: number;
  failed: number;
  alerts: number;
}

/** True when somebody has deliberately switched the digest on. */
export function digestEnabled(): boolean {
  return (process.env.ALERT_DIGEST ?? '').trim().toLowerCase() === 'on';
}

/**
 * Who hears about it: active super admins with an email address.
 *
 * Not every manager. This is a company-wide summary, and a manager who may only
 * see their own department would need their own narrowed copy - a different
 * feature, worth doing deliberately rather than by accident.
 */
async function recipients() {
  return query<{ id: number; name: string; email: string }>(
    `SELECT id, name, email FROM employees
      WHERE is_active = TRUE AND role = 'super_admin'
        AND email IS NOT NULL AND email <> ''
      ORDER BY name`,
  );
}

/**
 * Send today's digest, if it is on, if there is anything to say, and if it has
 * not gone already.
 *
 * Never throws: a mail server that is down must not take the alert run down
 * with it. A failure is recorded against the delivery row instead, which is
 * also what makes "I never got it" answerable.
 */
export async function sendAlertDigest(periodKey: string): Promise<DigestResult> {
  const result: DigestResult = {
    enabled: digestEnabled(), recipients: 0, sent: 0, skipped: 0, failed: 0, alerts: 0,
  };
  if (!result.enabled) return result;

  const open = await listAlerts({ states: ['open'] });
  result.alerts = open.length;
  if (open.length === 0) return result;

  const people = await recipients();
  result.recipients = people.length;
  const appUrl = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

  const rows = open.map(a => ({
    severity: a.severity,
    who: a.employee_name,
    title: a.title,
    body: a.body,
  }));

  for (const person of people) {
    // The insert IS the lock.
    const claim = await query(
      `INSERT IGNORE INTO alert_deliveries
         (channel, recipient_id, recipient, period_key, alert_count)
       VALUES ('email', ?, ?, ?, ?)`,
      [person.id, person.email, periodKey, open.length],
    ) as unknown as { affectedRows?: number };
    if (!claim?.affectedRows) { result.skipped += 1; continue; }

    const ok = await sendAlertDigestEmail(person.email, {
      recipientName: person.name,
      rows,
      inboxUrl: `${appUrl}/inbox`,
    });

    if (ok) {
      await query(
        `UPDATE alert_deliveries SET sent_at = UTC_TIMESTAMP()
          WHERE channel = 'email' AND recipient = ? AND period_key = ?`,
        [person.email, periodKey],
      );
      result.sent += 1;
    } else {
      // The mailer never throws, so the only way to know is its answer. Writing
      // sent_at regardless would record a delivery that never happened.
      await query(
        `UPDATE alert_deliveries SET error = 'the mailer could not send it - check the transport'
          WHERE channel = 'email' AND recipient = ? AND period_key = ?`,
        [person.email, periodKey],
      );
      result.failed += 1;
    }
  }

  return result;
}

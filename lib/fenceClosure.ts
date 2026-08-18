import { queryOne } from '@/lib/db';
import { readJsonColumn } from '@/lib/jsonColumn';

/**
 * Did the geofence end this attendance row's last session?
 *
 * Two different things close a day for leaving the site, and both count:
 *
 *   • the SERVER watchdog, which logs 'geofence_auto_clockout' — this is the
 *     half that works when the app has been swiped away, and in practice it is
 *     the one that fires;
 *   • the PHONE, which calls clock-out itself after its four warnings and
 *     records the reason on an ordinary 'clock_out' entry.
 *
 * Only the MOST RECENT closure is consulted. An attendance row is reused for
 * the whole day, so an employee whose morning session was closed by the fence
 * and who then worked a normal afternoon has a manual clock-out as their last
 * closure — the fence is no longer what ended their day, and they should not be
 * held to it.
 *
 * Returns null when nothing closed the day, when the audit trail has no record
 * of it, or when the row is still open. Absence of evidence deliberately reads
 * as "not fence-closed": a missing audit entry must not lock somebody out of
 * their own attendance.
 */
export async function lastFenceClosure(
  attendanceId: number,
): Promise<{ action: string; reason: string | null } | null> {
  const row = await queryOne<{ action: string; details: string | Record<string, unknown> | null }>(
    `SELECT action, details
       FROM audit_log
      WHERE entity = 'attendance'
        AND entity_id = ?
        AND action IN ('geofence_auto_clockout', 'clock_out')
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [attendanceId],
  );
  if (!row) return null;

  if (row.action === 'geofence_auto_clockout') {
    return { action: row.action, reason: 'geofence_exit' };
  }

  // Both shapes read, and a malformed one treated as "no reason recorded"
  // rather than throwing inside a clock-in — see readJsonColumn.
  const details = readJsonColumn(row.details);

  const reason = typeof details.reason === 'string' ? details.reason : null;
  return reason === 'geofence_exit' || reason === 'location_off'
    ? { action: row.action, reason }
    : null;
}

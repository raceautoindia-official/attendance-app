import { NextRequest } from 'next/server';
import { query, queryOne, insertAuditLog } from '@/lib/db';

// ---------------------------------------------------------------------------
// Which phone is allowed to mark this employee's attendance.
//
// The mobile-only rule was enforced from the User-Agent, which the client
// picks — a desktop script claiming to be Android sailed through. The app now
// sends a per-install identifier from its secure storage; the first one seen
// for an employee is remembered, and a different one is refused until an admin
// releases the binding (new phone, lost handset).
//
// This does not authenticate the hardware — an identifier can be copied off a
// rooted device. What it does is stop the casual bypass and leave a record: a
// second device shows up in the audit log rather than silently working.
//
// Rollout: requests that send NO device id keep working, because employees
// running the older build have nothing to send. Set REQUIRE_DEVICE_ID=true once
// the new app is out to close that door too.
// ---------------------------------------------------------------------------

const REQUIRE_DEVICE_ID = process.env.REQUIRE_DEVICE_ID === 'true';

export type DeviceOutcome =
  | { ok: true; deviceId: string | null; bound: 'existing' | 'new' | 'absent' }
  | { ok: false; error: string };

export function deviceIdFrom(request: NextRequest): string | null {
  const raw = request.headers.get('x-device-id')?.trim();
  if (!raw) return null;
  // Keep it to what the app generates (a UUID) so nothing odd reaches the DB.
  return /^[A-Za-z0-9._:-]{8,128}$/.test(raw) ? raw : null;
}

// Only a POSITIVE result is memoised — caching "missing" would mean running the
// migration did nothing until someone restarted the server.
const SCHEMA_RECHECK_MS = 30_000;
let tableReady = false;
let tableCheckedAt = 0;
async function hasDeviceTable(): Promise<boolean> {
  if (tableReady) return true;
  if (Date.now() - tableCheckedAt < SCHEMA_RECHECK_MS) return false;
  tableCheckedAt = Date.now();
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_devices'`,
  );
  tableReady = Number(row?.n ?? 0) > 0;
  return tableReady;
}

/**
 * Has this employee ever presented a device id? Released bindings count — a
 * released device still proves their app is a build that identifies itself, so
 * a headerless request from them is not the app.
 */
async function hasEverBoundDevice(employeeId: number): Promise<boolean> {
  const row = await queryOne<{ n: number }>(
    'SELECT COUNT(*) AS n FROM employee_devices WHERE employee_id = ?',
    [employeeId],
  );
  return Number(row?.n ?? 0) > 0;
}

/**
 * Check the device this request came from, binding it on first use.
 * Returns ok:false only when a DIFFERENT device is already bound.
 */
export async function checkDevice(
  employeeId: number,
  request: NextRequest,
  context: { action: string; ip: string | null },
): Promise<DeviceOutcome> {
  const deviceId = deviceIdFrom(request);

  if (!(await hasDeviceTable())) return { ok: true, deviceId, bound: 'absent' };

  if (!deviceId) {
    if (REQUIRE_DEVICE_ID) {
      return { ok: false, error: 'Please update the app — this version cannot mark attendance.' };
    }
    // Enforcement turns itself on, per employee, the moment we know their app
    // can identify itself.
    //
    // A flag day is not an option: the build already on employees' phones sends
    // no device id, so refusing headerless requests outright would stop every
    // one of them clocking in. But once an employee HAS been seen with a device
    // id, a request without one cannot be from their app — it is a browser or a
    // script — so from then on it is refused. Employees close the hole simply by
    // updating; nobody is locked out waiting for the rollout.
    if (await hasEverBoundDevice(employeeId)) {
      await insertAuditLog({
        action: 'device_rejected',
        entity: 'attendance',
        performed_by: employeeId,
        details: {
          employee_id: employeeId,
          attempted: context.action,
          reason: 'no_device_id_from_a_client_that_should_have_one',
        },
        ip_address: context.ip,
      });
      return {
        ok: false,
        error: 'Attendance can only be marked from the mobile app on your registered phone.',
      };
    }
    return { ok: true, deviceId: null, bound: 'absent' };
  }

  const bound = await query<{ id: number; device_id: string }>(
    `SELECT id, device_id FROM employee_devices
     WHERE employee_id = ? AND released_at IS NULL`,
    [employeeId],
  );

  const match = bound.find(b => b.device_id === deviceId);
  if (match) {
    await query('UPDATE employee_devices SET last_seen_at = UTC_TIMESTAMP() WHERE id = ?', [match.id]);
    return { ok: true, deviceId, bound: 'existing' };
  }

  if (bound.length > 0) {
    await insertAuditLog({
      action: 'device_rejected',
      entity: 'attendance',
      performed_by: employeeId,
      details: {
        employee_id: employeeId,
        attempted: context.action,
        presented_device: deviceId,
        bound_devices: bound.map(b => b.device_id),
      },
      ip_address: context.ip,
    });
    return {
      ok: false,
      error: 'This phone is not the one registered for your attendance. Ask an admin to register it.',
    };
  }

  // First device seen for this employee — remember it.
  const platform = request.headers.get('x-device-platform')?.slice(0, 32) ?? null;
  await query(
    `INSERT INTO employee_devices (employee_id, device_id, platform)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE last_seen_at = UTC_TIMESTAMP()`,
    [employeeId, deviceId, platform],
  );
  await insertAuditLog({
    action: 'device_bound',
    entity: 'employee',
    entity_id: employeeId,
    performed_by: employeeId,
    details: { employee_id: employeeId, device_id: deviceId, platform, via: context.action },
    ip_address: context.ip,
  });
  return { ok: true, deviceId, bound: 'new' };
}

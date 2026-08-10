import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// Devices bound to one employee.
//
// GET    — list them (admin needs to see what a rejection was about)
// DELETE — release the binding, so the next phone the employee uses is adopted.
//          A new handset or a reinstall would otherwise lock them out of
//          marking attendance entirely.
// ---------------------------------------------------------------------------

interface DeviceRow {
  id: number;
  device_id: string;
  platform: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

async function deviceTableMissing(): Promise<boolean> {
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_devices'`,
  );
  return Number(row?.n ?? 0) === 0;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const employeeId = parseInt((await params).id, 10);
  if (Number.isNaN(employeeId)) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid employee id' }, { status: 400 });
  }
  if (await deviceTableMissing()) {
    return NextResponse.json<ApiResponse<{ devices: DeviceRow[] }>>({ success: true, data: { devices: [] } });
  }

  const devices = await query<DeviceRow>(
    `SELECT id, device_id, platform,
            DATE_FORMAT(first_seen_at, '%Y-%m-%d %H:%i') AS first_seen_at,
            DATE_FORMAT(last_seen_at,  '%Y-%m-%d %H:%i') AS last_seen_at
     FROM employee_devices
     WHERE employee_id = ? AND released_at IS NULL
     ORDER BY last_seen_at DESC`,
    [employeeId],
  );

  return NextResponse.json<ApiResponse<{ devices: DeviceRow[] }>>(
    { success: true, data: { devices } },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const employeeId = parseInt((await params).id, 10);
  if (Number.isNaN(employeeId)) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid employee id' }, { status: 400 });
  }
  if (await deviceTableMissing()) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Device binding is not set up' }, { status: 400 });
  }

  const existing = await query<{ device_id: string }>(
    'SELECT device_id FROM employee_devices WHERE employee_id = ? AND released_at IS NULL',
    [employeeId],
  );
  await query(
    `UPDATE employee_devices
     SET released_at = UTC_TIMESTAMP(), released_by = ?
     WHERE employee_id = ? AND released_at IS NULL`,
    [auth.id, employeeId],
  );

  await insertAuditLog({
    action: 'device_released',
    entity: 'employee',
    entity_id: employeeId,
    performed_by: auth.id,
    details: { employee_id: employeeId, released: existing.map(e => e.device_id) },
    ip_address: request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
  });

  return NextResponse.json<ApiResponse>({
    success: true,
    message: 'Device released — the next phone this employee uses will be registered.',
  });
}

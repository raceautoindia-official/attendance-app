import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/lib/constants';
import type { ApiResponse, AuditLog } from '@/lib/types';

// ---------------------------------------------------------------------------
// GET /api/audit-log — super_admin only, paginated
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);

  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
  const limit = Math.min(
    Math.max(1, parseInt(searchParams.get('limit') ?? String(DEFAULT_PAGE_SIZE), 10)),
    MAX_PAGE_SIZE,
  );
  const offset = (page - 1) * limit;

  const fromDate = searchParams.get('from_date');
  const toDate = searchParams.get('to_date');
  const performedBy = searchParams.get('performed_by');
  const entity = searchParams.get('entity');

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (fromDate) {
    conditions.push('al.created_at >= ?');
    params.push(`${fromDate} 00:00:00`);
  }
  if (toDate) {
    conditions.push('al.created_at <= ?');
    params.push(`${toDate} 23:59:59`);
  }
  if (performedBy) {
    const pb = parseInt(performedBy, 10);
    if (!isNaN(pb)) {
      conditions.push('al.performed_by = ?');
      params.push(pb);
    }
  }
  // Whitelist entity values to prevent injection
  const validEntities = [
    'attendance', 'employee', 'passkey', 'passkey_exemption',
    'employee_schedule', 'location', 'auth',
  ];
  if (entity && validEntities.includes(entity)) {
    conditions.push('al.entity = ?');
    params.push(entity);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [countRow, rows] = await Promise.all([
    queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM audit_log al ${where}`,
      [...params],
    ),
    query<AuditLog>(
      `SELECT al.*,
              e.name  AS performed_by_name
       FROM audit_log al
       LEFT JOIN employees e ON al.performed_by = e.id
       ${where}
       ORDER BY al.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ),
  ]);

  // Parse JSON details column
  const parsed = rows.map(row => ({
    ...row,
    details:
      row.details && typeof row.details === 'string'
        ? JSON.parse(row.details as unknown as string)
        : row.details,
  }));

  const total = Number(countRow?.total ?? 0);

  return NextResponse.json<ApiResponse<{
    logs: AuditLog[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }>>({
    success: true,
    data: {
      logs: parsed,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    },
  });
}

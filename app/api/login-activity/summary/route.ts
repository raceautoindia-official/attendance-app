import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import type { ApiResponse } from '@/lib/types';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['employee', 'manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const [totalRow, monthRow, lastRow] = await Promise.all([
    queryOne<{ total_days: number }>(
      `SELECT COUNT(DISTINCT DATE(created_at)) AS total_days
       FROM audit_log
       WHERE action = 'login_success'
         AND performed_by = ?`,
      [auth.id],
    ),
    queryOne<{ month_days: number }>(
      `SELECT COUNT(DISTINCT DATE(created_at)) AS month_days
       FROM audit_log
       WHERE action = 'login_success'
         AND performed_by = ?
         AND YEAR(created_at) = YEAR(CURDATE())
         AND MONTH(created_at) = MONTH(CURDATE())`,
      [auth.id],
    ),
    queryOne<{ last_login_at: Date | null }>(
      `SELECT MAX(created_at) AS last_login_at
       FROM audit_log
       WHERE action = 'login_success'
         AND performed_by = ?`,
      [auth.id],
    ),
  ]);

  return NextResponse.json<ApiResponse<{
    total_login_days: number;
    current_month_login_days: number;
    last_login_at: Date | null;
  }>>({
    success: true,
    data: {
      total_login_days: Number(totalRow?.total_days ?? 0),
      current_month_login_days: Number(monthRow?.month_days ?? 0),
      last_login_at: lastRow?.last_login_at ?? null,
    },
  });
}


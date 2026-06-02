import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import type { ApiResponse } from '@/lib/types';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['employee', 'manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const row = await queryOne<{ count: number }>(
    'SELECT COUNT(*) AS count FROM passkeys WHERE employee_id = ?',
    [auth.id],
  );

  const hasPasskey = Number(row?.count ?? 0) > 0;

  return NextResponse.json<ApiResponse<{ hasPasskey: boolean }>>({
    success: true,
    data: { hasPasskey },
  });
}


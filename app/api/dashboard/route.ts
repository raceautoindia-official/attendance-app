import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { buildDashboard, type Dashboard } from '@/lib/dashboard';
import type { ApiResponse } from '@/lib/types';

/**
 * The home dashboard.
 *
 * Managers and super admins only: it aggregates the whole company, so it is not
 * something an employee sees. Everything is derived at read time rather than
 * cached, so it can never disagree with the pages it links to.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const month = new URL(request.url).searchParams.get('month') ?? undefined;
  if (month && !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'month must be YYYY-MM' }, { status: 400 },
    );
  }

  const dashboard = await buildDashboard({ month });
  return NextResponse.json<ApiResponse<Dashboard>>({ success: true, data: dashboard });
}

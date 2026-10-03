import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/lib/constants';
import { computeSummaryReport } from '@/lib/reportSummary';
import type { ApiResponse } from '@/lib/types';

// GET /api/reports/summary — manager | super_admin, paginated
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);

  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
  const limit = Math.min(
    Math.max(1, parseInt(searchParams.get('limit') ?? String(DEFAULT_PAGE_SIZE), 10)),
    MAX_PAGE_SIZE,
  );

  const fromDate = searchParams.get('from_date');
  const toDate = searchParams.get('to_date');
  const employeeId = searchParams.get('employee_id');
  const employeeFilterId =
    employeeId && !Number.isNaN(parseInt(employeeId, 10)) ? parseInt(employeeId, 10) : null;

  if (!fromDate || !toDate) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'from_date and to_date are required (YYYY-MM-DD)' },
      { status: 400 },
    );
  }

  const result = await computeSummaryReport({
    fromDate,
    toDate,
    employeeFilterId,
    managerId: auth.role === 'manager' ? auth.id : null,
    page,
    limit,
  });

  return NextResponse.json<ApiResponse<{
    summary: typeof result.summary;
    pagination: { page: number; limit: number; total: number; totalPages: number };
    period: typeof result.period;
    totals: typeof result.totals;
  }>>({
    success: true,
    data: {
      summary: result.summary,
      pagination: { page, limit, total: result.total, totalPages: Math.ceil(result.total / limit) },
      totals: result.totals,
      period: result.period,
    },
  });
}

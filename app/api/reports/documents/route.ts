import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { buildComplianceReport, type ComplianceReport } from '@/lib/documentCompliance';
import { storageStatus } from '@/lib/documentStorage';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// GET /api/reports/documents — who is missing which papers.
//
// manager | super_admin, with a manager seeing only their own reports.
//
// Read-only. The requirements are derived from each employee's policy rather
// than configured anywhere, so this report cannot drift out of step with the
// statutory flags that produced it.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const report = await buildComplianceReport({
    managerId: auth.role === 'manager' ? auth.id : null,
  });

  return NextResponse.json<ApiResponse<ComplianceReport & { storage: ReturnType<typeof storageStatus> }>>({
    success: true,
    data: { ...report, storage: storageStatus() },
  });
}

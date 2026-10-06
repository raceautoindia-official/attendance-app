import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { insertAuditLog } from '@/lib/db';
import { buildPayrollPack, payrollPackToXlsx } from '@/lib/payrollExport';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// GET /api/reports/payroll-pack?month=2026-09
//
//   &format=json   the pack as data (default)
//   &format=xlsx   the workbook
//
// super_admin only. This is the file somebody gets paid from, and it carries
// the rules it was produced under plus a checksum, so a disputed copy can be
// verified rather than argued about. Every download is logged — who took which
// month's figures, and what the checksum was at the time.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  const sp = new URL(request.url).searchParams;
  const month = sp.get('month');
  const format = sp.get('format') ?? 'json';

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'month is required, as YYYY-MM' },
      { status: 400 },
    );
  }
  if (format !== 'json' && format !== 'xlsx') {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'format must be json or xlsx' },
      { status: 400 },
    );
  }

  const pack = await buildPayrollPack(month);

  void insertAuditLog({
    action: 'payroll_pack_downloaded',
    entity: 'report',
    performed_by: auth.id,
    ip_address: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      ?? request.headers.get('x-real-ip') ?? null,
    details: {
      month,
      format,
      employees: pack.rows.length,
      checksum: pack.checksum,
      month_closed: Boolean(pack.closure?.is_closed),
    },
  });

  if (format === 'json') {
    return NextResponse.json<ApiResponse<typeof pack>>({ success: true, data: pack });
  }

  const buffer = payrollPackToXlsx(pack);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="working-hours-${month}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  });
}

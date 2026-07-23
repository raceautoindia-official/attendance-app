import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { getWorkDateIST } from '@/lib/attendance';
import type { ApiResponse } from '@/lib/types';

export interface LeaveQuotaRow {
  employee_id: number;
  emp_id: string;
  employee_name: string;
  year: number;
  casual_total: number;
  sick_total: number;
  earned_total: number;
  casual_used: number;
  sick_used: number;
  earned_used: number;
  has_quota: boolean;
}

function missingTableResponse() {
  return NextResponse.json<ApiResponse>(
    {
      success: false,
      error: 'Leave quota table is missing. Run migration: database/migrations/2026-07-23_add_employee_details_documents_leave_quotas.sql',
    },
    { status: 503 },
  );
}

function currentISTYear(): number {
  return Number(getWorkDateIST().slice(0, 4));
}

function parseYear(raw: string | null): number {
  const y = raw ? parseInt(raw, 10) : NaN;
  return !isNaN(y) && y >= 2000 && y <= 2100 ? y : currentISTYear();
}

// ---------------------------------------------------------------------------
// GET /api/leave-quotas?year=YYYY
// employee -> own balance | manager -> team | super_admin -> all active
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['employee', 'manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const year = parseYear(request.nextUrl.searchParams.get('year'));

  const conditions: string[] = ['e.is_active = TRUE'];
  const params: unknown[] = [];
  if (auth.role === 'employee') {
    conditions.push('e.id = ?');
    params.push(auth.id);
  } else if (auth.role === 'manager') {
    conditions.push('(e.manager_id = ? OR e.id = ?)');
    params.push(auth.id, auth.id);
  }

  try {
    // Quota per employee for the year, plus days already taken per type,
    // derived live from leave_records (company-wide holidays excluded — they
    // are not personal leave).
    const rows = await query<Omit<LeaveQuotaRow, 'has_quota'> & { has_quota: number }>(
      `SELECT
         e.id   AS employee_id,
         e.emp_id,
         e.name AS employee_name,
         ? AS year,
         COALESCE(q.casual_total, 0) AS casual_total,
         COALESCE(q.sick_total, 0)   AS sick_total,
         COALESCE(q.earned_total, 0) AS earned_total,
         COALESCE(u.casual_used, 0)  AS casual_used,
         COALESCE(u.sick_used, 0)    AS sick_used,
         COALESCE(u.earned_used, 0)  AS earned_used,
         IF(q.id IS NULL, 0, 1)      AS has_quota
       FROM employees e
       LEFT JOIN leave_quotas q
         ON q.employee_id = e.id AND q.year = ?
       LEFT JOIN (
         SELECT employee_id,
                SUM(leave_type = 'casual') AS casual_used,
                SUM(leave_type = 'sick')   AS sick_used,
                SUM(leave_type = 'earned') AS earned_used
         FROM leave_records
         WHERE employee_id IS NOT NULL
           AND YEAR(leave_date) = ?
         GROUP BY employee_id
       ) u ON u.employee_id = e.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY e.emp_id ASC`,
      [year, year, year, ...params],
    );

    const quotas = rows.map(r => ({
      ...r,
      casual_total: Number(r.casual_total),
      sick_total: Number(r.sick_total),
      earned_total: Number(r.earned_total),
      casual_used: Number(r.casual_used),
      sick_used: Number(r.sick_used),
      earned_used: Number(r.earned_used),
      has_quota: !!Number(r.has_quota),
    }));

    return NextResponse.json<ApiResponse<{ year: number; quotas: LeaveQuotaRow[] }>>({
      success: true,
      data: { year, quotas },
    });
  } catch (error) {
    if ((error as { code?: string })?.code === 'ER_NO_SUCH_TABLE') return missingTableResponse();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// PUT /api/leave-quotas — super admin sets/updates yearly entitlements.
// Either a single employee ({employee_id, ...totals}) or every active
// employee at once ({apply_to_all: true, ...totals}).
// ---------------------------------------------------------------------------

const totals = {
  casual_total: z.number().int().min(0).max(365),
  sick_total: z.number().int().min(0).max(365),
  earned_total: z.number().int().min(0).max(365),
};

const UpdateQuotaSchema = z.union([
  z.object({
    employee_id: z.number().int().positive(),
    year: z.number().int().min(2000).max(2100),
    ...totals,
  }),
  z.object({
    apply_to_all: z.literal(true),
    year: z.number().int().min(2000).max(2100),
    ...totals,
  }),
]);

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 }); }

  const parsed = UpdateQuotaSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Validation error' },
      { status: 400 },
    );
  }

  const { year, casual_total, sick_total, earned_total } = parsed.data;

  try {
    if ('apply_to_all' in parsed.data) {
      await query(
        `INSERT INTO leave_quotas (employee_id, year, casual_total, sick_total, earned_total, updated_by)
         SELECT id, ?, ?, ?, ?, ? FROM employees WHERE is_active = TRUE
         ON DUPLICATE KEY UPDATE
           casual_total = VALUES(casual_total),
           sick_total   = VALUES(sick_total),
           earned_total = VALUES(earned_total),
           updated_by   = VALUES(updated_by)`,
        [year, casual_total, sick_total, earned_total, auth.id],
      );

      await insertAuditLog({
        action: 'leave_quota_bulk_updated',
        entity: 'attendance',
        performed_by: auth.id,
        details: { year, casual_total, sick_total, earned_total, scope: 'all_active_employees' },
        ip_address: request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
      });

      return NextResponse.json<ApiResponse>({
        success: true,
        message: `Leave quotas for ${year} applied to all active employees`,
      });
    }

    const { employee_id } = parsed.data;
    await query(
      `INSERT INTO leave_quotas (employee_id, year, casual_total, sick_total, earned_total, updated_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         casual_total = VALUES(casual_total),
         sick_total   = VALUES(sick_total),
         earned_total = VALUES(earned_total),
         updated_by   = VALUES(updated_by)`,
      [employee_id, year, casual_total, sick_total, earned_total, auth.id],
    );

    await insertAuditLog({
      action: 'leave_quota_updated',
      entity: 'attendance',
      entity_id: employee_id,
      performed_by: auth.id,
      details: { employee_id, year, casual_total, sick_total, earned_total },
      ip_address: request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
    });

    return NextResponse.json<ApiResponse>({
      success: true,
      message: `Leave quota for ${year} saved`,
    });
  } catch (error) {
    if ((error as { code?: string })?.code === 'ER_NO_SUCH_TABLE') return missingTableResponse();
    throw error;
  }
}

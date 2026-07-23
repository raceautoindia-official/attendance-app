import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import * as XLSX from 'xlsx';
import { query, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import type { ApiResponse } from '@/lib/types';

// Quota sheets are tiny; anything bigger is the wrong file.
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const ImportSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  file_name: z.string().max(255).optional(),
  // The .xlsx/.csv file as base64 (no data: prefix).
  data_base64: z.string().min(1, 'File data is required'),
});

interface ParsedRow {
  emp_id: string;
  casual_total: number;
  sick_total: number;
  earned_total: number;
  row_number: number;
}

// Header aliases so both our own export format and hand-made sheets work.
const HEADER_ALIASES: Record<'emp_id' | 'casual' | 'sick' | 'earned', string[]> = {
  emp_id: ['employee id', 'emp id', 'emp_id', 'employeeid', 'id'],
  casual: ['casual quota', 'casual', 'casual_total', 'casual leave', 'cl'],
  sick: ['sick quota', 'sick', 'sick_total', 'sick leave', 'sl'],
  earned: ['earned quota', 'earned', 'earned_total', 'earned leave', 'el'],
};

function normalizeHeader(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function parseDays(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === '') return 0;
  const n = Number(String(value).trim());
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < 0 || rounded > 365) return null;
  return rounded;
}

/** Locates the header row anywhere in the sheet (our export has a preamble
 *  above it), maps the needed columns, and reads the data rows below. */
function parseSheet(rows: unknown[][]): { rows: ParsedRow[]; errors: string[] } {
  const errors: string[] = [];

  let headerIndex = -1;
  let columns: { emp_id: number; casual: number; sick: number; earned: number } | null = null;
  for (let i = 0; i < Math.min(rows.length, 50); i++) {
    const cells = (rows[i] ?? []).map(normalizeHeader);
    const find = (aliases: string[]) => cells.findIndex(c => aliases.includes(c));
    const empIdx = find(HEADER_ALIASES.emp_id);
    const casualIdx = find(HEADER_ALIASES.casual);
    const sickIdx = find(HEADER_ALIASES.sick);
    const earnedIdx = find(HEADER_ALIASES.earned);
    if (empIdx !== -1 && casualIdx !== -1 && sickIdx !== -1 && earnedIdx !== -1) {
      headerIndex = i;
      columns = { emp_id: empIdx, casual: casualIdx, sick: sickIdx, earned: earnedIdx };
      break;
    }
  }
  if (headerIndex === -1 || !columns) {
    return {
      rows: [],
      errors: [
        'Could not find the header row. The sheet needs columns: Employee ID, Casual Quota, Sick Quota, Earned Quota (the exported file has them already).',
      ],
    };
  }

  const parsed: ParsedRow[] = [];
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const empId = String(row[columns.emp_id] ?? '').trim();
    const isEmpty = empId === '' && row.every(c => String(c ?? '').trim() === '');
    if (isEmpty) continue;
    const rowNumber = i + 1;
    if (empId === '') {
      errors.push(`Row ${rowNumber}: missing Employee ID — skipped`);
      continue;
    }
    const casual = parseDays(row[columns.casual]);
    const sick = parseDays(row[columns.sick]);
    const earned = parseDays(row[columns.earned]);
    if (casual === null || sick === null || earned === null) {
      errors.push(`Row ${rowNumber} (${empId}): quota values must be numbers between 0 and 365 — skipped`);
      continue;
    }
    parsed.push({ emp_id: empId, casual_total: casual, sick_total: sick, earned_total: earned, row_number: rowNumber });
  }
  return { rows: parsed, errors };
}

// POST /api/leave-quotas/import — super admin uploads an Excel/CSV quota sheet
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 }); }

  const parsedBody = ImportSchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsedBody.error.issues[0]?.message ?? 'Validation error' },
      { status: 400 },
    );
  }
  const { year } = parsedBody.data;

  const base64 = parsedBody.data.data_base64.replace(/^data:[^;]+;base64,/, '');
  let buf: Buffer;
  try {
    buf = Buffer.from(base64, 'base64');
    if (buf.length === 0) throw new Error('empty');
  } catch {
    return NextResponse.json<ApiResponse>({ success: false, error: 'File data is not valid base64' }, { status: 400 });
  }
  if (buf.length > MAX_FILE_BYTES) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'File is too large (max 2 MB)' }, { status: 413 });
  }

  let sheetRows: unknown[][];
  try {
    const workbook = XLSX.read(buf, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error('no sheets');
    sheetRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true }) as unknown[][];
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Could not read the file. Upload an Excel (.xlsx) or CSV file.' },
      { status: 400 },
    );
  }

  const { rows, errors } = parseSheet(sheetRows);
  if (!rows.length) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: errors[0] ?? 'No data rows found in the file' },
      { status: 400 },
    );
  }

  // Resolve emp_id -> internal id; report unknown/inactive IDs instead of
  // silently ignoring them.
  const empIds = Array.from(new Set(rows.map(r => r.emp_id)));
  const placeholders = empIds.map(() => '?').join(',');
  const employees = await query<{ id: number; emp_id: string; is_active: number }>(
    `SELECT id, emp_id, is_active FROM employees WHERE emp_id IN (${placeholders})`,
    empIds,
  );
  const byEmpId = new Map(employees.map(e => [e.emp_id.toLowerCase(), e]));

  let updated = 0;
  const skipped: string[] = [...errors];
  try {
    for (const row of rows) {
      const emp = byEmpId.get(row.emp_id.toLowerCase());
      if (!emp) {
        skipped.push(`Row ${row.row_number}: employee ID "${row.emp_id}" not found — skipped`);
        continue;
      }
      if (!emp.is_active) {
        skipped.push(`Row ${row.row_number}: employee "${row.emp_id}" is inactive — skipped`);
        continue;
      }
      await query(
        `INSERT INTO leave_quotas (employee_id, year, casual_total, sick_total, earned_total, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           casual_total = VALUES(casual_total),
           sick_total   = VALUES(sick_total),
           earned_total = VALUES(earned_total),
           updated_by   = VALUES(updated_by)`,
        [emp.id, year, row.casual_total, row.sick_total, row.earned_total, auth.id],
      );
      updated++;
    }
  } catch (error) {
    if ((error as { code?: string })?.code === 'ER_NO_SUCH_TABLE') {
      return NextResponse.json<ApiResponse>(
        {
          success: false,
          error: 'Leave quota table is missing. Run migration: database/migrations/2026-07-23_add_employee_details_documents_leave_quotas.sql',
        },
        { status: 503 },
      );
    }
    throw error;
  }

  await insertAuditLog({
    action: 'leave_quota_imported',
    entity: 'attendance',
    performed_by: auth.id,
    details: {
      year,
      file_name: parsedBody.data.file_name ?? null,
      rows_in_file: rows.length,
      updated,
      skipped: skipped.length,
    },
    ip_address: request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
  });

  return NextResponse.json<ApiResponse<{ year: number; updated: number; skipped: string[] }>>({
    success: true,
    message: `${updated} employee quota(s) updated for ${year}${skipped.length ? `, ${skipped.length} row(s) skipped` : ''}`,
    data: { year, updated, skipped },
  });
}

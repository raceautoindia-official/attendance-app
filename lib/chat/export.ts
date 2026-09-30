/**
 * lib/chat/export.ts — downloadable reports for the assistant.
 *
 * DESIGN: the tool does not return a file. It returns a signed, short-lived
 * link. The download route verifies the token and RE-RUNS the same tool
 * function to build the file.
 *
 * Why stateless tokens rather than a server-side file cache:
 *   - PM2 runs in cluster mode, so a cached file written by one worker may be
 *     requested from another. A token carries everything needed.
 *   - Nothing large is held in memory, and nothing needs cleaning up.
 *   - Because the file is produced by the SAME function that answered the
 *     question, the spreadsheet can never disagree with what the chat said.
 *
 * The token is bound to the employee who asked, carries its own audience claim
 * so it can never be confused with an access token, and expires quickly.
 */

import jwt from 'jsonwebtoken';
import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import {
  getAttendanceSummary,
  getAttendanceDetail,
  getDailySnapshot,
  getLateArrivals,
  getAbsentees,
  getDepartmentRollup,
  getGeofenceExceptions,
} from './tools/attendance';
import { getLeaveRecords, getLeaveBalance } from './tools/leave';
import { requireSuperAdmin, type ChatContext } from './types';
import type { RangeInput } from './dates';

/** Distinct audience so a download token is useless as an auth token. */
const AUDIENCE = 'chat-download';
const TOKEN_TTL_MINUTES = 15;

export const EXPORT_FORMATS = ['xlsx', 'csv', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

interface Column {
  key: string;
  header: string;
}

interface FetchResult {
  rows: Array<Record<string, unknown>>;
  rangeLabel?: string;
  subtitle?: string;
}

interface ReportDef {
  label: string;
  columns: Column[];
  needsEmployee?: boolean;
  fetch: (ctx: ChatContext, args: Record<string, unknown>) => Promise<FetchResult>;
}

const EMP = { key: 'emp_id', header: 'Employee ID' };
const NAME = { key: 'name', header: 'Name' };
const DEPT = { key: 'department', header: 'Department' };

export const REPORTS: Record<string, ReportDef> = {
  attendance_summary: {
    label: 'Attendance summary',
    columns: [
      EMP,
      NAME,
      DEPT,
      { key: 'days_present', header: 'Present' },
      { key: 'days_late', header: 'Late' },
      { key: 'days_absent', header: 'Absent' },
      { key: 'days_leave', header: 'Leave' },
      { key: 'days_with_hours', header: 'Days with hours' },
      { key: 'hours_worked_display', header: 'Hours worked' },
    ],
    fetch: async (ctx, a) => {
      const r = await getAttendanceSummary(ctx, a as RangeInput);
      return {
        rows: r.rows as unknown as Array<Record<string, unknown>>,
        rangeLabel: r.range?.label,
        subtitle: `${r.period.total_working_days} working days (${r.period.weekend_days} weekend, ${r.period.festive_holidays} holiday)`,
      };
    },
  },
  attendance_detail: {
    label: 'Attendance detail',
    needsEmployee: true,
    columns: [
      { key: 'work_date', header: 'Date' },
      { key: 'status', header: 'Status' },
      { key: 'clock_in_ist', header: 'Clock in (IST)' },
      { key: 'clock_out_ist', header: 'Clock out (IST)' },
      { key: 'hours_display', header: 'Hours' },
      { key: 'session_count', header: 'Sessions' },
      { key: 'geofence_status', header: 'Geofence' },
      { key: 'notes', header: 'Notes' },
    ],
    fetch: async (ctx, a) => {
      const r = await getAttendanceDetail(
        ctx,
        a as unknown as { employee_id: number } & RangeInput,
      );
      return {
        rows: r.rows as unknown as Array<Record<string, unknown>>,
        rangeLabel: r.range?.label,
      };
    },
  },
  daily_snapshot: {
    label: 'Daily attendance',
    columns: [
      EMP,
      NAME,
      DEPT,
      { key: 'status', header: 'Status' },
      { key: 'clock_in_ist', header: 'Clock in (IST)' },
      { key: 'clock_out_ist', header: 'Clock out (IST)' },
      { key: 'hours_display', header: 'Hours' },
    ],
    fetch: async (ctx, a) => {
      const r = await getDailySnapshot(ctx, a as { date?: string; department?: string });
      return { rows: r.rows as unknown as Array<Record<string, unknown>>, rangeLabel: r.range?.label };
    },
  },
  late_arrivals: {
    label: 'Late arrivals',
    columns: [EMP, NAME, DEPT, { key: 'day_count', header: 'Late days' }],
    fetch: async (ctx, a) => {
      const r = await getLateArrivals(ctx, a as RangeInput);
      return { rows: r.rows as unknown as Array<Record<string, unknown>>, rangeLabel: r.range?.label };
    },
  },
  absentees: {
    label: 'Absences',
    columns: [EMP, NAME, DEPT, { key: 'day_count', header: 'Absent days' }],
    fetch: async (ctx, a) => {
      const r = await getAbsentees(ctx, a as RangeInput);
      return { rows: r.rows as unknown as Array<Record<string, unknown>>, rangeLabel: r.range?.label };
    },
  },
  department_rollup: {
    label: 'Department comparison',
    columns: [
      { key: 'department', header: 'Department' },
      { key: 'employee_count', header: 'Headcount' },
      { key: 'days_present', header: 'Present' },
      { key: 'days_late', header: 'Late' },
      { key: 'days_absent', header: 'Absent' },
      { key: 'hours_worked_display', header: 'Hours worked' },
      { key: 'avg_minutes_per_present_day', header: 'Avg min/present day' },
    ],
    fetch: async (ctx, a) => {
      const r = await getDepartmentRollup(ctx, a as RangeInput);
      return {
        rows: r.rows as unknown as Array<Record<string, unknown>>,
        rangeLabel: r.range?.label,
        subtitle: `${r.period.total_working_days} working days`,
      };
    },
  },
  geofence_exceptions: {
    label: 'Out-of-geofence clock-ins',
    columns: [
      { key: 'work_date', header: 'Date' },
      EMP,
      NAME,
      DEPT,
      { key: 'work_mode', header: 'Work mode' },
      { key: 'clock_in_ist', header: 'Clock in (IST)' },
    ],
    fetch: async (ctx, a) => {
      const r = await getGeofenceExceptions(ctx, a as RangeInput);
      return { rows: r.rows as unknown as Array<Record<string, unknown>>, rangeLabel: r.range?.label };
    },
  },
  leave_records: {
    label: 'Leave records',
    columns: [
      { key: 'leave_date', header: 'Date' },
      EMP,
      NAME,
      DEPT,
      { key: 'leave_type', header: 'Type' },
      { key: 'notes', header: 'Notes' },
    ],
    fetch: async (ctx, a) => {
      const r = await getLeaveRecords(ctx, a as RangeInput);
      return { rows: r.rows as unknown as Array<Record<string, unknown>>, rangeLabel: r.range?.label };
    },
  },
  leave_balance: {
    label: 'Leave balance',
    needsEmployee: true,
    columns: [
      EMP,
      NAME,
      { key: 'year', header: 'Year' },
      { key: 'leave_type', header: 'Type' },
      { key: 'allotted', header: 'Allotted' },
      { key: 'taken', header: 'Taken' },
      { key: 'remaining', header: 'Remaining' },
    ],
    fetch: async (ctx, a) => {
      const r = await getLeaveBalance(ctx, a as { employee_id: number; year?: number });
      return { rows: r.rows as unknown as Array<Record<string, unknown>> };
    },
  },
};

export const REPORT_KEYS = Object.keys(REPORTS);

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

export interface DownloadClaims {
  /** employees.id the link belongs to. */
  sub: number;
  report: string;
  format: ExportFormat;
  params: Record<string, unknown>;
}

function secret(): string {
  const s = process.env.JWT_ACCESS_SECRET;
  if (!s) throw new Error('JWT_ACCESS_SECRET is not set');
  return s;
}

export function signDownloadToken(claims: DownloadClaims): string {
  return jwt.sign(claims, secret(), {
    audience: AUDIENCE,
    expiresIn: `${TOKEN_TTL_MINUTES}m`,
  });
}

/** Verify a download token. Returns null on anything suspect. */
export function verifyDownloadToken(token: string): DownloadClaims | null {
  try {
    const decoded = jwt.verify(token, secret(), { audience: AUDIENCE }) as
      | (DownloadClaims & jwt.JwtPayload)
      | string;
    if (typeof decoded === 'string') return null;
    if (typeof decoded.sub !== 'number') return null;
    if (!REPORTS[decoded.report]) return null;
    if (!EXPORT_FORMATS.includes(decoded.format)) return null;
    return {
      sub: decoded.sub,
      report: decoded.report,
      format: decoded.format,
      params: decoded.params ?? {},
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// File builders
// ---------------------------------------------------------------------------

function cell(value: unknown): string | number {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function escapeCsv(value: string | number): string {
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(def: ReportDef, data: FetchResult): Buffer {
  const lines: string[] = [];
  lines.push(escapeCsv(def.label));
  if (data.rangeLabel) lines.push(escapeCsv(`Period: ${data.rangeLabel}`));
  if (data.subtitle) lines.push(escapeCsv(data.subtitle));
  lines.push('');
  lines.push(def.columns.map(c => escapeCsv(c.header)).join(','));
  for (const row of data.rows) {
    lines.push(def.columns.map(c => escapeCsv(cell(row[c.key]))).join(','));
  }
  // BOM so Excel opens UTF-8 correctly on Windows.
  return Buffer.from('﻿' + lines.join('\r\n'), 'utf8');
}

function buildXlsx(def: ReportDef, data: FetchResult): Buffer {
  const header = [def.label];
  const meta: string[][] = [];
  if (data.rangeLabel) meta.push([`Period: ${data.rangeLabel}`]);
  if (data.subtitle) meta.push([data.subtitle]);

  const aoa: Array<Array<string | number>> = [
    header,
    ...meta,
    [],
    def.columns.map(c => c.header),
    ...data.rows.map(r => def.columns.map(c => cell(r[c.key]))),
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // Width the columns to their content so the sheet is readable as delivered.
  ws['!cols'] = def.columns.map(c => {
    const longest = data.rows.reduce(
      (max, r) => Math.max(max, String(cell(r[c.key])).length),
      c.header.length,
    );
    return { wch: Math.min(Math.max(longest + 2, 10), 42) };
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Report');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

function buildPdf(def: ReportDef, data: FetchResult): Buffer {
  // Landscape for wide tables, portrait when a few columns fit comfortably.
  const doc = new jsPDF({
    orientation: def.columns.length > 5 ? 'landscape' : 'portrait',
    unit: 'pt',
    format: 'a4',
  });

  doc.setFontSize(15);
  doc.text(def.label, 40, 40);

  doc.setFontSize(9);
  doc.setTextColor(110);
  let y = 58;
  if (data.rangeLabel) {
    doc.text(`Period: ${data.rangeLabel}`, 40, y);
    y += 13;
  }
  if (data.subtitle) {
    doc.text(data.subtitle, 40, y);
    y += 13;
  }
  doc.text(`${data.rows.length} row(s)`, 40, y);
  doc.setTextColor(0);

  autoTable(doc, {
    startY: y + 12,
    head: [def.columns.map(c => c.header)],
    body: data.rows.map(r => def.columns.map(c => String(cell(r[c.key])))),
    styles: { fontSize: 8, cellPadding: 4 },
    headStyles: { fillColor: [37, 99, 235], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [246, 248, 251] },
    margin: { left: 40, right: 40 },
  });

  return Buffer.from(doc.output('arraybuffer'));
}

const MIME: Record<ExportFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
  pdf: 'application/pdf',
};

export interface BuiltFile {
  body: Buffer;
  contentType: string;
  filename: string;
  rows: number;
}

/** Re-run the report and render it in the requested format. */
export async function buildReportFile(
  ctx: ChatContext,
  claims: DownloadClaims,
): Promise<BuiltFile> {
  requireSuperAdmin(ctx);

  const def = REPORTS[claims.report];
  if (!def) throw new Error(`Unknown report: ${claims.report}`);

  const data = await def.fetch(ctx, claims.params);

  const body =
    claims.format === 'xlsx'
      ? buildXlsx(def, data)
      : claims.format === 'csv'
        ? buildCsv(def, data)
        : buildPdf(def, data);

  return {
    body,
    contentType: MIME[claims.format],
    filename: buildFilename(def.label, data.rangeLabel, claims.format),
    rows: data.rows.length,
  };
}

export function buildFilename(
  label: string,
  rangeLabel: string | undefined,
  format: ExportFormat,
): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  const parts = [slug(label)];
  if (rangeLabel) parts.push(slug(rangeLabel));
  return `${parts.join('_')}.${format}`;
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export interface DownloadOffer {
  download_url: string;
  filename: string;
  format: ExportFormat;
  report_label: string;
  rows: number;
  period?: string;
  expires_in_minutes: number;
}

/**
 * Prepare a downloadable file and return a link.
 *
 * Runs the report once up front so the row count and period in the chat answer
 * are real rather than promised, and so an empty report is reported as empty
 * instead of handed over as a blank spreadsheet.
 */
export async function createReportDownload(
  ctx: ChatContext,
  args: {
    report: string;
    format: ExportFormat;
    employee_id?: number;
  } & RangeInput & { department?: string; date?: string; year?: number },
): Promise<{ count: number; rows: DownloadOffer[]; notes?: string[] }> {
  requireSuperAdmin(ctx);

  const def = REPORTS[args.report];
  if (!def) {
    throw new Error(
      `Unknown report "${args.report}". Available: ${REPORT_KEYS.join(', ')}.`,
    );
  }
  if (!EXPORT_FORMATS.includes(args.format)) {
    throw new Error(`Unknown format "${args.format}". Use xlsx, csv or pdf.`);
  }
  if (def.needsEmployee && !Number.isInteger(args.employee_id)) {
    throw new Error(
      `The "${args.report}" report covers one employee — resolve the employee first and pass employee_id.`,
    );
  }

  const { report, format, ...params } = args;
  const data = await def.fetch(ctx, params as Record<string, unknown>);

  if (data.rows.length === 0) {
    return {
      count: 0,
      rows: [],
      notes: [
        `There is no data for that ${def.label.toLowerCase()}${
          data.rangeLabel ? ` in ${data.rangeLabel}` : ''
        }, so no file was created.`,
      ],
    };
  }

  const token = signDownloadToken({
    sub: ctx.employeeId,
    report,
    format,
    params: params as Record<string, unknown>,
  });

  return {
    count: 1,
    rows: [
      {
        download_url: `/api/chat/download?t=${encodeURIComponent(token)}`,
        filename: buildFilename(def.label, data.rangeLabel, format),
        format,
        report_label: def.label,
        rows: data.rows.length,
        period: data.rangeLabel,
        expires_in_minutes: TOKEN_TTL_MINUTES,
      },
    ],
  };
}

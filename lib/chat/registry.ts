/**
 * lib/chat/registry.ts — the complete, closed set of things the assistant can
 * do.
 *
 * This file is the security boundary. There is no raw-SQL tool and no schema
 * introspection tool, so any question that does not map onto one of the
 * functions below is unanswerable by construction — the refusal is structural,
 * not a matter of the model following instructions.
 *
 * STRICT MODE: OpenAI structured outputs require `additionalProperties: false`
 * and EVERY property listed in `required`. Optional arguments are therefore
 * declared nullable (e.g. `["string", "null"]`) and the dispatcher strips nulls
 * back to `undefined` before calling the tool.
 */

import {
  resolveEmployee,
  getEmployeeProfile,
  listDepartments,
} from './tools/employees';
import {
  getAttendanceSummary,
  getAttendanceDetail,
  getDailySnapshot,
  getLateArrivals,
  getAbsentees,
  getDepartmentRollup,
  getGeofenceExceptions,
} from './tools/attendance';
import {
  getLeaveRecords,
  getHolidays,
  getLeaveBalance,
} from './tools/leave';
import {
  getShifts,
  getSchedule,
  getLiveTrackingStatus,
  getAuditTrail,
} from './tools/operations';
import {
  createReportDownload,
  REPORT_KEYS,
  EXPORT_FORMATS,
} from './export';
import { DATE_PRESETS } from './dates';
import { LEAVE_TYPES } from './tools/leave';
import type { ChatContext } from './types';

type JsonSchema = Record<string, unknown>;

/** Date-range properties shared by every period-scoped tool. */
const RANGE_PROPS: JsonSchema = {
  preset: {
    type: ['string', 'null'],
    enum: [...DATE_PRESETS, null],
    description:
      'Named period. Use this for relative phrases like "last month". Defaults to this_month when null.',
  },
  from_date: {
    type: ['string', 'null'],
    description: 'Start date YYYY-MM-DD. Required only when preset is "custom".',
  },
  to_date: {
    type: ['string', 'null'],
    description: 'End date YYYY-MM-DD, inclusive. Required only when preset is "custom".',
  },
};
const RANGE_KEYS = ['preset', 'from_date', 'to_date'];

const SCOPE_PROPS: JsonSchema = {
  employee_ids: {
    type: ['array', 'null'],
    items: { type: 'integer' },
    description:
      'Numeric employee ids from resolve_employee. Null means all employees.',
  },
  department: {
    type: ['string', 'null'],
    description: 'Exact department name from list_departments. Null means all.',
  },
};
const SCOPE_KEYS = ['employee_ids', 'department'];

function schema(props: JsonSchema, keys: string[]): JsonSchema {
  return {
    type: 'object',
    properties: props,
    required: keys,
    additionalProperties: false,
  };
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
  handler: (ctx: ChatContext, args: Record<string, unknown>) => Promise<unknown>;
}

export const TOOLS: ToolSpec[] = [
  {
    name: 'resolve_employee',
    description:
      'Find employees by name fragment or exact employee ID. ALWAYS call this first when a question names a person — other tools need the numeric id. Returns every match; if more than one comes back, ask the user which they meant instead of picking one.',
    parameters: schema(
      {
        search: { type: 'string', description: 'Name fragment or exact emp_id.' },
        include_inactive: {
          type: ['boolean', 'null'],
          description: 'Include deactivated employees. Defaults to false.',
        },
      },
      ['search', 'include_inactive'],
    ),
    handler: (ctx, a) =>
      resolveEmployee(ctx, {
        search: String(a.search ?? ''),
        include_inactive: Boolean(a.include_inactive),
      }),
  },
  {
    name: 'get_employee_profile',
    description:
      'Profile for one employee: department, role, current shift, work location, work mode. Does not include salary, bank, PAN or Aadhaar details — those are not available to this assistant.',
    parameters: schema(
      { employee_id: { type: 'integer' } },
      ['employee_id'],
    ),
    handler: (ctx, a) =>
      getEmployeeProfile(ctx, { employee_id: Number(a.employee_id) }),
  },
  {
    name: 'list_departments',
    description:
      'All departments with active headcount. Use to check an exact department name before filtering by it.',
    parameters: schema({}, []),
    handler: ctx => listDepartments(ctx),
  },
  {
    name: 'get_attendance_summary',
    description:
      'Per-employee attendance totals over a period: days present, late, absent, on leave, and total hours worked. This is the main report tool for both one person and a group.',
    parameters: schema(
      { ...RANGE_PROPS, ...SCOPE_PROPS },
      [...RANGE_KEYS, ...SCOPE_KEYS],
    ),
    handler: (ctx, a) => getAttendanceSummary(ctx, a),
  },
  {
    name: 'get_attendance_detail',
    description:
      'Day-by-day attendance for ONE employee: date, status, clock-in/out times in IST, hours, session count, geofence status.',
    parameters: schema(
      { employee_id: { type: 'integer' }, ...RANGE_PROPS },
      ['employee_id', ...RANGE_KEYS],
    ),
    handler: (ctx, a) =>
      getAttendanceDetail(ctx, { ...a, employee_id: Number(a.employee_id) }),
  },
  {
    name: 'get_daily_snapshot',
    description:
      'Who was present, late, absent or on leave on ONE date, with status totals. Use for "who is in today".',
    parameters: schema(
      {
        date: {
          type: ['string', 'null'],
          description: 'YYYY-MM-DD. Null means today (IST).',
        },
        department: SCOPE_PROPS.department,
      },
      ['date', 'department'],
    ),
    handler: (ctx, a) => getDailySnapshot(ctx, a),
  },
  {
    name: 'get_late_arrivals',
    description:
      'Employees ranked by number of late days over a period, most late first.',
    parameters: schema(
      { ...RANGE_PROPS, ...SCOPE_PROPS },
      [...RANGE_KEYS, ...SCOPE_KEYS],
    ),
    handler: (ctx, a) => getLateArrivals(ctx, a),
  },
  {
    name: 'get_absentees',
    description:
      'Employees ranked by number of absent days over a period, most absent first.',
    parameters: schema(
      { ...RANGE_PROPS, ...SCOPE_PROPS },
      [...RANGE_KEYS, ...SCOPE_KEYS],
    ),
    handler: (ctx, a) => getAbsentees(ctx, a),
  },
  {
    name: 'get_department_rollup',
    description:
      'Attendance statistics grouped by department over a period: headcount, present/late/absent days, total and average hours. Use for team or company-wide comparisons.',
    parameters: schema(RANGE_PROPS, RANGE_KEYS),
    handler: (ctx, a) => getDepartmentRollup(ctx, a),
  },
  {
    name: 'get_geofence_exceptions',
    description:
      'Clock-ins recorded outside the permitted work-location geofence over a period.',
    parameters: schema(
      { ...RANGE_PROPS, ...SCOPE_PROPS },
      [...RANGE_KEYS, ...SCOPE_KEYS],
    ),
    handler: (ctx, a) => getGeofenceExceptions(ctx, a),
  },
  {
    name: 'get_leave_records',
    description:
      'Personal leave taken over a period (casual, sick, earned, other). Company-wide holidays are NOT included — use get_holidays for those.',
    parameters: schema(
      {
        ...RANGE_PROPS,
        ...SCOPE_PROPS,
        leave_type: {
          type: ['string', 'null'],
          enum: [...LEAVE_TYPES, null],
          description: 'Filter to one leave type. Null means all except holiday.',
        },
      },
      [...RANGE_KEYS, ...SCOPE_KEYS, 'leave_type'],
    ),
    handler: (ctx, a) => getLeaveRecords(ctx, a),
  },
  {
    name: 'get_holidays',
    description: 'Company-wide holidays falling in a period.',
    parameters: schema(RANGE_PROPS, RANGE_KEYS),
    handler: (ctx, a) => getHolidays(ctx, a),
  },
  {
    name: 'get_leave_balance',
    description:
      'Leave quota versus leave taken for ONE employee in a calendar year, by type, with remaining balance.',
    parameters: schema(
      {
        employee_id: { type: 'integer' },
        year: {
          type: ['integer', 'null'],
          description: 'Calendar year. Null means the current year.',
        },
      },
      ['employee_id', 'year'],
    ),
    handler: (ctx, a) =>
      getLeaveBalance(ctx, {
        employee_id: Number(a.employee_id),
        year: a.year == null ? undefined : Number(a.year),
      }),
  },
  {
    name: 'get_shifts',
    description:
      'All configured shifts with timings, required hours, grace period and working days.',
    parameters: schema({}, []),
    handler: ctx => getShifts(ctx),
  },
  {
    name: 'get_schedule',
    description:
      'Shift and work-location assignment history for ONE employee, newest first, flagging which is current.',
    parameters: schema({ employee_id: { type: 'integer' } }, ['employee_id']),
    handler: (ctx, a) => getSchedule(ctx, { employee_id: Number(a.employee_id) }),
  },
  {
    name: 'get_live_tracking_status',
    description:
      'Which employees have live tracking active right now and how fresh their signal is. Reports STATUS ONLY — it does not return locations or movement history.',
    parameters: schema({}, []),
    handler: ctx => getLiveTrackingStatus(ctx),
  },
  {
    name: 'get_audit_trail',
    description:
      'Record of administrative changes over a period: who did what to which record, and when. Does not return the changed values themselves.',
    parameters: schema(
      {
        ...RANGE_PROPS,
        entity: {
          type: ['string', 'null'],
          description: 'Filter by entity, e.g. "attendance", "employee". Null means all.',
        },
        performed_by: {
          type: ['integer', 'null'],
          description: 'Filter by the employee id who made the change.',
        },
      },
      [...RANGE_KEYS, 'entity', 'performed_by'],
    ),
    handler: (ctx, a) => getAuditTrail(ctx, a),
  },
  {
    name: 'create_report_download',
    description:
      'Produce a downloadable report file (Excel .xlsx, .csv, or .pdf) and return a link. Use whenever the user asks to download, export, or be sent a report, or asks for it "in Excel". Pick the report whose contents match what they asked for. The link is returned to you — present it to the user and say what it contains. Runs the report first, so if there is no data it tells you that instead of producing an empty file.',
    parameters: schema(
      {
        report: {
          type: 'string',
          enum: REPORT_KEYS,
          description:
            'Which report to export. attendance_summary = per-employee totals; attendance_detail = one employee day-by-day; daily_snapshot = one date; late_arrivals / absentees = ranked lists; department_rollup = per-department; geofence_exceptions; leave_records; leave_balance.',
        },
        format: {
          type: 'string',
          enum: [...EXPORT_FORMATS],
          description:
            'xlsx for Excel (default choice when the user says "Excel" or does not specify), csv for raw data, pdf for something to print or circulate.',
        },
        employee_id: {
          type: ['integer', 'null'],
          description:
            'Required for attendance_detail and leave_balance. Null otherwise.',
        },
        ...RANGE_PROPS,
        department: SCOPE_PROPS.department,
        date: {
          type: ['string', 'null'],
          description: 'YYYY-MM-DD — only for the daily_snapshot report.',
        },
        year: {
          type: ['integer', 'null'],
          description: 'Calendar year — only for the leave_balance report.',
        },
      },
      ['report', 'format', 'employee_id', ...RANGE_KEYS, 'department', 'date', 'year'],
    ),
    handler: (ctx, a) =>
      createReportDownload(ctx, {
        report: String(a.report),
        format: a.format as 'xlsx' | 'csv' | 'pdf',
        ...a,
      }),
  },
];

const BY_NAME = new Map(TOOLS.map(t => [t.name, t]));

/** Strip nulls so nullable-for-strict-mode args become absent args. */
function stripNulls(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Execute a tool call by name. An unknown name is a hard error — the model
 * cannot invent a data source.
 */
export async function dispatch(
  ctx: ChatContext,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = BY_NAME.get(name);
  if (!tool) {
    throw new Error(`No such tool: ${name}. No data is available for that request.`);
  }
  return tool.handler(ctx, stripNulls(args));
}

/** Tool definitions in OpenAI Chat Completions shape. */
export function openAiTools() {
  return TOOLS.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: true,
    },
  }));
}

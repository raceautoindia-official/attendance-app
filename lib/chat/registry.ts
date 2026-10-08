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
import {
  listPoliciesTool, getEmployeePolicyTool, getPerformanceTool, getDocumentComplianceTool,
} from './tools/policies';
import { getHoursLedger } from './tools/hours';
import { buildChart } from './tools/charts';
import { CHART_TYPES, CHART_UNITS } from '@/lib/charts/types';
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
    name: 'get_hours_ledger',
    description:
      'Required hours vs hours actually worked for ONE employee, with the shortage already worked out. '
      + 'Use this for ANY question about how much somebody worked, whether they are short or ahead, '
      + 'their average working day, their longest or shortest day, how many days fell short, or how '
      + 'their hours compare with what their shift requires. Every duration comes back both as minutes '
      + 'and as a ready-to-quote string, so you never need to add, subtract or convert anything. '
      + 'It returns TWO different shortage figures and they can disagree: `net_display` compares the '
      + 'period totals, while `daily_shortfall_display` adds up only the days that fell short, giving '
      + 'no credit for long days. Someone can be ahead for the month and still have missed a day. '
      + 'Quote `month_verdict` for the overall position and mention the daily shortfall when it differs.',
    parameters: schema(
      {
        employee_id: { type: 'integer' },
        include_days: {
          type: ['boolean', 'null'],
          description:
            'True to also return every day in the period. Leave null unless the user asked for a '
            + 'day-by-day breakdown — the worst short days always come back regardless.',
        },
        ...RANGE_PROPS,
      },
      ['employee_id', 'include_days', ...RANGE_KEYS],
    ),
    handler: (ctx, a) =>
      getHoursLedger(ctx, {
        ...a,
        employee_id: Number(a.employee_id),
        include_days: a.include_days === true,
      }),
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
    name: 'list_policies',
    description:
      'Every policy (scheme) and what it sets: monthly hours, hours basis, week offs, '
      + 'default shift, grace, and which statutory deductions apply. Also says how many '
      + 'employees are on each, and how many are on none. Use for "what policies exist", '
      + 'what does a given policy say, and who is on no policy.',
    parameters: schema({}, []),
    handler: ctx => listPoliciesTool(ctx),
  },
  {
    name: 'get_employee_policy',
    description:
      'Which policy one employee is on, with the full history of what they were on before. '
      + 'Also reports the shift they are ACTUALLY rostered on beside the one their policy '
      + 'names, because those two disagreeing is the commonest confusion: the schedule '
      + 'decides what is worked and judged, the policy default does not. Call '
      + 'resolve_employee first to get the id.',
    parameters: schema({ employee_id: { type: 'integer' } }, ['employee_id']),
    handler: (ctx, a) => getEmployeePolicyTool(ctx, { employee_id: Number(a.employee_id) }),
  },
  {
    name: 'get_performance_scores',
    description:
      'Performance scores for a period, ranked: attendance, punctuality and hours delivered, '
      + 'weighted by the policy each employee is on. Use for best performers, who scored '
      + 'highest, rank the team, how did X perform. '
      + 'IMPORTANT: a null punctuality or null '
      + 'late_days means lateness COULD NOT BE MEASURED (flexible shift) — report it as not '
      + 'measured, never as zero and never as a clean record.',
    parameters: schema(
      {
        policy_id: { type: ['integer', 'null'], description: 'Rank only people on this policy.' },
        ...RANGE_PROPS,
      },
      ['policy_id', ...RANGE_KEYS],
    ),
    handler: (ctx, a) => getPerformanceTool(ctx, {
      policy_id: a.policy_id === undefined ? undefined : Number(a.policy_id),
      preset: a.preset as never,
      from_date: a.from_date as string | undefined,
      to_date: a.to_date as string | undefined,
    }),
  },  {
    name: 'get_document_compliance',
    description:
      'Which employees are missing required documents (Aadhaar, PAN, government ID and so '
      + 'on). What each person must hold is derived from the statutory flags on their policy. '
      + 'Use for who is missing documents, document compliance, has everyone given PAN.',
    parameters: schema(
      { only_incomplete: { type: ['boolean', 'null'], description: 'Only people with something missing.' } },
      ['only_incomplete'],
    ),
    handler: (ctx, a) => getDocumentComplianceTool(ctx, { only_incomplete: Boolean(a.only_incomplete) }),
  },
  {
    name: 'build_chart',
    description:
      'Draw a chart of figures you have ALREADY read from another tool. Use it whenever a '
      + 'picture answers better than a table — comparing people or departments, a share of a '
      + 'whole, or a trend over days or months — and whenever the user asks for a chart, graph, '
      + 'pie or visual. Every value must be copied from a tool result; never chart a number you '
      + 'worked out or assumed. Choose the form by the job: "bar" to compare amounts between '
      + 'people (the safe default), "column" for days or months side by side and for comparing '
      + 'two measures such as worked against required, "line" for a trend over time, "pie" ONLY '
      + 'for a share of a whole with at most six parts that differ clearly, "stacked_bar" for how '
      + 'one total splits up. After calling it, describe what the chart shows in a sentence — the '
      + 'chart itself carries the numbers.',
    parameters: schema(
      {
        type: {
          type: 'string',
          enum: [...CHART_TYPES],
          description: 'bar | column | line | pie | stacked_bar — see the guidance above.',
        },
        title: { type: 'string', description: 'What the chart shows, e.g. "Hours worked, September 2026".' },
        subtitle: {
          type: ['string', 'null'],
          description: 'Optional second line, usually the period or the scope.',
        },
        unit: {
          type: 'string',
          enum: [...CHART_UNITS],
          description:
            'minutes (rendered as "8h 30m" — use this for any duration), hours, days, count, percent.',
        },
        series: {
          type: 'array',
          description:
            'One entry for a single measure. Two or more to compare measures — for example a '
            + '"Worked" series and a "Required" series sharing the same day labels. pie and '
            + 'stacked_bar take exactly one.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              label: { type: 'string', description: 'Series name, shown in the legend.' },
              points: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    label: { type: 'string', description: 'The person, department, date or category.' },
                    value: { type: 'number', description: 'The figure, in the declared unit.' },
                  },
                  required: ['label', 'value'],
                },
              },
            },
            required: ['label', 'points'],
          },
        },
        note: {
          type: ['string', 'null'],
          description: 'Optional caveat printed under the chart, e.g. what the period excludes.',
        },
      },
      ['type', 'title', 'subtitle', 'unit', 'series', 'note'],
    ),
    handler: (ctx, a) => buildChart(ctx, a),
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
            'The ONE employee, for attendance_detail and leave_balance only. Null otherwise.',
        },
        employee_ids: {
          type: ['array', 'null'],
          items: { type: 'integer' },
          description:
            'Narrow the report to these employees. ALWAYS set this when the user asked about '
            + 'specific people — "export Reena\'s summary to Excel" is attendance_summary with '
            + 'employee_ids: [her id], NOT the whole company. Resolve names with resolve_employee '
            + 'first. Null means every employee. Works with attendance_summary, late_arrivals, '
            + 'absentees, geofence_exceptions and leave_records.',
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
      ['report', 'format', 'employee_id', 'employee_ids', ...RANGE_KEYS, 'department', 'date', 'year'],
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

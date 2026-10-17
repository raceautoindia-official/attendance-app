import { query } from '@/lib/db';
import { toYmd } from '@/lib/date';
import { findExceptions } from '@/lib/exceptions';
import { listAlerts } from '@/lib/alerts';
import { hasPermissionTable } from '@/lib/permissions';
import {
  hasOutOfFenceReviewColumns, hasOutOfFenceReasonColumn,
} from '@/lib/employeeDetails';

/**
 * lib/inbox.ts — everything waiting on a decision, in one queue.
 *
 * WHY
 * ---
 * Five separate rail entries meant "somebody is waiting on you": Notifications
 * (off-site clock-ins), Permissions (requests), Regularisations (correction
 * requests, which was not even in the menu), Review (the month's exceptions,
 * also not in the menu), and the exception strip on the attendance page.
 *
 * Nothing said which to open, and nothing anywhere said HOW LONG something had
 * been waiting. A permission request sat untouched because the only way to find
 * out it existed was to go looking for it.
 *
 * This reads the same tables those pages read - it is a second view, never a
 * second source of truth - and adds the one fact none of them carried: the age
 * of the oldest thing nobody has dealt with.
 *
 * IT DOES NOT DECIDE ANYTHING
 * ---------------------------
 * Every row links to the page that owns the decision, because that page holds
 * the domain rules: a permission request has to be checked against the monthly
 * hours cap, a correction rewrites an attendance row under an audit entry.
 * Duplicating either here would eventually mean two answers. The inbox finds
 * the work; the owning page does it.
 */

export type InboxKind =
  | 'permission_request'
  | 'on_duty_request'
  | 'regularisation'
  | 'off_site_review'
  | 'month_exception'
  | 'alert';

export type InboxSeverity = 'critical' | 'warning' | 'info';

export interface InboxItem {
  /** Stable across refreshes, so the UI can key and the user can be linked to one. */
  id: string;
  kind: InboxKind;
  severity: InboxSeverity;
  employee: { id: number; name: string; emp_id: string } | null;
  title: string;
  detail: string;
  /** What to do about it, in the imperative. */
  action: string;
  /** Where the decision is made. */
  href: string;
  /** When it started waiting, UTC ISO. Null for things with no clock. */
  waiting_since: string | null;
  /** Set for an alert, which is acknowledged here rather than elsewhere. */
  alert_id?: number;
  /** Whole days since then. The number nobody could see before. */
  waiting_days: number | null;
}

export interface InboxSummary {
  items: InboxItem[];
  counts: {
    total: number;
    decisions: number;
    reviews: number;
    by_kind: Record<InboxKind, number>;
  };
  /** The longest anything has been waiting, in days. */
  oldest_days: number | null;
  /** True when there is nothing at all, which is worth saying out loud. */
  clear: boolean;
}

const KINDS: InboxKind[] = [
  'alert', 'permission_request', 'on_duty_request', 'regularisation',
  'off_site_review', 'month_exception',
];

/** Whole days between then and now, floored, never negative. */
function waitingDays(since: Date | string | null): number | null {
  if (!since) return null;
  const then = since instanceof Date ? since : new Date(`${String(since).replace(' ', 'T')}Z`);
  if (Number.isNaN(then.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - then.getTime()) / 86_400_000));
}

function iso(at: Date | string | null): string | null {
  if (!at) return null;
  const d = at instanceof Date ? at : new Date(`${String(at).replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const hhmm = (t: string | null) => (t ? String(t).slice(0, 5) : '--');

/**
 * Build the queue.
 *
 * `scope` is a WHERE fragment from `employeeScopeSql` — '1 = 1' when the caller
 * sees everybody, which is everybody today. It is applied to each source query
 * rather than filtered afterwards, so a manager's inbox never carries a row
 * they would be refused on opening.
 */
export async function buildInbox(opts: {
  /**
   * Which employees the caller may see: a list of ids, or 'all'.
   *
   * ONE scope for the whole queue, not a WHERE fragment per source. It used to
   * take a ready-made `scopeSql` plus a second one for the alerts table, whose
   * column differs - and a caller that passed the first and forgot the second
   * got a correctly narrowed list of requests beside an unnarrowed list of
   * alerts. The test that caught it was testing something else. Ids in, clauses
   * built here, nothing to forget.
   */
  visible?: number[] | 'all';
  /** Month for the review block, YYYY-MM. Defaults to the one just finished. */
  reviewMonth?: string;
  includeReview?: boolean;
} = {}): Promise<InboxSummary> {
  const visible = opts.visible ?? 'all';
  // '1 = 0' for an empty list, never '1 = 1': no permission must mean no rows,
  // and `IN ()` is not even valid SQL.
  const clauseFor = (column: string): { sql: string; params: number[] } =>
    visible === 'all'
      ? { sql: '1 = 1', params: [] }
      : visible.length === 0
        ? { sql: '1 = 0', params: [] }
        : { sql: `${column} IN (${visible.map(() => '?').join(',')})`, params: visible };

  const { sql: scopeSql, params: scopeParams } = clauseFor('e.id');
  const items: InboxItem[] = [];

  // --- Permission and on-duty requests -----------------------------------
  if (await hasPermissionTable()) {
    const rows = await query<{
      id: number; employee_id: number; name: string; emp_id: string;
      request_type: 'permission' | 'on_duty'; permission_date: Date | string;
      start_time: string | null; end_time: string | null; minutes: number | null;
      reason: string | null; created_at: Date | string;
    }>(
      `SELECT pr.id, pr.employee_id, e.name, e.emp_id, pr.request_type,
              pr.permission_date, pr.start_time, pr.end_time, pr.minutes,
              pr.reason, pr.created_at
         FROM permission_requests pr
         JOIN employees e ON e.id = pr.employee_id
        WHERE pr.status = 'pending' AND ${scopeSql}
        ORDER BY pr.created_at`,
      scopeParams,
    );
    for (const r of rows) {
      const onDuty = r.request_type === 'on_duty';
      const days = waitingDays(r.created_at);
      items.push({
        id: `permission:${r.id}`,
        kind: onDuty ? 'on_duty_request' : 'permission_request',
        // A request nobody has answered for three days is a different thing
        // from one that arrived this morning, and should not look the same.
        severity: (days ?? 0) >= 2 ? 'critical' : 'warning',
        employee: { id: r.employee_id, name: r.name, emp_id: r.emp_id },
        title: onDuty
          ? `${r.name} asks to be on duty off-site`
          : `${r.name} asks for time off`,
        detail: `${toYmd(r.permission_date)}, ${hhmm(r.start_time)}-${hhmm(r.end_time)}`
          + `${r.minutes ? ` (${r.minutes} min)` : ''}`
          + `${r.reason ? ` - "${r.reason}"` : ''}`,
        action: 'Decide',
        href: '/permissions',
        waiting_since: iso(r.created_at),
        waiting_days: days,
      });
    }
  }

  // --- Attendance correction requests ------------------------------------
  const regs = await query<{
    id: number; employee_id: number; name: string; emp_id: string;
    work_date: Date | string; reason: string | null; created_at: Date | string;
  }>(
    `SELECT rr.id, rr.employee_id, e.name, e.emp_id, rr.work_date, rr.reason, rr.created_at
       FROM regularisation_requests rr
       JOIN employees e ON e.id = rr.employee_id
      WHERE rr.status = 'pending' AND ${scopeSql}
      ORDER BY rr.created_at`,
    scopeParams,
  );
  for (const r of regs) {
    const days = waitingDays(r.created_at);
    items.push({
      id: `regularisation:${r.id}`,
      kind: 'regularisation',
      severity: (days ?? 0) >= 2 ? 'critical' : 'warning',
      employee: { id: r.employee_id, name: r.name, emp_id: r.emp_id },
      title: `${r.name} asks to correct ${toYmd(r.work_date)}`,
      detail: r.reason ? `"${r.reason}"` : 'No reason given.',
      action: 'Review',
      href: '/regularisations',
      waiting_since: iso(r.created_at),
      waiting_days: days,
    });
  }

  // --- Off-site clock-ins nobody has looked at ---------------------------
  // Both columns are checked because this feature arrived in two migrations,
  // and a deployment that has one and not the other must not 500.
  if (await hasOutOfFenceReviewColumns()) {
    const hasReason = await hasOutOfFenceReasonColumn();
    const rows = await query<{
      id: number; employee_id: number; name: string; emp_id: string;
      work_date: Date | string; clock_in_utc: Date | string | null; reason: string | null;
    }>(
      `SELECT a.id, a.employee_id, e.name, e.emp_id, a.work_date, a.clock_in_utc,
              ${hasReason ? 'a.out_of_fence_reason' : 'NULL'} AS reason
         FROM attendance a
         JOIN employees e ON e.id = a.employee_id
        WHERE a.out_of_fence_status = 'pending'
          AND a.geofence_status = 'outside'
          AND ${scopeSql}
        ORDER BY a.work_date DESC, a.clock_in_utc DESC
        LIMIT 100`,
      scopeParams,
    );
    for (const r of rows) {
      const days = waitingDays(r.clock_in_utc);
      items.push({
        id: `offsite:${r.id}`,
        kind: 'off_site_review',
        severity: (days ?? 0) >= 2 ? 'critical' : 'warning',
        employee: { id: r.employee_id, name: r.name, emp_id: r.emp_id },
        title: `${r.name} clocked in away from site`,
        detail: `${toYmd(r.work_date)}${r.reason ? ` - "${r.reason}"` : ' - no reason recorded'}`,
        action: 'Review',
        href: '/notifications',
        waiting_since: iso(r.clock_in_utc),
        waiting_days: days,
      });
    }
  }

  // --- Alerts -------------------------------------------------------------
  //
  // The one kind decided HERE rather than elsewhere: an alert has no owning
  // page, because it is not a request anybody made. Acknowledging it with a
  // note is the whole of the decision, so the button is in the queue.
  //
  // Snoozed ones are left out. The fact is still true and the row still says
  // so; it is simply not today's problem.
  // Built from the same ids, against this table's own column.
  const alertScope = clauseFor('a.employee_id');
  const alerts = await listAlerts({
    scopeSql: alertScope.sql,
    scopeParams: alertScope.params,
    states: ['open'],
  });
  for (const a of alerts) {
    items.push({
      id: `alert:${a.id}`,
      kind: 'alert',
      severity: a.severity,
      employee: a.employee_id && a.employee_name && a.emp_id
        ? { id: a.employee_id, name: a.employee_name, emp_id: a.emp_id }
        : null,
      title: a.title,
      detail: a.body,
      action: 'Acknowledge',
      href: '/inbox',
      alert_id: a.id,
      waiting_since: iso(a.first_seen_at),
      waiting_days: waitingDays(a.first_seen_at),
    });
  }

  // --- What would be worth noticing before the month is closed -----------
  //
  // Only the critical ones. The full list belongs on Month review, and an
  // inbox that carries forty informational rows stops being read - which is
  // the failure the old Notifications page was already drifting towards.
  if (opts.includeReview !== false) {
    const month = opts.reviewMonth ?? previousMonth();
    const [y, m] = month.split('-').map(Number);
    const from = `${month}-01`;
    const to = toYmd(new Date(Date.UTC(y, m, 0)));
    const report = await findExceptions(from, to);
    for (const e of report.exceptions.filter(x => x.severity === 'critical')) {
      items.push({
        id: `exception:${e.id}`,
        kind: 'month_exception',
        severity: 'critical',
        employee: e.employee,
        title: e.title,
        detail: `${e.detail} ${e.action}`.trim(),
        action: 'Look into it',
        href: '/review',
        // An exception is a fact about a period, not something with an arrival
        // time. Claiming it has waited N days would be inventing a clock.
        waiting_since: null,
        waiting_days: null,
      });
    }
  }

  // Oldest first, and criticals above warnings: the point of the queue is that
  // the thing most overdue is the thing you see.
  const rank: Record<InboxSeverity, number> = { critical: 0, warning: 1, info: 2 };
  items.sort((a, b) =>
    rank[a.severity] - rank[b.severity]
    || (b.waiting_days ?? -1) - (a.waiting_days ?? -1));

  const by_kind = Object.fromEntries(KINDS.map(k => [k, 0])) as Record<InboxKind, number>;
  for (const i of items) by_kind[i.kind] += 1;

  const ages = items.map(i => i.waiting_days).filter((d): d is number => d !== null);

  return {
    items,
    counts: {
      total: items.length,
      decisions: items.filter(i => i.kind !== 'month_exception').length,
      reviews: by_kind.month_exception,
      by_kind,
    },
    oldest_days: ages.length > 0 ? Math.max(...ages) : null,
    clear: items.length === 0,
  };
}

/**
 * The month that has just finished.
 *
 * The review block defaults to it rather than to the current month because an
 * exception in a month still running is usually just a month still running.
 */
export function previousMonth(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Just the number, for the rail badge.
 *
 * Counts DECISIONS only - things a person is waiting on. Month exceptions are
 * not waiting on anybody in particular, and including them meant a badge that
 * never went to zero, which is a badge nobody believes.
 */
export async function inboxPendingCount(opts: {
  visible?: number[] | 'all';
} = {}): Promise<number> {
  const summary = await buildInbox({ ...opts, includeReview: false });
  return summary.counts.decisions;
}

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { zBool } from '@/lib/zodFields';
import { requireAuth } from '@/lib/auth';
import { resolveAccess, can } from '@/lib/access';
import { narrowToVisible } from '@/lib/accessFilter';
import {
  listAlerts, listRules, acknowledgeAlert, snoozeAlert, setRuleEnabled,
  runAlerts, selfPhrasing, AlertError, type AlertRow,
} from '@/lib/alerts';
import type { ApiResponse } from '@/lib/types';

/**
 * /api/alerts
 *
 *   GET                  the open alerts this caller may see, plus the catalogue
 *   GET ?mine=1          the caller's OWN alerts, phrased for them
 *   POST {action}        acknowledge | snooze | set_rule | run
 *
 * `?mine=1` is readable by an ordinary employee and returns only their own
 * rows, re-worded in the second person. That is the whole reason it exists:
 * "you have been late four times this month" is something somebody can act on,
 * and reaches them before their manager has to raise it.
 */

const BodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('acknowledge'),
    id: z.number().int().positive(),
    note: z.string().max(500).optional(),
  }),
  z.object({
    action: z.literal('snooze'),
    id: z.number().int().positive(),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  }),
  z.object({
    action: z.literal('set_rule'),
    rule_key: z.string().min(1).max(40),
    enabled: zBool,
  }),
  // Evaluating on demand, for the administrator who has just set a threshold
  // and reasonably expects to see whether it caught anything.
  z.object({
    action: z.literal('run'),
    family: z.enum(['live', 'pattern', 'lifecycle']).optional(),
  }),
]);

function ipOf(request: NextRequest): string | null {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? request.headers.get('x-real-ip') ?? null;
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['employee', 'manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const sp = new URL(request.url).searchParams;

  // --- An employee reading their own ---------------------------------------
  if (sp.get('mine') === '1') {
    const mine = await listAlerts({ employeeId: auth.id, states: ['open'] });
    const worded = mine
      .map(row => ({ row, self: selfPhrasing(row) }))
      .filter((x): x is { row: AlertRow; self: { title: string; body: string } } => x.self !== null)
      .map(({ row, self }) => ({
        id: row.id,
        rule_key: row.rule_key,
        severity: row.severity,
        period_key: row.period_key,
        title: self.title,
        body: self.body,
      }));
    return NextResponse.json<ApiResponse<{ alerts: typeof worded }>>({
      success: true, data: { alerts: worded },
    });
  }

  // --- An administrator reading the queue ---------------------------------
  const ctx = await resolveAccess(auth.id);
  if (!can(ctx, 'alerts.view')) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'You do not have permission to see alerts (alerts.view).' },
      { status: 403 },
    );
  }

  const scope = await narrowToVisible(auth.id, 'alerts.view', 'a.employee_id');
  const alerts = await listAlerts({
    scopeSql: scope.sql,
    scopeParams: scope.params,
    includeSnoozed: sp.get('include_snoozed') === '1',
    states: sp.get('state') === 'all'
      ? ['open', 'acknowledged', 'resolved']
      : ['open', 'acknowledged'],
  });

  const counts = {
    total: alerts.length,
    open: alerts.filter(a => a.state === 'open').length,
    critical: alerts.filter(a => a.severity === 'critical' && a.state === 'open').length,
    warning: alerts.filter(a => a.severity === 'warning' && a.state === 'open').length,
    info: alerts.filter(a => a.severity === 'info' && a.state === 'open').length,
  };

  return NextResponse.json<ApiResponse<{
    alerts: AlertRow[];
    rules: Awaited<ReturnType<typeof listRules>>;
    counts: typeof counts;
    scope_note: string | null;
    can_manage: boolean;
  }>>({
    success: true,
    data: {
      alerts,
      rules: sp.get('rules') === '0' ? [] : await listRules(),
      counts,
      scope_note: scope.note,
      can_manage: can(ctx, 'alerts.manage'),
    },
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const ctx = await resolveAccess(auth.id);
  if (!can(ctx, 'alerts.manage')) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'You do not have permission to clear alerts (alerts.manage).' },
      { status: 403 },
    );
  }

  let body: unknown;
  try { body = await request.json(); }
  catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return NextResponse.json<ApiResponse>(
      { success: false, error: `${String(i?.path.join('.') || 'Request')}: ${i?.message}` },
      { status: 400 },
    );
  }

  try {
    const ip = ipOf(request);
    switch (parsed.data.action) {
      case 'acknowledge':
        await acknowledgeAlert({
          id: parsed.data.id, by: auth.id, note: parsed.data.note ?? null, ip,
        });
        break;
      case 'snooze':
        await snoozeAlert({ id: parsed.data.id, until: parsed.data.until, by: auth.id, ip });
        break;
      case 'set_rule':
        await setRuleEnabled({
          ruleKey: parsed.data.rule_key, enabled: parsed.data.enabled, by: auth.id, ip,
        });
        break;
      case 'run': {
        const summary = await runAlerts({ family: parsed.data.family });
        return NextResponse.json<ApiResponse<typeof summary>>({ success: true, data: summary });
      }
    }
    return NextResponse.json<ApiResponse>({ success: true });
  } catch (err) {
    if (err instanceof AlertError) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: err.message }, { status: 400 });
    }
    console.error('[alerts] POST failed:', err);
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Could not update the alert.' }, { status: 500 });
  }
}

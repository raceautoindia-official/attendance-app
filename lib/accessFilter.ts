import { resolveAccess, visibleEmployeeIds, type AccessContext } from '@/lib/access';

/**
 * lib/accessFilter.ts — narrowing a list to what the caller may see.
 *
 * The scope arithmetic lives in lib/access.ts and is tested there. This is the
 * piece route handlers actually call, and it exists so that enforcement is one
 * line per endpoint rather than a paragraph each handler writes slightly
 * differently.
 *
 * IT IS INERT UNTIL SOMEBODY IS GIVEN A ROLE.
 *
 * `resolveAccess` falls back to the legacy `employees.role` for anybody with
 * no row in `employee_roles` — which is everybody today — and this helper
 * returns "no narrowing" for them. So applying it to an endpoint changes
 * nothing for the current users, and starts applying the moment an
 * administrator grants somebody a role. That is the same discipline the
 * policy system shipped under, and it is what makes it safe to wire this into
 * live endpoints before the organisation chart is filled in.
 *
 * The alternative — enforce for everybody immediately — would mean every
 * manager sees only themselves until all 18 unplaced people are placed, which
 * looks exactly like a broken page.
 */

export interface ScopeNarrowing {
  /** False when the caller's access is unrestricted, or still on the fallback. */
  applied: boolean;
  /** A fragment for a WHERE clause, and its parameters. */
  sql: string;
  params: number[];
  /** Carried into the response so a reader knows the list is narrowed. */
  note: string | null;
  ctx: AccessContext;
}

/**
 * Work out how a list must be narrowed for this caller.
 *
 * `column` is the employee-id column in the caller's query, e.g. `e.id` or
 * `a.employee_id`. The returned `sql` is always a valid boolean expression —
 * `1 = 1` when nothing is restricted — so a caller can splice it in
 * unconditionally and cannot accidentally omit it.
 */
export async function narrowToVisible(
  employeeId: number,
  permission: string,
  column: string,
  onDate?: string,
): Promise<ScopeNarrowing> {
  const ctx = await resolveAccess(employeeId);

  // Super admins, and anybody still on the legacy fallback, are unchanged.
  // Enforcing against the fallback would silently re-scope every existing
  // user the moment this shipped.
  if (ctx.isSuperAdmin || !ctx.explicit) {
    return { applied: false, sql: '1 = 1', params: [], note: null, ctx };
  }

  const visible = await visibleEmployeeIds(ctx, permission, onDate);

  if (visible === 'all') {
    return { applied: false, sql: '1 = 1', params: [], note: null, ctx };
  }

  if (visible.length === 0) {
    // No grant means no rows, never "no filter". A mistake here must fail
    // towards showing nothing.
    return {
      applied: true, sql: '1 = 0', params: [],
      note: 'You do not have permission to see these records.',
      ctx,
    };
  }

  const scope = ctx.grants.get(permission);
  return {
    applied: true,
    sql: `${column} IN (${visible.map(() => '?').join(',')})`,
    params: visible,
    note: scope === 'self'
      ? 'Showing your own records only.'
      : scope === 'team'
        ? `Showing your team only (${visible.length} people).`
        : `Showing your department and everything below it (${visible.length} people).`,
    ctx,
  };
}

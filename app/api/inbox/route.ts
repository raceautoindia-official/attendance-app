import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { resolveAccess } from '@/lib/access';
import { narrowToVisible } from '@/lib/accessFilter';
import { buildInbox, previousMonth, type InboxSummary } from '@/lib/inbox';
import type { ApiResponse } from '@/lib/types';

/**
 * GET /api/inbox — everything waiting on a decision.
 *
 *   ?month=YYYY-MM   which month the review block covers (default: last month)
 *   ?count=1         just the badge number, which the rail asks for every minute
 *
 * Narrowed to what the caller may see, through the same helper every other
 * list uses: a manager with a real role sees their own department's requests,
 * and anybody still on the legacy fallback sees what they see today. An inbox
 * that offered a row and then refused it on opening would be worse than no
 * inbox.
 *
 * The scope is applied against `attendance.view` rather than a permission of
 * its own. It is the widest of the things this queue contains, so a narrower
 * one would hide rows from somebody who can open the page they link to.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const sp = new URL(request.url).searchParams;
  const monthParam = sp.get('month');
  const month = monthParam && /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : previousMonth();
  const countOnly = sp.get('count') === '1';

  await resolveAccess(auth.id);
  // Narrowed through the same helper every other list uses. Only the IDS are
  // taken from it: the inbox builds its own clauses, because it reads five
  // tables whose employee column is spelled differently in each.
  const scope = await narrowToVisible(auth.id, 'attendance.view', 'e.id');
  const visible = scope.applied ? scope.params : 'all' as const;

  // The badge asks once a minute, so it skips the exception scan entirely -
  // that is the expensive half, and nothing in it is waiting on a person.
  const summary = await buildInbox({
    visible,
    reviewMonth: month,
    includeReview: !countOnly,
  });

  return NextResponse.json<ApiResponse<InboxSummary & {
    scope_note: string | null;
    review_month: string;
  }>>({
    success: true,
    data: {
      ...summary,
      items: countOnly ? [] : summary.items,
      scope_note: scope.note,
      review_month: month,
    },
  });
}

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { resolveAccess } from '@/lib/access';
import type { NavAccess } from '@/lib/nav';
import type { ApiResponse } from '@/lib/types';

/**
 * GET /api/access/me — what the signed-in person may do.
 *
 * The navigation rail used to decide what to show from a hard-coded
 * `superAdminOnly` flag on each entry, which meant the permission system and
 * the menu were two different answers to the same question. This is the one
 * the menu now asks.
 *
 * It returns the CONTEXT, not a yes/no per page: `explicit` says whether this
 * person holds a real role or is still on the legacy fallback, and the rail
 * needs that distinction to avoid hiding pages that work today. See
 * `canSee` in lib/nav.ts.
 *
 * Deliberately readable by any signed-in user, including an employee. It
 * describes only the caller, it is what their own UI is already allowed to
 * know, and refusing it would simply mean the menu renders nothing.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['employee', 'manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const ctx = await resolveAccess(auth.id);

  // A Map does not survive JSON.stringify - it serialises as {} - so this is
  // flattened on purpose rather than left to the serialiser.
  const grants: NavAccess['grants'] = {};
  for (const [key, scope] of ctx.grants) grants[key] = scope;

  return NextResponse.json<ApiResponse<NavAccess>>({
    success: true,
    data: {
      isSuperAdmin: ctx.isSuperAdmin,
      explicit: ctx.explicit,
      legacyRole: ctx.legacyRole,
      grants,
    },
  });
}

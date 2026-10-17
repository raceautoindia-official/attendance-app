import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { resolveAccess } from '@/lib/access';
import { setupState, type SetupState } from '@/lib/setup';
import type { ApiResponse } from '@/lib/types';

/**
 * GET /api/setup — what is still missing before this workspace works.
 *
 * Read-only, and deliberately so: there is nothing to record. Every step is
 * judged by whether the thing it asks for EXISTS, so the answer is computed
 * from the workspace each time rather than stored and kept in step with it.
 *
 * Open to manager and super_admin, filtered by permission inside, because a
 * manager with `employee.manage` and nothing else should still be told to add
 * their people — just not told to create the company.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['manager', 'super_admin']);
  if (auth instanceof NextResponse) return auth;

  const ctx = await resolveAccess(auth.id);

  try {
    const state = await setupState(ctx);
    return NextResponse.json<ApiResponse<SetupState>>({ success: true, data: state });
  } catch (err) {
    console.error('[setup] could not read the workspace state:', err);
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Could not work out what is still to be set up.' },
      { status: 500 },
    );
  }
}

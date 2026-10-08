/**
 * lib/authNavigate.ts — leaving the login screen.
 *
 * Use this, never `router.push()`, for any navigation that happens because the
 * signed-in state just changed.
 *
 * WHY. The proxy answers an unauthenticated page request with a redirect to
 * `/login?redirect=<path>`. Next.js prefetches route payloads into the client
 * Router Cache and reuses them for about thirty seconds. So if `/overview` was
 * prefetched while the visitor was logged out — which is exactly when somebody
 * is sitting on the login page — the cached payload for `/overview` IS that
 * redirect back to `/login`.
 *
 * `router.push('/overview')` immediately after signing in then replays the
 * cached answer. The credentials were right, the cookie was set, and the screen
 * does nothing or bounces straight back to the login form. It looks like a
 * rejected login and is not one, which is why it got reported as "correct
 * credentials but navigation not working".
 *
 * A hard navigation fixes it properly rather than papering over it:
 *   - the Router Cache is discarded entirely, so no stale redirect survives
 *   - the request carries the cookie that was just set
 *   - the proxy re-runs and decides afresh, with the session it now has
 *
 * `router.refresh()` followed by `router.push()` also clears the cache, but the
 * two are racy: the push can be dispatched against the old tree. An auth
 * transition happens once and costs one page load — the certainty is worth more
 * than the saved milliseconds.
 */

/** Navigate after the session changed. Full load, not a client transition. */
export function navigateAfterAuthChange(path: string): void {
  if (typeof window === 'undefined') return;
  window.location.assign(path);
}

/** Where someone belongs once signed in, honouring ?redirect= when it is safe. */
export function destinationFor(
  role: string,
  redirectParam?: string | null,
): string {
  // Only a same-site path is honoured. An absolute URL here would turn the
  // login form into an open redirect: a link to
  // /login?redirect=https://evil.example sends somebody who just typed their
  // password to a site of somebody else's choosing.
  if (
    redirectParam
    && redirectParam.startsWith('/')
    && !redirectParam.startsWith('//')
    && !redirectParam.startsWith('/login')
  ) {
    return redirectParam;
  }
  return role === 'employee' ? '/dashboard' : '/overview';
}

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * lib/tenancy/context.ts — which tenant the current work belongs to.
 *
 * `query()` is called from library functions many layers below the request,
 * which have no parameter to thread a tenant through. Passing one explicitly
 * would mean editing 130 call sites and remembering to do so in every future
 * one — the same failure mode as a `WHERE tenant_id = ?` everywhere, wearing a
 * different costume.
 *
 * So the tenant is held in async context instead. A request resolves it once,
 * runs its handler inside `runInTenant`, and every query underneath — however
 * deeply nested, across any number of awaits — reads the same value.
 *
 * THE CENTRAL RULE: there is no default tenant.
 *
 * `requireTenant()` throws when the context is empty. It does not fall back to
 * tenant one, and it does not return nothing. A fallback is how multi-tenant
 * breaches happen: some path loses its context, quietly reads whichever tenant
 * is first, and nobody notices until a customer sees a name they do not
 * employ. A thrown error is a page that breaks loudly in staging, which is the
 * cheapest possible version of this bug.
 *
 * Background jobs have no request to inherit from, so they are explicit: see
 * `forEachTenant` in ./fleet.ts. They must name the tenant they are acting on,
 * which is the correct amount of friction for a job that writes to everybody.
 */

export interface TenantContext {
  /** `tenants.id` in the registry. */
  id: number;
  /** Short customer-visible handle, e.g. `acme`. */
  code: string;
  /** The database this tenant's data lives in. */
  dbName: string;
  /** Null means the same server the app already connects to. */
  dbHost: string | null;
  dbPort: number | null;
}

const storage = new AsyncLocalStorage<TenantContext>();

/** Thrown when work reaches the database with no tenant established. */
export class NoTenantError extends Error {
  constructor(detail?: string) {
    super(
      'No tenant in context. Every database call must run inside runInTenant(). '
      + 'This is deliberately fatal rather than defaulting to a tenant — a default '
      + 'would read one customer\'s data on behalf of another.'
      + (detail ? ` (${detail})` : ''),
    );
    this.name = 'NoTenantError';
  }
}

/** Run `fn` with `tenant` established for everything it calls, at any depth. */
export function runInTenant<T>(tenant: TenantContext, fn: () => T): T {
  return storage.run(tenant, fn);
}

/** The current tenant, or null. Only for code that genuinely tolerates none. */
export function currentTenant(): TenantContext | null {
  return storage.getStore() ?? null;
}

/** The current tenant, or throw. This is what the database layer uses. */
export function requireTenant(detail?: string): TenantContext {
  const t = storage.getStore();
  if (!t) throw new NoTenantError(detail);
  return t;
}

/**
 * True when a tenant is established. For diagnostics and tests — never as a
 * guard around a silent fallback, which is the thing this module exists to
 * prevent.
 */
export function hasTenant(): boolean {
  return storage.getStore() !== undefined;
}

/**
 * The tenant isolation boundary.
 *
 * PostgreSQL Row Level Security would have made isolation a property of the
 * database. MongoDB has no equivalent, so isolation here is a property of the
 * code — which means it holds only as long as every query goes through this
 * module. Two rules follow, and neither is optional:
 *
 *  1. A `TenantContext` is derived from the authenticated service credential.
 *     NEVER from a request body, path parameter, query string or header. A
 *     tenant id a caller can choose is not an isolation boundary, it is an IDOR.
 *  2. No module reaches the Mongoose driver around this layer. Every read and
 *     write on a tenant-owned collection is scoped here.
 *
 * The one sanctioned exception is cross-tenant incident correlation, which
 * lives in a privileged module that must never return another tenant's data to
 * an application-API caller.
 */

/** The tenant a request acts on behalf of. */
export interface TenantContext {
  readonly organizationId: string;
  readonly applicationId: string;
}

/** A filter or document with the tenant keys applied. */
export type TenantScoped<T> = T & TenantContext;

/** The keys this module owns. A caller may never supply them itself. */
const TENANT_KEYS = ['organizationId', 'applicationId'] as const;

/**
 * The only constructor for a `TenantContext`.
 *
 * Call it where the service credential is resolved, so there is exactly one
 * place in the codebase to audit when asking "can a caller influence this?".
 */
export function createTenantContext(
  organizationId: string,
  applicationId: string,
): TenantContext {
  if (!organizationId.trim()) {
    throw new Error('A tenant context requires a non-empty organizationId.');
  }
  if (!applicationId.trim()) {
    throw new Error('A tenant context requires a non-empty applicationId.');
  }
  return Object.freeze({ organizationId, applicationId });
}

function assertNoTenantKeys(subject: object, what: string): void {
  for (const key of TENANT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(subject, key)) {
      // Deliberately a throw rather than a silent override. Supplying a tenant
      // key means the caller believes it chooses the tenant, and that belief is
      // the bug — it must surface in tests, not be quietly corrected in
      // production where the next author copies the pattern.
      throw new Error(
        `${what} must not set '${key}'; the tenant comes from the credential, never from the caller.`,
      );
    }
  }
}

/**
 * Scopes a query filter to one tenant.
 *
 * The context always wins: a caller cannot widen, narrow or redirect the tenant
 * keys, because supplying them at all is rejected.
 */
export function tenantScopedFilter<TFilter extends object>(
  context: TenantContext,
  filter: TFilter = {} as TFilter,
): TenantScoped<TFilter> {
  assertNoTenantKeys(filter, 'A tenant-scoped filter');
  return {
    ...filter,
    organizationId: context.organizationId,
    applicationId: context.applicationId,
  };
}

/**
 * Stamps a new document with its owning tenant.
 *
 * Callers pass an explicit field whitelist — never a spread request body — so a
 * client cannot mass-assign its way into fields it does not own.
 */
export function tenantScopedDocument<TDocument extends object>(
  context: TenantContext,
  document: TDocument,
): TenantScoped<TDocument> {
  assertNoTenantKeys(document, 'A tenant-scoped document');
  return {
    ...document,
    organizationId: context.organizationId,
    applicationId: context.applicationId,
  };
}

/** True when `value` carries both tenant keys of `context`. */
export function isScopedToTenant(context: TenantContext, value: object): boolean {
  return TENANT_KEYS.every(
    (key) => (value as Record<string, unknown>)[key] === context[key],
  );
}

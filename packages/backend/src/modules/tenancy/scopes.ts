/**
 * Service-credential scopes (§13.3).
 *
 * The list is split in two on purpose. §13.2 requires that privileged scopes are
 * not self-grantable: an application that could mint itself
 * `reputation:moderation:apply` would be able to move an Oxy Trust figure
 * directly, which is exactly the thing the whole architecture exists to prevent
 * (§2.2). Splitting them here means the rule is enforced by the type of the
 * issuing call rather than by remembering to check.
 */

/** Scopes an organization may grant to its own application credentials. */
export const APPLICATION_SCOPES = [
  'crowdsource:reports:write',
  'crowdsource:reports:read',
  'crowdsource:cases:read',
  'crowdsource:appeals:write',
  'crowdsource:enforcement:write',
  'crowdsource:webhooks:manage',
  'crowdsource:policies:manage',
  'crowdsource:schemas:manage',
] as const;

/**
 * Internal scopes. These are never reachable through application credential
 * issuance; the surfaces that need them do not exist yet, and the issuing path
 * for them arrives with the module that consumes them rather than before it.
 */
export const PRIVILEGED_SCOPES = [
  'crowdsource:decisions:emit',
  'reputation:moderation:apply',
  'crowdsource:trust-safety:operate',
] as const;

export type ApplicationScope = (typeof APPLICATION_SCOPES)[number];
export type PrivilegedScope = (typeof PRIVILEGED_SCOPES)[number];
export type Scope = ApplicationScope | PrivilegedScope;

const APPLICATION_SCOPE_SET: ReadonlySet<string> = new Set(APPLICATION_SCOPES);
const PRIVILEGED_SCOPE_SET: ReadonlySet<string> = new Set(PRIVILEGED_SCOPES);

export function isApplicationScope(value: string): value is ApplicationScope {
  return APPLICATION_SCOPE_SET.has(value);
}

export function isPrivilegedScope(value: string): value is PrivilegedScope {
  return PRIVILEGED_SCOPE_SET.has(value);
}

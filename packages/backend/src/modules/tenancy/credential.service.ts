import { createHash } from 'node:crypto';

/**
 * `verifySecret` is a constant-time comparison from the shared SDK, used instead
 * of `!==` — which short-circuits on the first differing byte and leaks a secret
 * one byte at a time.
 *
 * It also explains why `express-rate-limit` is a dependency of this package
 * despite nothing here calling it: `@oxyhq/core/server` is a single barrel whose
 * `rateLimit` module requires it eagerly, so importing ANYTHING from that
 * subpath pulls it in. The production image installs with `--omit=peer`, so
 * without the declaration the container would crash at boot with
 * MODULE_NOT_FOUND rather than fail anywhere a test would see it. The barrel
 * should load a peer lazily; that is an upstream fix in `@oxyhq/core`, not
 * something to work around here.
 */
import { verifySecret } from '@oxyhq/core/server';

import { createTenantContext, type TenantContext } from '../../db/tenantScope';
import { ApiError } from '../../http/apiError';
import { isPublicId } from '../../utils/identifiers';
import { applicationCredentials, applications } from './tenancy.collections';

/**
 * Resolving a presented service credential into a tenant.
 *
 * This module is where `applicationId` comes from, and it is the ONLY place it
 * may come from (§12.9, §13.2). Not the request body, not the path, not a
 * header, not a query parameter. Everything downstream filters by the context
 * produced here, so a tenant a caller could influence would not be an isolation
 * boundary — it would be an IDOR with extra steps.
 *
 * CrowdSource has two caller classes and neither may satisfy the other's routes:
 * an Oxy session (reviewers, Trust & Safety) and a service credential
 * (applications). A service credential never reaches a reviewer route, and an
 * Oxy session never satisfies an application-API route. Oxy sessions are
 * verified with `@oxyhq/core/server`; this file covers only the credential side.
 */

/** A token is `<credentialId>.<secret>` — one separator, neither half optional. */
const TOKEN_SEPARATOR = '.';

/**
 * Compared against when no credential matched, so a request for a non-existent
 * credential id costs the same as one for a wrong secret. The value is the hash
 * of a string no `randomBytes` draw produces.
 */
const ABSENT_CREDENTIAL_HASH = createHash('sha256')
  .update('crowdsource:no-such-credential', 'utf8')
  .digest('hex');

/** The stored form of a credential secret. */
export function hashCredentialSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** An authenticated application-API caller. */
export interface ServiceCredentialCaller {
  readonly credentialId: string;
  readonly scopes: readonly string[];
  /** Derived from the credential's application. Never from the request. */
  readonly tenant: TenantContext;
}

interface ParsedToken {
  readonly credentialId: string;
  readonly secret: string;
}

/** Splits a presented token, or returns null when it is not one. */
export function parseServiceToken(token: string): ParsedToken | null {
  const parts = token.split(TOKEN_SEPARATOR);
  if (parts.length !== 2) return null;

  const [credentialId, secret] = parts;
  if (!credentialId || !secret) return null;
  if (!isPublicId('credential', credentialId)) return null;

  return { credentialId, secret };
}

/**
 * Authenticates a presented service token.
 *
 * Every rejection is the same 401 with the same message. Telling a caller
 * whether the credential id was unknown, the secret wrong, the credential
 * revoked or the application suspended hands an attacker a search procedure;
 * the distinction belongs in the operator's audit trail, not in the response.
 */
export async function authenticateServiceCredential(
  token: string,
): Promise<ServiceCredentialCaller> {
  const unauthorized = new ApiError(
    'unauthorized',
    'The service credential is missing, malformed, expired or revoked.',
  );

  const parsed = parseServiceToken(token);
  if (!parsed) {
    // Still spend a comparison: a malformed token must not be measurably
    // cheaper to reject than a well-formed one with a wrong secret.
    verifySecret(ABSENT_CREDENTIAL_HASH, ABSENT_CREDENTIAL_HASH);
    throw unauthorized;
  }

  const credential = await applicationCredentials.findOne({ credentialId: parsed.credentialId });
  const presentedHash = hashCredentialSecret(parsed.secret);

  // One condition, because an unknown credential id and a wrong secret must be
  // indistinguishable — including in how long they take to reject.
  if (!verifySecret(presentedHash, credential?.secretHash ?? ABSENT_CREDENTIAL_HASH) || !credential) {
    throw unauthorized;
  }
  if (credential.status !== 'active') {
    throw unauthorized;
  }
  if (credential.expiresAt !== null && credential.expiresAt.getTime() <= Date.now()) {
    throw unauthorized;
  }

  const application = await applications.findOne({ applicationId: credential.applicationId });
  if (!application || application.status !== 'active') {
    throw unauthorized;
  }
  // A credential naming one organization while its application names another is
  // corruption, not a login failure. Refusing it here stops a stale credential
  // from surviving an application being moved between organizations.
  if (application.organizationId !== credential.organizationId) {
    throw unauthorized;
  }

  return {
    credentialId: credential.credentialId,
    scopes: credential.scopes,
    tenant: createTenantContext(application.organizationId, application.applicationId),
  };
}


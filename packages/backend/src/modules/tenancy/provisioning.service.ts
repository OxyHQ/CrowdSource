import { randomBytes } from 'node:crypto';

import { duplicateKeyViolation } from '../../db/transaction';
import { ApiError } from '../../http/apiError';
import { newPublicId } from '../../utils/identifiers';
import { hashCredentialSecret } from './credential.service';
import { type ApplicationScope, isPrivilegedScope, isApplicationScope } from './scopes';
import { applicationCredentials, applications, organizations } from './tenancy.collections';

/**
 * Creating organizations, applications and credentials.
 *
 * This is a domain service and NOT an HTTP surface. The Developer Console
 * (§4.2) is what will call it, and the console is not built — so exposing
 * routes for it now would mean shipping unauthenticated tenant creation to
 * production and hoping nobody finds it. The service is real, the transport is
 * not written yet, and that boundary is deliberate.
 */

export interface Organization {
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
}

export interface Application {
  readonly organizationId: string;
  readonly applicationId: string;
  readonly name: string;
}

export interface IssuedCredential {
  readonly organizationId: string;
  readonly applicationId: string;
  readonly credentialId: string;
  readonly scopes: readonly ApplicationScope[];
  /**
   * The full service token, returned exactly once (§13.4). Only its SHA-256 is
   * stored, so a leak of the database does not yield a usable credential and
   * nothing — including this service — can recover the value later.
   */
  readonly token: string;
}

export async function createOrganization(input: {
  name: string;
  slug: string;
}): Promise<Organization> {
  const name = input.name.trim();
  const slug = input.slug.trim().toLowerCase();
  if (!name) throw new ApiError('invalid_request', 'An organization requires a name.');
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
    throw new ApiError(
      'invalid_request',
      'An organization slug must be 2-63 characters of lowercase letters, digits and hyphens.',
    );
  }

  const organizationId = newPublicId('organization');
  try {
    await organizations.insertOne({
      organizationId,
      name,
      slug,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } catch (error: unknown) {
    if (duplicateKeyViolation(error)) {
      throw new ApiError('conflict', `The slug '${slug}' is already taken.`);
    }
    throw error;
  }

  return { organizationId, name, slug };
}

export async function createApplication(input: {
  organizationId: string;
  name: string;
}): Promise<Application> {
  const name = input.name.trim();
  if (!name) throw new ApiError('invalid_request', 'An application requires a name.');

  const organization = await organizations.findOne({ organizationId: input.organizationId });
  if (!organization) {
    throw new ApiError('not_found', 'No such organization.');
  }
  if (organization.status !== 'active') {
    throw new ApiError('forbidden', 'This organization is suspended.');
  }

  const applicationId = newPublicId('application');
  await applications.insertOne({
    organizationId: organization.organizationId,
    applicationId,
    name,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return { organizationId: organization.organizationId, applicationId, name };
}

/**
 * Issues a service credential for one application.
 *
 * Privileged scopes (§13.3) are refused here rather than filtered out. A caller
 * asking for `reputation:moderation:apply` believes it is getting the ability to
 * move a reputation figure; silently granting a lesser credential would let that
 * belief survive until something depends on it.
 */
export async function issueApplicationCredential(input: {
  organizationId: string;
  applicationId: string;
  scopes: readonly string[];
  expiresAt?: Date;
}): Promise<IssuedCredential> {
  const application = await applications.findOne({ applicationId: input.applicationId });
  if (!application || application.organizationId !== input.organizationId) {
    throw new ApiError('not_found', 'No such application in this organization.');
  }
  if (application.status !== 'active') {
    throw new ApiError('forbidden', 'This application is suspended.');
  }

  const scopes = [...new Set(input.scopes)];
  if (scopes.length === 0) {
    throw new ApiError('invalid_request', 'A credential requires at least one scope.');
  }
  for (const scope of scopes) {
    if (isPrivilegedScope(scope)) {
      throw new ApiError(
        'forbidden',
        `The scope '${scope}' is internal and cannot be granted to an application credential.`,
      );
    }
    if (!isApplicationScope(scope)) {
      throw new ApiError('invalid_request', `Unknown scope '${scope}'.`);
    }
  }
  const grantedScopes: ApplicationScope[] = scopes.filter(isApplicationScope);

  const credentialId = newPublicId('credential');
  // 256 bits from the CSPRNG. This is why the stored digest is a plain SHA-256
  // rather than a password KDF: there is no dictionary to run against a value
  // with this much entropy, and a KDF would only add per-request latency to
  // every application API call.
  const secret = randomBytes(32).toString('base64url');

  await applicationCredentials.insertOne({
    organizationId: application.organizationId,
    applicationId: application.applicationId,
    credentialId,
    secretHash: hashCredentialSecret(secret),
    scopes: grantedScopes,
    status: 'active',
    expiresAt: input.expiresAt ?? null,
    revokedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return {
    organizationId: application.organizationId,
    applicationId: application.applicationId,
    credentialId,
    scopes: grantedScopes,
    token: `${credentialId}.${secret}`,
  };
}

/**
 * Suspends or restores an organization.
 *
 * A suspended organization cannot have new applications created under it. It is
 * deliberately NOT a kill switch for traffic already flowing: stopping an
 * application mid-incident is what `setApplicationStatus` is for, and the two
 * being separate is what lets an operator halt one product without freezing a
 * whole customer.
 */
export async function setOrganizationStatus(
  organizationId: string,
  status: 'active' | 'suspended',
): Promise<void> {
  const modified = await organizations.updateOne({ organizationId }, { status });
  if (modified === 0) {
    throw new ApiError('not_found', 'No such organization, or it already had that status.');
  }
}

/**
 * Suspends or restores an application.
 *
 * This is the kill switch. Every credential of a suspended application stops
 * authenticating at once, which is the only way to stop a misbehaving tenant
 * without knowing how many credentials it holds.
 */
export async function setApplicationStatus(
  applicationId: string,
  status: 'active' | 'suspended',
): Promise<void> {
  const modified = await applications.updateOne({ applicationId }, { status });
  if (modified === 0) {
    throw new ApiError('not_found', 'No such application, or it already had that status.');
  }
}

/** Revokes a credential. A revoked credential never authenticates again. */
export async function revokeCredential(credentialId: string): Promise<void> {
  const modified = await applicationCredentials.updateOne(
    { credentialId, status: 'active' },
    { status: 'revoked', revokedAt: new Date() },
  );
  if (modified === 0) {
    throw new ApiError('not_found', 'No active credential with that id.');
  }
}

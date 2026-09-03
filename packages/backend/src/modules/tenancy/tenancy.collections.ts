import { defineUnscopedCollection } from '../../db/collections';
import {
  APPLICATION_STATUSES,
  CREDENTIAL_STATUSES,
  ORGANIZATION_STATUSES,
} from '../../domain/closedValues';

export { APPLICATION_STATUSES, CREDENTIAL_STATUSES, ORGANIZATION_STATUSES } from '../../domain/closedValues';

export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

/**
 * The collections that DEFINE a tenant.
 *
 * These three cannot be reached through `TenantCollection`, because the tenant
 * context they would be filtered by is derived FROM them: resolving a presented
 * credential is what produces the context in the first place. They are therefore
 * declared unscoped, and the rule that replaces the filter is a rule about
 * reachability — nothing outside `src/modules/tenancy/` imports this file, and
 * no application-API route returns a row from it that was not resolved from the
 * caller's own credential.
 *
 * Repository codecs whitelist fields explicitly so an unknown field is dropped
 * rather than stored: a write path that ever gets handed a request body cannot
 * smuggle a field through it.
 */

export interface OrganizationDocument {
  organizationId: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  createdAt: Date;
  updatedAt: Date;
}

export const organizations = defineUnscopedCollection<OrganizationDocument>('Organization', {
  why: 'An organization IS the tenant root; there is no wider tenant to scope it by.',
});

export interface ApplicationDocument {
  organizationId: string;
  applicationId: string;
  name: string;
  status: ApplicationStatus;
  createdAt: Date;
  updatedAt: Date;
}

export const applications = defineUnscopedCollection<ApplicationDocument>('Application', {
  why: 'Credential resolution reads an application before any tenant context exists.',
});

export interface ApplicationCredentialDocument {
  organizationId: string;
  applicationId: string;
  /** The public half of the service token, and the lookup key. */
  credentialId: string;
  /** SHA-256 of the secret half. See `credential.service.ts` for why not a KDF. */
  secretHash: string;
  scopes: string[];
  status: CredentialStatus;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const applicationCredentials = defineUnscopedCollection<ApplicationCredentialDocument>(
  'ApplicationCredential',
  {
    why: 'A presented credential is looked up by its own id, which is what yields the tenant.',
  },
);

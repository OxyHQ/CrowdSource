import { Schema } from 'mongoose';

import { defineUnscopedCollection } from '../../db/collections';

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
 * Schemas are `strict` (Mongoose's default) so an unknown field is dropped
 * rather than stored: a write path that ever gets handed a request body cannot
 * smuggle a field through it.
 */

export interface OrganizationDocument {
  organizationId: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended';
  createdAt: Date;
  updatedAt: Date;
}

const organizationSchema = new Schema<OrganizationDocument>(
  {
    organizationId: { type: String, required: true, unique: true },
    name: { type: String, required: true, trim: true },
    // A human-readable handle for the console. Unique across the deployment so
    // two organizations cannot present as one another to an operator.
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    status: { type: String, required: true, enum: ['active', 'suspended'], default: 'active' },
  },
  { timestamps: true, collection: 'organizations' },
);

export const organizations = defineUnscopedCollection('Organization', organizationSchema, {
  why: 'An organization IS the tenant root; there is no wider tenant to scope it by.',
});

export interface ApplicationDocument {
  organizationId: string;
  applicationId: string;
  name: string;
  status: 'active' | 'suspended';
  createdAt: Date;
  updatedAt: Date;
}

const applicationSchema = new Schema<ApplicationDocument>(
  {
    organizationId: { type: String, required: true, index: true },
    applicationId: { type: String, required: true, unique: true },
    name: { type: String, required: true, trim: true },
    status: { type: String, required: true, enum: ['active', 'suspended'], default: 'active' },
  },
  { timestamps: true, collection: 'applications' },
);

export const applications = defineUnscopedCollection('Application', applicationSchema, {
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
  status: 'active' | 'revoked';
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const applicationCredentialSchema = new Schema<ApplicationCredentialDocument>(
  {
    organizationId: { type: String, required: true, index: true },
    applicationId: { type: String, required: true, index: true },
    credentialId: { type: String, required: true, unique: true },
    secretHash: { type: String, required: true },
    scopes: { type: [String], required: true, default: [] },
    status: { type: String, required: true, enum: ['active', 'revoked'], default: 'active' },
    expiresAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'application_credentials' },
);

export const applicationCredentials = defineUnscopedCollection(
  'ApplicationCredential',
  applicationCredentialSchema,
  {
    why: 'A presented credential is looked up by its own id, which is what yields the tenant.',
  },
);

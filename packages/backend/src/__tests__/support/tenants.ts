import { randomUUID } from 'node:crypto';

import { config } from '../../config';
import { ensureIndexes } from '../../db/collections';
import type { TenantContext } from '../../db/tenantScope';
import {
  createApplication,
  createOrganization,
  issueApplicationCredential,
} from '../../modules/tenancy/provisioning.service';
import type { ApplicationScope } from '../../modules/tenancy/scopes';
import { connectToDatabase, disconnectFromDatabase } from '../../utils/database';

/**
 * Support for the integration tests, against the real replica set.
 *
 * Every test provisions its OWN organization and application. Nothing wipes a
 * collection between tests, because a shared wipe makes two test files running
 * in parallel able to delete each other's fixtures — and the failure that
 * produces looks exactly like a broken tenant filter, which is the one signal
 * these tests exist to give unambiguously.
 */

export async function startDatabase(): Promise<void> {
  /**
   * Gate the run on where it is about to write.
   *
   * `vitest.setup.ts` falls back to `mongodb://127.0.0.1:27017` when the global
   * setup did not run — and a developer machine usually HAS a replica set
   * there, shared with the other Oxy products. Without this assertion, a global
   * setup that silently stopped running would leave the whole integration suite
   * passing against somebody's local database instead of the disposable one,
   * and nothing would say so.
   */
  if (!config.mongoUri || config.mongoUri.includes('unused-by-design')) {
    throw new Error(
      `The integration suite is pointed at '${config.mongoUri ?? '(unset)'}', which means ` +
        'vitest.globalSetup.ts did not start the disposable replica set. Refusing to run.',
    );
  }

  await connectToDatabase();
  // Without this the unique indexes of §12.7 do not exist, and every idempotency
  // assertion below would pass by accepting duplicates instead of rejecting them.
  await ensureIndexes();
}

export async function stopDatabase(): Promise<void> {
  await disconnectFromDatabase();
}

export interface ProvisionedTenant {
  readonly organizationId: string;
  readonly applicationId: string;
  readonly token: string;
  readonly tenant: TenantContext;
}

const DEFAULT_SCOPES: readonly ApplicationScope[] = [
  'crowdsource:reports:write',
  'crowdsource:reports:read',
];

/** An organization, an application and a credential — the §15.2 preamble. */
export async function provisionTenant(
  scopes: readonly ApplicationScope[] = DEFAULT_SCOPES,
): Promise<ProvisionedTenant> {
  const organization = await createOrganization({
    name: 'Test Organization',
    slug: `test-${randomUUID()}`,
  });
  return provisionApplication(organization.organizationId, scopes);
}

/**
 * A second application under an EXISTING organization.
 *
 * The isolation tests need this shape specifically. One organization routinely
 * runs several products (§3), and a filter that scopes by organization alone
 * looks correct against two separate customers while leaking freely between one
 * customer's own applications — which is where a report from a private staging
 * app would show up in a public one.
 */
export async function provisionApplication(
  organizationId: string,
  scopes: readonly ApplicationScope[] = DEFAULT_SCOPES,
): Promise<ProvisionedTenant> {
  const application = await createApplication({ organizationId, name: 'Test Application' });
  const credential = await issueApplicationCredential({
    organizationId,
    applicationId: application.applicationId,
    scopes,
  });

  return {
    organizationId,
    applicationId: application.applicationId,
    token: credential.token,
    tenant: { organizationId, applicationId: application.applicationId },
  };
}

/** A minimally shaped Case Envelope. Full validation belongs to contracts. */
export function sampleEnvelope(text = 'Reported text'): Record<string, unknown> {
  return {
    schemaVersion: 'crowdsource.case.v1',
    subject: { externalId: 'post_987', type: 'social.post', primaryResourceId: 'res_post' },
    resources: [{ id: 'res_post', type: 'text', role: 'subject', data: { text } }],
    allegations: [{ code: 'harassment.targeted_abuse' }],
  };
}

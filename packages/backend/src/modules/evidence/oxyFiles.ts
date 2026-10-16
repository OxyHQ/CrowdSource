import type {
  ServiceAssetMetadata,
  ServiceFileReference,
  ServiceFileReferenceResult,
  ServiceReferenceInventoryItem,
  ServiceReferenceReconcileResult,
} from '@oxy.so/core';

import { oxyServiceServer } from '../identity/oxyService';

/**
 * THE ONE PLACE CrowdSource calls Oxy Files (oxy ADR 0043).
 *
 * Three calls, all as this service's own Oxy application
 * (`identity/oxyService.ts`), and each needs a scope staff grant that
 * application:
 *
 * - `metadataByIds` (`files:read`): who owns a submitted evidence file, its
 *   status and its SHA-256. The owner is revealed only to Oxy's own
 *   (`tier: 'internal'`) applications — `evidenceFiles.ts` refuses evidence it
 *   cannot attribute rather than accepting it unchecked.
 * - `references.add` / `references.remove` (`files:references:write`): this
 *   service's use of a file, entity type {@link EVIDENCE_ENTITY_TYPE}.
 * - `references.reconcile` (`files:references:write`): the nightly safety net.
 *
 * Narrow on purpose, like `accountErasure/oxyAccountEvents.ts`: the rest of the
 * module is written against this interface, and the tests substitute it.
 */

/** The entity type of every reference CrowdSource registers: the entity id is the case id. */
export const EVIDENCE_ENTITY_TYPE = 'case';

export interface OxyFilesClient {
  metadataByIds(ids: string[]): Promise<ServiceAssetMetadata[]>;
  addReferences(references: ServiceFileReference[]): Promise<ServiceFileReferenceResult[]>;
  removeReferences(references: ServiceFileReference[]): Promise<ServiceFileReferenceResult[]>;
  reconcile(
    entityType: string,
    items: AsyncIterable<ServiceReferenceInventoryItem>,
    options: { dryRun: boolean },
  ): Promise<ServiceReferenceReconcileResult>;
}

let client: OxyFilesClient | null = null;

function buildClient(): OxyFilesClient {
  const assets = oxyServiceServer().assets;
  return {
    // Not `{ partial: true }`: a chunk that failed is not an absent file, and
    // reading it as one would refuse genuine evidence as "not yours".
    metadataByIds: (ids) => assets.metadataByIds(ids),
    addReferences: (references) => assets.references.add(references),
    removeReferences: (references) => assets.references.remove(references),
    reconcile: (entityType, items, options) =>
      assets.references.reconcile(entityType, items, options),
  };
}

export function oxyFilesClient(): OxyFilesClient {
  client ??= buildClient();
  return client;
}

/** Test seam: substitute the client, or `null` to rebuild from configuration. */
export function setOxyFilesClientForTests(substitute: OxyFilesClient | null): void {
  client = substitute;
}

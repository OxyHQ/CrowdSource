import { createHash } from 'node:crypto';

import type {
  ServiceAssetMetadata,
  ServiceFileReference,
  ServiceFileReferenceResult,
  ServiceReferenceInventoryItem,
  ServiceReferenceReconcileResult,
} from '@oxy.so/core';

import { organizations } from '../../modules/tenancy/tenancy.collections';
import { setOxyFilesClientForTests, type OxyFilesClient } from '../../modules/evidence/oxyFiles';

/**
 * Oxy Files, in memory (`modules/evidence/oxyFiles.ts`).
 *
 * It answers the way the Oxy API does for one of Oxy's OWN applications —
 * `metadataByIds` reveals `ownerUserId` (null for an application's file) and
 * `ownerApplicationId` — and keeps the references this service holds, so a test
 * can assert what Oxy was told. `refuse` makes a file one CrowdSource may not
 * reference; `fail` makes the next call of a kind throw, as an unreachable Oxy
 * does; `hideOwners` answers like an external application's token.
 */

export const digestOf = (label: string): string =>
  createHash('sha256').update(label, 'utf8').digest('hex');

export class FakeOxyFiles implements OxyFilesClient {
  readonly files = new Map<string, ServiceAssetMetadata>();
  readonly references = new Set<string>();
  readonly refused = new Set<string>();
  readonly calls = { metadata: 0, add: 0, remove: 0, reconcile: 0 };
  readonly failing = new Set<'metadata' | 'add' | 'remove' | 'reconcile'>();
  hideOwners = false;
  readonly reconciled: Array<{
    entityType: string;
    items: ServiceReferenceInventoryItem[];
    dryRun: boolean;
  }> = [];

  /** A file of `owner`, holding the bytes `label` stands for. */
  put(
    fileId: string,
    owner: { account: string } | { application: string },
    label: string,
    status: ServiceAssetMetadata['status'] = 'active',
  ): string {
    this.files.set(fileId, {
      id: fileId,
      sha256: digestOf(label),
      mime: 'image/png',
      size: 1,
      status,
      ownerUserId: 'account' in owner ? owner.account : null,
      ...('application' in owner ? { ownerApplicationId: owner.application } : {}),
    });
    return `sha256:${digestOf(label)}`;
  }

  /** A file the tenant's organization account owns; answers the declared digest. */
  async putForTenant(
    tenant: { organizationId: string },
    fileId: string,
    label: string,
  ): Promise<string> {
    const organization = await organizations.findOne({ organizationId: tenant.organizationId });
    if (!organization?.oxyAccountId) throw new Error('the tenant has no Oxy account');
    return this.put(fileId, { account: organization.oxyAccountId }, label);
  }

  holds(fileId: string, entityId: string, entityType = 'case'): boolean {
    return this.references.has(`${fileId} ${entityType} ${entityId}`);
  }

  async metadataByIds(ids: string[]): Promise<ServiceAssetMetadata[]> {
    this.calls.metadata += 1;
    if (this.failing.has('metadata')) throw Object.assign(new Error('down'), { status: 503 });
    return ids.flatMap((id) => {
      const file = this.files.get(id);
      if (!file) return [];
      if (!this.hideOwners) return [file];
      const { ownerUserId: _owner, ownerApplicationId: _application, ...rest } = file;
      return [rest];
    });
  }

  async addReferences(references: ServiceFileReference[]): Promise<ServiceFileReferenceResult[]> {
    this.calls.add += 1;
    if (this.failing.has('add')) throw Object.assign(new Error('down'), { status: 503 });
    return references.map((reference) => {
      const key = `${reference.fileId} ${reference.entityType} ${reference.entityId}`;
      if (this.refused.has(reference.fileId) || !this.files.has(reference.fileId)) {
        return { ...reference, result: 'not_found' as const };
      }
      const existed = this.references.has(key);
      this.references.add(key);
      return { ...reference, result: existed ? ('exists' as const) : ('created' as const) };
    });
  }

  async removeReferences(
    references: ServiceFileReference[],
  ): Promise<ServiceFileReferenceResult[]> {
    this.calls.remove += 1;
    if (this.failing.has('remove')) throw Object.assign(new Error('down'), { status: 503 });
    return references.map((reference) => {
      const key = `${reference.fileId} ${reference.entityType} ${reference.entityId}`;
      const existed = this.references.delete(key);
      return { ...reference, result: existed ? ('removed' as const) : ('not_found' as const) };
    });
  }

  async reconcile(
    entityType: string,
    items: AsyncIterable<ServiceReferenceInventoryItem>,
    options: { dryRun: boolean },
  ): Promise<ServiceReferenceReconcileResult> {
    this.calls.reconcile += 1;
    const listed: ServiceReferenceInventoryItem[] = [];
    for await (const item of items) listed.push(item);
    this.reconciled.push({ entityType, items: listed, dryRun: options.dryRun });
    if (this.failing.has('reconcile')) throw Object.assign(new Error('down'), { status: 409 });

    const wanted = new Set(listed.map((item) => `${item.fileId} ${entityType} ${item.entityId}`));
    let added = 0;
    let refused = 0;
    let unchanged = 0;
    for (const key of wanted) {
      const fileId = key.split(' ')[0];
      if (this.references.has(key)) unchanged += 1;
      else if (this.refused.has(fileId) || !this.files.has(fileId)) refused += 1;
      else {
        added += 1;
        if (!options.dryRun) this.references.add(key);
      }
    }
    let removed = 0;
    for (const key of [...this.references]) {
      if (key.split(' ')[1] !== entityType || wanted.has(key)) continue;
      removed += 1;
      if (!options.dryRun) this.references.delete(key);
    }
    return {
      sessionId: `rec_${this.calls.reconcile}`,
      entityType,
      dryRun: options.dryRun,
      added,
      removed,
      unchanged,
      refused,
    };
  }
}

/** Installs a fresh fake for this file's tests. */
export function installOxyFiles(): FakeOxyFiles {
  const fake = new FakeOxyFiles();
  setOxyFilesClientForTests(fake);
  return fake;
}

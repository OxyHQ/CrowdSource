import type { PolicyRule, PolicySetStatus } from '@oxyhq/crowdsource-contracts';

import { defineTenantCollection } from '../../db/collections';
import type { TenantContext } from '../../db/tenantScope';

/**
 * Policy sets, at a version (§6.4).
 *
 * A policy set is the SECOND of §6.1's three layers: the taxonomy says what the
 * material contains, this says whether that breaks THIS application's rules.
 * Which is why it is tenant-owned — two applications reading the same
 * classification and reaching opposite conclusions is the normal case (§6.2),
 * not a conflict to resolve.
 *
 * The immutability rule of §6.4 is enforced in two places and needs both. The
 * registry refuses to modify a version whose status is `published`; the unique
 * index below is what stops a concurrent second publish from creating a rival
 * copy of the same version while the first is still committing. Neither alone
 * is sufficient — a check races, and an index cannot tell an edit from an
 * insert.
 */

export interface PolicySetDocument extends TenantContext {
  policySetId: string;
  version: string;
  status: PolicySetStatus;
  title: string;
  locale?: string;
  rules: PolicyRule[];
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const policySets = defineTenantCollection<PolicySetDocument>('PolicySet');

import {
  PolicySetVersionSchema,
  UNIVERSAL_TAXONOMY_VERSION,
  type CasePolicyRef,
  type PolicySetVersion,
} from '@oxyhq/crowdsource-contracts';

import { duplicateKeyViolation } from '../../db/transaction';
import type { TenantContext } from '../../db/tenantScope';
import { ApiError } from '../../http/apiError';
import { policyVersionToken } from '../cases/caseDedupKey';
import {
  BASELINE_POLICY_SET,
  BASELINE_POLICY_SET_ID,
  BASELINE_POLICY_VERSION,
} from './policyBaseline';
import { policySets } from './policySet.collection';

/**
 * The policy registry (§6.4) — the minimal one §15.3 asks for.
 *
 * Its job is to answer, for one tenant, "does this policy version exist, and
 * what does it say?". Everything downstream depends on that answer being stable
 * forever: §6.4 forbids a policy update from silently changing what a past
 * decision meant, §7.3 makes the policy version part of the case dedup key, and
 * a decision records the version it was decided under so it can be re-derived
 * years later.
 *
 * Two design points worth stating rather than inferring:
 *
 *   * **An unknown policy version is refused at ingress.** A report naming a
 *     policy nobody has registered cannot be reviewed — the jury would be asked
 *     "does this break the rules?" with no rules — and accepting it would mean
 *     discovering that at the moment a case reaches a reviewer, long after the
 *     application got its 202.
 *   * **The baseline is resolved from source, not from the database.** It is the
 *     same document for every tenant, so seeding a per-tenant copy on first use
 *     would add a write race to the ingress path in exchange for nothing. The
 *     collection holds what a tenant registers for itself.
 */

/** A resolved policy version and the token that identifies it on a case. */
export interface ResolvedPolicy {
  readonly policySetId: string;
  readonly version: string;
  /** `<policySetId>@<version>` — §7.3's fourth dedup component. */
  readonly token: string;
  /** The universal taxonomy version the classification layer is at (§6.4). */
  readonly taxonomyVersion: string;
  readonly policySet: PolicySetVersion;
}

function resolvedBaseline(): ResolvedPolicy {
  return {
    policySetId: BASELINE_POLICY_SET_ID,
    version: BASELINE_POLICY_VERSION,
    token: policyVersionToken(BASELINE_POLICY_SET_ID, BASELINE_POLICY_VERSION),
    taxonomyVersion: UNIVERSAL_TAXONOMY_VERSION,
    policySet: BASELINE_POLICY_SET,
  };
}

/**
 * Resolves the policy an envelope asks to be evaluated under.
 *
 * A DRAFT version resolves to nothing: §6.4 lets a draft be edited, and a case
 * decided under a document that can still change cannot honour "a policy update
 * never rewrites history". The refusal is a 422 rather than a 404 — the envelope
 * is well-formed and the tenant is entitled to it, it just is not processable
 * until the version is published (§10.5).
 */
export async function resolvePolicy(
  context: TenantContext,
  reference: CasePolicyRef,
): Promise<ResolvedPolicy> {
  if (
    reference.policySetId === BASELINE_POLICY_SET_ID &&
    reference.version === BASELINE_POLICY_VERSION
  ) {
    return resolvedBaseline();
  }

  const stored = await policySets.findOne(context, {
    policySetId: reference.policySetId,
    version: reference.version,
  });

  if (!stored) {
    throw new ApiError(
      'unprocessable_envelope',
      `No policy version '${reference.policySetId}' '${reference.version}' is registered for this application.`,
    );
  }
  if (stored.status !== 'published') {
    throw new ApiError(
      'unprocessable_envelope',
      `Policy version '${reference.policySetId}' '${reference.version}' is a draft and cannot decide a case.`,
    );
  }

  return {
    policySetId: stored.policySetId,
    version: stored.version,
    token: policyVersionToken(stored.policySetId, stored.version),
    taxonomyVersion: UNIVERSAL_TAXONOMY_VERSION,
    policySet: PolicySetVersionSchema.parse({
      policySetId: stored.policySetId,
      version: stored.version,
      status: stored.status,
      title: stored.title,
      ...(stored.locale === undefined ? {} : { locale: stored.locale }),
      ...(stored.publishedAt === null
        ? {}
        : { publishedAt: stored.publishedAt.toISOString() }),
      rules: stored.rules,
    }),
  };
}

/**
 * Registers a policy version for one application.
 *
 * A domain service, not an HTTP surface: the Developer Console (§4.2) is what
 * will call it and the console is not built, so mounting a route now would ship
 * unauthenticated policy authorship to production. The same reasoning as
 * `tenancy/provisioning.service.ts`.
 *
 * The baseline id is reserved. A tenant registering its own
 * `crowdsource.baseline` would create a set that resolution never reaches for
 * the published version and DOES reach for any other — a policy that applies
 * sometimes, which is worse than one that never applies.
 */
export async function registerPolicyVersion(
  context: TenantContext,
  input: unknown,
): Promise<PolicySetVersion> {
  const parsed = PolicySetVersionSchema.safeParse(input);
  if (!parsed.success) {
    throw new ApiError(
      'invalid_request',
      `Invalid policy set — ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  const policySet = parsed.data;

  if (policySet.policySetId === BASELINE_POLICY_SET_ID) {
    throw new ApiError(
      'forbidden',
      `'${BASELINE_POLICY_SET_ID}' is reserved for the policy set CrowdSource ships.`,
    );
  }

  try {
    await policySets.insertOne(context, {
      policySetId: policySet.policySetId,
      version: policySet.version,
      status: policySet.status,
      title: policySet.title,
      ...(policySet.locale === undefined ? {} : { locale: policySet.locale }),
      rules: [...policySet.rules],
      publishedAt: policySet.publishedAt === undefined ? null : new Date(policySet.publishedAt),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } catch (error: unknown) {
    if (duplicateKeyViolation(error)) {
      throw new ApiError(
        'conflict',
        `Policy version '${policySet.policySetId}' '${policySet.version}' already exists. A version is immutable; publish a new one.`,
      );
    }
    throw error;
  }

  return policySet;
}

/**
 * Publishes a draft version, freezing it (§6.4).
 *
 * The filter carries `status: 'draft'`, so publishing an already-published
 * version modifies nothing and reports it. That is the immutability rule as a
 * write condition rather than as a read-then-write check, which would race with
 * a concurrent publish of the same version.
 */
export async function publishPolicyVersion(
  context: TenantContext,
  policySetId: string,
  version: string,
): Promise<void> {
  const modified = await policySets.updateOne(
    context,
    { policySetId, version, status: 'draft' },
    { set: { status: 'published', publishedAt: new Date(), updatedAt: new Date() } },
  );

  if (modified === 0) {
    throw new ApiError(
      'conflict',
      `No draft version '${policySetId}' '${version}' to publish. A published version is immutable.`,
    );
  }
}

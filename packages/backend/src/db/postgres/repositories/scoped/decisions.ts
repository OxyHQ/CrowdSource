import { and, desc, eq } from 'drizzle-orm';

import { appeals, decisions } from '../../schema/decisions';
import type { TenantScopedHandle } from '../../withTenant';

/**
 * The jury's published output and the appeals against it, tenant-scoped.
 *
 * `TenantScopedHandle` first, no tenant predicate in any query — see
 * `scoped/cases.ts` for why both.
 */

export interface NewDecision {
  readonly decisionId: string;
  readonly organizationId: string;
  readonly applicationId: string;
  readonly caseId: string;
  readonly revision: number;
  readonly status: string;
  readonly outcome: string;
  readonly contextSufficiency: string;
  readonly confidence: number;
  readonly findings: unknown;
  readonly recommendedActions: unknown;
  readonly jurySize: number;
  readonly juryDecisiveVotes: number;
  readonly juryWinningVotes: number;
  readonly juryAgreement: number;
  readonly jurySpecialistPresent: boolean;
  readonly policyVersionTaxonomy: string;
  readonly policyVersionApplication: string;
  readonly policyVersionOxyConduct: string;
  readonly supersedesDecisionId: string | null;
  readonly agreeingReviewerIds: readonly string[];
  readonly publishedAt: Date;
}

export async function insertDecision(db: TenantScopedHandle, next: NewDecision): Promise<void> {
  await db
    .insert(decisions)
    .values({ ...next, agreeingReviewerIds: [...next.agreeingReviewerIds] });
}

export async function findDecisionById(db: TenantScopedHandle, decisionId: string) {
  const [row] = await db
    .select()
    .from(decisions)
    .where(eq(decisions.decisionId, decisionId))
    .limit(1);

  return row ?? null;
}

/**
 * The decision for one revision of a case.
 *
 * `(case_id, revision)` is the unique that makes a decision addressable without
 * its id — deliberately NOT tenant-prefixed, as on Mongo, because a case id is
 * already globally unique and a prefixed version would be no stronger.
 */
export async function findDecisionForRevision(
  db: TenantScopedHandle,
  caseId: string,
  revision: number,
) {
  const [row] = await db
    .select()
    .from(decisions)
    .where(and(eq(decisions.caseId, caseId), eq(decisions.revision, revision)))
    .limit(1);

  return row ?? null;
}

/** Every decision for a case, newest revision first — the appeal chain. */
export async function listDecisionsForCase(db: TenantScopedHandle, caseId: string) {
  return await db
    .select()
    .from(decisions)
    .where(eq(decisions.caseId, caseId))
    .orderBy(desc(decisions.revision));
}

export async function updateDecisionStatus(
  db: TenantScopedHandle,
  decisionId: string,
  status: string,
): Promise<number> {
  const rows = await db
    .update(decisions)
    .set({ status })
    .where(eq(decisions.decisionId, decisionId))
    .returning({ decisionId: decisions.decisionId });

  return rows.length;
}

export interface NewAppeal {
  readonly appealId: string;
  readonly organizationId: string;
  readonly applicationId: string;
  readonly caseId: string;
  readonly supersededRevision: number;
  readonly supersededDecisionId: string;
  readonly openedRevision: number;
  readonly reason: string;
  readonly appellantExternalPrincipalId: string;
  readonly authorContext: unknown;
  readonly previousRequiredVotes: number;
  readonly severeAction: boolean;
  readonly requiredAgreeingVotes: number;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly filedAt: Date;
  readonly filedByCredentialId: string;
}

export async function insertAppeal(db: TenantScopedHandle, next: NewAppeal): Promise<void> {
  await db.insert(appeals).values(next);
}

export async function findAppealById(db: TenantScopedHandle, appealId: string) {
  const [row] = await db.select().from(appeals).where(eq(appeals.appealId, appealId)).limit(1);
  return row ?? null;
}

/** The appeal that opened a given revision, which is how a panel learns it is one. */
export async function findAppealForRevision(
  db: TenantScopedHandle,
  caseId: string,
  openedRevision: number,
) {
  const [row] = await db
    .select()
    .from(appeals)
    .where(and(eq(appeals.caseId, caseId), eq(appeals.openedRevision, openedRevision)))
    .limit(1);

  return row ?? null;
}

/** The idempotency read for appeal filing — see the reports repository for why. */
export async function findAppealByIdempotencyKey(
  db: TenantScopedHandle,
  idempotencyKey: string,
) {
  const [row] = await db
    .select()
    .from(appeals)
    .where(eq(appeals.idempotencyKey, idempotencyKey))
    .limit(1);

  return row ?? null;
}

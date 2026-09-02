import { and, asc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';

import { sqlColumnName } from '@oxyhq/db';

import {
  reviewerAffinities,
  reviewerPrincipalLinks,
  reviewerProfiles,
  reviewerRelations,
} from '../schema/reviewers';
import { requireTransaction, type PgHandle, type PgTransactionHandle } from '../withTenant';
import type { CaseEligibilityCriteria } from '../../../modules/reviewer/eligibility';
import { sensitivityRank } from '../../../modules/reviewer/reviewer.collection';
import { DRAWABLE_STATES } from '../../../modules/reviewer/reviewerState';
import { newPublicId } from '../../../utils/identifiers';

/**
 * The reviewer person-model, as PostgreSQL repositories.
 *
 * Four tables, none of them tenant-owned: a case belongs to a tenant, a reviewer
 * belongs to none, and `candidatePool.ts` has no tenant filter deliberately
 * because juries are cross-tenant (§8.2). Read paths take a plain `PgHandle`;
 * compound writes take a `PgTransactionHandle` where atomicity is required.
 * Domain services use these repositories at runtime, and
 * `reviewerRepositories.realdb.test.ts` exercises them against the real schema,
 * constraints and unprivileged role.
 *
 * ## The one behaviour change in this file, and why it is deliberate
 *
 * `eligibilityFilter` narrows on `categories: { $all: criteria.families }`.
 * `$all` is set-containment, so the two stores answer the DEGENERATE input in
 * opposite directions. Measured 2026-08-11 against a real mongod and PostgreSQL
 * 17.10, each with a control in the same currency and a seeded-row floor:
 *
 *   mongo   `$all: ["spam"]`              -> 2 of 3 rows   (control)
 *   mongo   `$all: ["spam","harassment"]` -> 1 of 3 rows   (control)
 *   mongo   `$all: []`                    -> 0 rows
 *   pg      `categories @> ARRAY['spam']` -> 2 of 3 rows   (control)
 *   pg      `categories @> ARRAY[]::text[]` -> 3 of 3 rows
 *
 * Every OTHER operator in that filter agrees across the two stores on its
 * degenerate input — `$in: []` and `= ANY(ARRAY[]::text[])` both match nothing,
 * `languages: ''` and `'' = ANY(languages)` both match nothing — so the
 * divergence is confined to the two `$all` clauses and is handled in one place,
 * `eligibilityPredicate` below.
 *
 * What a transliterated `@>` would have done is worth stating exactly, because
 * the obvious description of it is wrong. It is NOT that Postgres would skip a
 * consent check Mongo enforced: `eligibilityRejection`, the authoritative
 * predicate, ALSO admits everybody when `families` is empty, since
 * `[].every(...)` is `true` and both `category_not_accepted` and
 * `category_consent_missing` are vacuously satisfied. What inverts is the
 * OUTCOME. On Mongo the filter matches zero rows, `drawPanel` receives fewer
 * candidates than it has slots, and the draw refuses with
 * `candidate_pool_too_small`. On Postgres with a bare `@>` the filter matches
 * every reviewer, the predicate rejects none of them, and a full panel is seated
 * for a case that alleges nothing.
 *
 * Reachability, measured rather than assumed: `families` is empty iff
 * `allegationCodes` is empty (`taxonomyFamilyOf` THROWS on an unrecognised
 * family via `TaxonomyFamilySchema.parse`, so it cannot quietly yield
 * `undefined`), and `allegationCodes` is `$addToSet`-ed from
 * `envelope.allegations`, which the contract pins at `.min(1)`. So it is NOT
 * reachable through ingestion today — it is LATENT, not live. It is
 * representable, though: the Mongoose path is
 * `{ type: [String], required: true, default: [] }`, and Mongoose's `required`
 * does not mean non-empty on an array. Three production sites already branch on
 * `families.length === 0` (`sortition.service.ts:168`, `sortition.service.ts:295`,
 * `reliability.ts:34`), so the codebase is written expecting the state.
 *
 * Preserved with an EXPLICIT branch rather than a containment predicate that
 * happens to be vacuously true, because a vacuously-true predicate is one
 * simplification away from being reintroduced by somebody tidying up — and the
 * reintroduction has no failing test unless the branch is the thing under test.
 *
 * One honesty note that belongs next to the fix rather than in a commit message:
 * `eligibilityFilter`'s own header states the invariant that the filter "only has
 * to be a SUPERSET of the truth, so nothing eligible is missed". On empty
 * families the MONGO filter violates that invariant — the empty set against a
 * truth of "everyone otherwise eligible". So the fail-closed behaviour being
 * preserved here is an accident of `$all`, not a designed refusal. It is still
 * the right behaviour to keep (a case alleging nothing should not seat a jury),
 * and it is kept on purpose rather than by transliteration.
 */

/** A row as the database returns it. */
export type ReviewerProfileRow = typeof reviewerProfiles.$inferSelect;
export type ReviewerRelationRow = typeof reviewerRelations.$inferSelect;
export type ReviewerAffinityRow = typeof reviewerAffinities.$inferSelect;
export type ReviewerPrincipalLinkRow = typeof reviewerPrincipalLinks.$inferSelect;

/**
 * Everything a profile write may set, minus the three the repository owns.
 *
 * `personhoodConfidence` is REQUIRED rather than optional, and that is a
 * type-level restatement of a Mongo invariant rather than an ergonomic choice:
 * `mutateProfile` is documented as "the single writer of `personhoodConfidence`",
 * re-deriving it from the merged document on every write. Requiring it here means
 * a caller that patches `oxyAccountVerified` or `suspectedSockPuppet` — both
 * personhood signals — cannot leave the derived value stale, because the field it
 * would have to omit is the one `tsc` demands.
 *
 * It also removes an empty-patch branch. Drizzle rejects `.set({})`, so a patch
 * type where every field is optional needs a guard whose only purpose is to
 * handle a call nobody makes; making one field required means the guard cannot
 * be reached and does not have to be written or covered.
 */
export type ReviewerProfilePatch = Partial<
  Omit<
    typeof reviewerProfiles.$inferInsert,
    'reviewerId' | 'oxyUserId' | 'createdAt' | 'updatedAt' | 'personhoodConfidence'
  >
> & { readonly personhoodConfidence: number };

/** The profile behind a CrowdSource reviewer id. */
export async function findReviewerProfileById(
  db: PgHandle,
  reviewerId: string,
): Promise<ReviewerProfileRow | null> {
  const [row] = await db
    .select()
    .from(reviewerProfiles)
    .where(eq(reviewerProfiles.reviewerId, reviewerId))
    .limit(1);

  return row ?? null;
}

/** The profile behind an Oxy account. One profile per person, by unique index. */
export async function findReviewerProfileByOxyUserId(
  db: PgHandle,
  oxyUserId: string,
): Promise<ReviewerProfileRow | null> {
  const [row] = await db
    .select()
    .from(reviewerProfiles)
    .where(eq(reviewerProfiles.oxyUserId, oxyUserId))
    .limit(1);

  return row ?? null;
}

/**
 * Loads several profiles by id.
 *
 * `inArray`, never a bare array interpolated into a `sql` template — a bare array
 * renders as a ROW CONSTRUCTOR, which matches nothing and reads as "these
 * reviewers do not exist". The empty case needs no guard: drizzle renders
 * `inArray(column, [])` as the literal `false`, which is what Mongo's `$in: []`
 * matches too, so the two stores agree without one.
 */
export async function findReviewerProfilesByIds(
  db: PgHandle,
  reviewerIds: readonly string[],
): Promise<ReviewerProfileRow[]> {
  return db
    .select()
    .from(reviewerProfiles)
    .where(inArray(reviewerProfiles.reviewerId, [...reviewerIds]));
}

/**
 * Creates the profile for an Oxy account, or returns the one already there.
 *
 * `ON CONFLICT … DO NOTHING` then a read, rather than an insert guarded by a
 * prior read: two concurrent first requests from the same person both reach the
 * insert, and on Mongo the loser hit the unique index and surfaced an error as
 * that person's first interaction with the product. The Mongo fix was an upsert
 * with `$setOnInsert`; this is the same shape, and it matters that no statement
 * FAILS — one failed statement aborts the whole transaction in Postgres
 * (`25P02`), so the read-the-row-back-after-duplicate-key recovery Mongo allows
 * does not port.
 *
 * The conflict target is `oxy_user_id`, which is the unique the race is against.
 * Naming `reviewer_id` instead would compile, run, and never fire — the losing
 * insert generates a FRESH reviewer id, so it conflicts on nothing and the person
 * ends up with two profiles.
 */
export async function insertReviewerProfileIfAbsent(
  db: PgHandle,
  profile: Omit<typeof reviewerProfiles.$inferInsert, 'reviewerId'>,
): Promise<ReviewerProfileRow> {
  const [inserted] = await db
    .insert(reviewerProfiles)
    .values({ ...profile, reviewerId: newPublicId('reviewer') })
    .onConflictDoNothing({ target: reviewerProfiles.oxyUserId })
    .returning();

  if (inserted !== undefined) return inserted;

  const existing = await findReviewerProfileByOxyUserId(db, profile.oxyUserId);
  if (existing === null) {
    throw new Error(
      `Reviewer profile for Oxy user '${profile.oxyUserId}' neither inserted nor found.`,
    );
  }
  return existing;
}

/**
 * Applies a patch to one profile, returning the row AFTER the write.
 *
 * `returning()` yields the post-image, which is what Mongo's
 * `returnDocument: 'after'` gave (hardcoded in `collections.ts`) and what every
 * caller of `mutateProfile` consumes — `openCalibrationIfReady` reads the state
 * it just wrote off this row.
 *
 * `updated_at` is deliberately not set here: `@oxyhq/db`'s `updatedAt()` carries
 * `$onUpdate`, which the query BUILDER applies. It would NOT apply to a raw
 * `db.execute`, which is why this is built rather than written as one SQL string.
 */
export async function updateReviewerProfile(
  db: PgHandle,
  reviewerId: string,
  patch: ReviewerProfilePatch,
): Promise<ReviewerProfileRow | null> {
  const [row] = await db
    .update(reviewerProfiles)
    .set(patch)
    .where(eq(reviewerProfiles.reviewerId, reviewerId))
    .returning();

  return row ?? null;
}

/** Increments the submitted-review counter inside the review transaction. */
export async function incrementCompletedReviewCount(
  tx: PgTransactionHandle,
  reviewerId: string,
): Promise<ReviewerProfileRow | null> {
  requireTransaction(tx);
  const [row] = await tx
    .update(reviewerProfiles)
    .set({ completedReviewCount: sql`${reviewerProfiles.completedReviewCount} + 1` })
    .where(eq(reviewerProfiles.reviewerId, reviewerId))
    .returning();
  return row ?? null;
}

/**
 * Replaces one reviewer's principal links wholesale.
 *
 * ## Why this one takes a transaction
 *
 * On Mongo these links were an ARRAY INSIDE the profile document, and the
 * preferences write set it with `$set: { principalLinks: [...] }` — a whole-array
 * replace that was atomic by construction, because a single document update is.
 * Extracted into a child table, "replace the set" becomes DELETE then INSERT: two
 * statements, and between them the reviewer has NO links at all.
 *
 * That intermediate state is not a cosmetic concern. `principalLinks` is §8.5's
 * SELF-EXCLUSION — it is how the draw knows that a candidate is one of the
 * parties to the case in front of them. A crash, a connection reset or a
 * statement timeout between the two statements leaves a reviewer whose links have
 * silently vanished, and the next draw is free to seat them on their own case.
 * There is no error, no log line and nothing that later recomputes it; the
 * profile still exists and still looks complete.
 *
 * So the atomicity Mongo supplied structurally has to be supplied explicitly
 * here, and the parameter type is what forces the caller to have opened a
 * transaction rather than leaving it to review. `requireTransaction` is the
 * runtime half, for a handle arriving through a cast, an `any` or a generic
 * boundary.
 *
 * ## What this does NOT prove, said here so the type is not read as sufficient
 *
 * Both layers prove the handle is A transaction. Neither proves it is THE SAME
 * transaction as the profile update it accompanies — a caller holding two open
 * transactions and passing the wrong one satisfies both. The profile patch and
 * this replacement are ONE logical write (they are one `ProfileMutation` on
 * Mongo, `principalLinks` being one of its fields), and they must share a
 * transaction. No type closes that gap, in either store; the Mongo side had the
 * identical hole and closed it by the array being in the same document.
 *
 * At the switch, `updateReviewerPreferences` is the caller, and it has NO
 * transaction today — `mutateProfile` is a plain `findOneAndUpdate`. Opening one
 * there is a real change to that path, and this signature is what makes `tsc`
 * ask for it rather than a reviewer noticing.
 */
export async function replaceReviewerPrincipalLinks(
  tx: PgTransactionHandle,
  reviewerId: string,
  links: readonly { readonly applicationId: string; readonly externalPrincipalId: string }[],
): Promise<void> {
  requireTransaction(tx);

  await tx.delete(reviewerPrincipalLinks).where(eq(reviewerPrincipalLinks.reviewerId, reviewerId));

  if (links.length === 0) return;

  await tx.insert(reviewerPrincipalLinks).values(
    links.map((link) => ({
      reviewerId,
      applicationId: link.applicationId,
      externalPrincipalId: link.externalPrincipalId,
    })),
  );
}

/** One reviewer's principal links, which `exclusions.ts` reads in memory. */
export async function findReviewerPrincipalLinks(
  db: PgHandle,
  reviewerId: string,
): Promise<ReviewerPrincipalLinkRow[]> {
  return db
    .select()
    .from(reviewerPrincipalLinks)
    .where(eq(reviewerPrincipalLinks.reviewerId, reviewerId));
}

/**
 * The profiles of people who ARE one of this case's principals (§8.5).
 *
 * On Mongo this was an `$elemMatch` into the embedded array; here it is a join
 * onto the extracted table, which is the predicate the child table was created to
 * serve: `application_id = $1 AND external_principal_id = ANY($2)`, one btree.
 *
 * `DISTINCT` because a reviewer who has claimed two of the case's principals
 * matches twice, and `$elemMatch` returned the parent document ONCE however many
 * elements matched. Without it a duplicate profile reaches
 * `partyRiskClusterIds`, which is a Set and would absorb it — and reaches the
 * caller's other consumers, which are not.
 */
export async function findReviewerProfilesLinkedToPrincipals(
  db: PgHandle,
  applicationId: string,
  externalPrincipalIds: readonly string[],
): Promise<ReviewerProfileRow[]> {
  return db
    .selectDistinct({ profile: reviewerProfiles })
    .from(reviewerProfiles)
    .innerJoin(
      reviewerPrincipalLinks,
      eq(reviewerPrincipalLinks.reviewerId, reviewerProfiles.reviewerId),
    )
    .where(
      and(
        eq(reviewerPrincipalLinks.applicationId, applicationId),
        inArray(reviewerPrincipalLinks.externalPrincipalId, [...externalPrincipalIds]),
      ),
    )
    .then((rows) => rows.map((row) => row.profile));
}

/**
 * The index-shaped narrowing of §8.2's eligibility, as a Postgres predicate.
 *
 * The Postgres counterpart of `eligibilityFilter`, clause for clause, and the ONE
 * place the `$all` divergence documented in this file's header is handled. Every
 * clause here is re-checked by `eligibilityRejection`, which stays the authority:
 * if this predicate is ever wrong, the worst it may do is fetch a candidate who
 * is then rejected — never admit one who should not have been drawn.
 */
function eligibilityPredicate(criteria: CaseEligibilityCriteria, now: Date) {
  return and(
    inArray(reviewerProfiles.state, [...DRAWABLE_STATES]),
    eq(reviewerProfiles.accountActive, true),
    eq(reviewerProfiles.available, true),
    eq(reviewerProfiles.suspectedSockPuppet, false),
    /**
     * Mongo's `rulesAcceptedAt: { $ne: null }` matched documents where the field
     * exists and is not null; the column is nullable and always present, so
     * `IS NOT NULL` is the same population.
     */
    sql`${reviewerProfiles.rulesAcceptedAt} is not null`,
    or(isNull(reviewerProfiles.suspendedUntil), lte(reviewerProfiles.suspendedUntil, now)),
    ...(criteria.requiresAdult ? [eq(reviewerProfiles.isAdult, true)] : []),
    /**
     * THE `$all` BRANCH. See this file's header for the measurement.
     *
     * `sql`false`` rather than an omitted clause or a bare containment: Mongo's
     * `$all: []` matched NOTHING, and `categories @> ARRAY[]::text[]` matches
     * EVERYTHING. This is the same rendering drizzle already produces for
     * `inArray(column, [])`, so it is the idiom this codebase uses for "match
     * nothing" rather than a novel spelling.
     */
    criteria.families.length === 0
      ? sql`false`
      : sql`${reviewerProfiles.categories} @> ${sql.param([...criteria.families])}::text[]`,
    ...(criteria.language === null
      ? []
      : [sql`${sql.param(criteria.language)} = any(${reviewerProfiles.languages})`]),
    gte(reviewerProfiles.maxSensitivityRank, sensitivityRank(criteria.sensitivity)),
    /** The same branch again, on the second `$all` clause, for the same reason. */
    ...(criteria.sensitivity === 'standard'
      ? []
      : [
          criteria.families.length === 0
            ? sql`false`
            : sql`${reviewerProfiles.consentedSensitiveCategories} @> ${sql.param([
                ...criteria.families,
              ])}::text[]`,
        ]),
  );
}

/** Which half of the sampling window to read. */
export type SamplingWindow =
  | { readonly kind: 'from'; readonly samplingKey: number }
  | { readonly kind: 'before'; readonly samplingKey: number };

/**
 * A window of eligible candidates, ordered by the sampling key.
 *
 * The two calls `sampleCandidates` makes — the head from a random point, then the
 * wrap below it — are one function taking a `SamplingWindow`, because they differ
 * only in the comparison. `sampling_key` is `NOT NULL`, so the ordering needs no
 * `NULLS LAST`; stated because an ordering that silently misplaces null rows is
 * the house bug and the next reader should not have to go and check.
 */
export async function findEligibleReviewerWindow(
  db: PgHandle,
  criteria: CaseEligibilityCriteria,
  now: Date,
  window: SamplingWindow,
  limit: number,
): Promise<ReviewerProfileRow[]> {
  return db
    .select()
    .from(reviewerProfiles)
    .where(
      and(
        eligibilityPredicate(criteria, now),
        window.kind === 'from'
          ? gte(reviewerProfiles.samplingKey, window.samplingKey)
          : lt(reviewerProfiles.samplingKey, window.samplingKey),
      ),
    )
    .orderBy(asc(reviewerProfiles.samplingKey))
    .limit(limit);
}

/**
 * Records a declared conflict, once.
 *
 * `DO NOTHING`, not `DO UPDATE`: the Mongo write was `$setOnInsert` only, so a
 * second declaration of the same conflict left `source` as whatever the FIRST one
 * said. A `declared` conflict that a later `recusal` would have overwritten keeps
 * its original source, and that is the behaviour being preserved — a recusal for
 * a person already declared is not new information.
 *
 * No statement fails, so this is safe inside a caller's transaction: a duplicate
 * key raised and caught would abort the whole transaction (`25P02`), which is the
 * Mongo recovery that does not port.
 */
export async function declareReviewerRelation(
  db: PgHandle,
  relation: {
    readonly reviewerId: string;
    readonly applicationId: string;
    readonly externalPrincipalId: string;
    readonly source: string;
  },
): Promise<void> {
  await db
    .insert(reviewerRelations)
    .values({ ...relation, reviewerRelationId: newPublicId('reviewerRelation') })
    .onConflictDoNothing({
      target: [
        reviewerRelations.reviewerId,
        reviewerRelations.applicationId,
        reviewerRelations.externalPrincipalId,
      ],
    });
}

/** Which candidates have declared a relationship with one of this case's parties. */
export async function findReviewerRelationsForPrincipals(
  db: PgHandle,
  applicationId: string,
  externalPrincipalIds: readonly string[],
): Promise<ReviewerRelationRow[]> {
  return db
    .select()
    .from(reviewerRelations)
    .where(
      and(
        eq(reviewerRelations.applicationId, applicationId),
        inArray(reviewerRelations.externalPrincipalId, [...externalPrincipalIds]),
      ),
    );
}

/**
 * Pairs among these reviewers who have served together too often (§8.3).
 *
 * Both id columns are constrained to the same set, matching the Mongo filter:
 * the question is which pairs are BOTH in the sample, not which pairs touch it.
 */
export async function findAffinitiesAboveThreshold(
  db: PgHandle,
  reviewerIds: readonly string[],
  minimumCoServed: number,
): Promise<ReviewerAffinityRow[]> {
  const ids = [...reviewerIds];

  return db
    .select()
    .from(reviewerAffinities)
    .where(
      and(
        inArray(reviewerAffinities.reviewerIdA, ids),
        inArray(reviewerAffinities.reviewerIdB, ids),
        gte(reviewerAffinities.coServedCount, minimumCoServed),
      ),
    );
}

/**
 * Counts one more panel these two reviewers have served on together.
 *
 * Takes a transaction because the Mongo call site does: `recordCoService` runs
 * inside the draw's `withTransaction`, so the affinity counters and the
 * assignments they constrain commit together. A count incremented outside that
 * transaction would survive a draw that rolled back, and the pair would be
 * blocked from serving together on the strength of a panel that was never
 * seated — an exclusion nothing can explain and nothing recomputes.
 *
 * `excluded.<column>` is spelled through `sqlColumnName` rather than by
 * interpolating the column object: interpolating emits the JavaScript PROPERTY
 * name, so `lastServedAt` would render as `excluded.lastservedat` and fail with
 * `42703` at runtime — a failure that no typecheck and no mocked test can reach.
 *
 * The insert value for `co_served_count` is 1, not 0. On Mongo the upsert applied
 * `$setOnInsert` and `$inc` together, so a first co-service inserted the row AND
 * incremented it in one operation; a 0 here would undercount every pair's first
 * panel by one, forever, and the error is invisible until a pair reaches the
 * threshold a panel later than it should.
 */
export async function recordCoService(
  tx: PgTransactionHandle,
  pairKey: string,
  reviewerIdA: string,
  reviewerIdB: string,
  servedAt: Date,
): Promise<void> {
  requireTransaction(tx);

  await tx
    .insert(reviewerAffinities)
    .values({
      pairKey,
      reviewerIdA,
      reviewerIdB,
      coServedCount: 1,
      lastServedAt: servedAt,
    })
    .onConflictDoUpdate({
      target: reviewerAffinities.pairKey,
      set: {
        coServedCount: sql`${reviewerAffinities.coServedCount} + 1`,
        lastServedAt: sql.raw(`excluded.${sqlColumnName(reviewerAffinities.lastServedAt)}`),
      },
    });
}

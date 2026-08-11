import { and, asc, eq, gt, gte, inArray, lte, or } from 'drizzle-orm';

import { assignments, OPEN_ASSIGNMENT_STATUSES, sortitionDraws } from '../schema/sortition';
import { requireTransaction, type PgHandle, type PgTransactionHandle } from '../withTenant';

/**
 * The jury tables, as PostgreSQL repositories: `assignments` and
 * `sortition_draws`.
 *
 * Neither is tenant-owned, for the reason `schema/sortition.ts` sets out at
 * length: every row carries the tenant pair, stamped from the case inside the
 * draw's transaction, but the READER of an assignment presents an Oxy session
 * that carries no tenant to scope by. So every signature here takes a plain
 * `PgHandle` unless the Mongo call site it replaces passed a `ClientSession`.
 *
 * NOTHING CALLS THIS IN PRODUCTION YET. `sortitionRepositories.realdb.test.ts` is
 * what makes these statements ones that have genuinely run against the real
 * schema, the real constraints and the real unprivileged role, rather than ones
 * whose first execution is in production.
 *
 * ## Which functions take a transaction, and why it is not uniform
 *
 * Four do, and each is a call site that passes a `ClientSession` today:
 * `consumeAssignment` (:189, inside the review's transaction),
 * `recuseAssignment` (:232), `expireAssignment` (:308) and `insertAssignment` /
 * `insertDrawnRecord` (:589 and :560, inside `openPanel`'s one transaction).
 *
 * `recordRefusedDraw` deliberately does NOT, and it is the one asymmetry in this
 * file worth reading twice. `recordRefusal` is documented as running outside a
 * transaction on purpose: "there is no domain write to be atomic with, and a
 * refusal that failed to record because a transaction aborted would leave exactly
 * the silence this is meant to break." Giving it a `PgTransactionHandle` would
 * read as tidier and would quietly reverse that decision — a refusal is the
 * record that a case got no panel, and it is worth MORE when the surrounding work
 * is failing, not less.
 *
 * ## The degenerate-input question, answered rather than assumed
 *
 * Ten `$in` and one `$elemMatch` across the whole sortition surface, and no
 * `$all`. That matters because `$in` and `inArray` AGREE on the empty input —
 * Mongo's `$in: []` matches nothing and drizzle renders `inArray(col, [])` as the
 * literal `false` — whereas `$all: []` matches nothing in Mongo while
 * `col @> '{}'` matches EVERYTHING. The `$all` hazard is real in this repository
 * (`eligibilityFilter`, handled in `repositories/reviewers.ts`); it is simply not
 * present on these two tables. So no site here needs a length guard, and the ones
 * that have none are safe in both stores rather than safe by accident.
 */

export type AssignmentRow = typeof assignments.$inferSelect;
export type SortitionDrawRow = typeof sortitionDraws.$inferSelect;

/** An open seat is one the reviewer still holds. Reused by five predicates. */
function isOpen() {
  return inArray(assignments.status, [...OPEN_ASSIGNMENT_STATUSES]);
}

/**
 * Everybody seated on one revision of one case, whatever state their seat is in.
 *
 * THREE call sites share this exact query — `consensus.service.ts:305`,
 * `sortition.service.ts:177` and `sortition.worker.ts:60` — and they are one
 * function rather than three because they are one question. The worker's use is
 * the load-bearing one: it is the idempotency check that stops a replayed
 * `caseReadyForReview` event drawing a second panel, and it is keyed on the
 * CURRENT revision specifically so that an appeal's new revision is correctly
 * seen as having no panel yet.
 */
export async function findAssignmentsForCaseRevision(
  db: PgHandle,
  caseId: string,
  caseRevision: number,
): Promise<AssignmentRow[]> {
  return db
    .select()
    .from(assignments)
    .where(and(eq(assignments.caseId, caseId), eq(assignments.caseRevision, caseRevision)));
}

/** Every assignment ever seated on a case, across all its revisions (§8.5). */
export async function findAssignmentsForCase(
  db: PgHandle,
  caseId: string,
): Promise<AssignmentRow[]> {
  return db.select().from(assignments).where(eq(assignments.caseId, caseId));
}

/**
 * Prior jurors across an incident (§8.5), which is why `incident_id` is
 * denormalised onto the row.
 *
 * The caller only reaches this when `stored.incidentId` is non-null, so the
 * parameter is `string` rather than `string | null` — a null would render as
 * `incident_id = NULL`, which is never true and would silently return no prior
 * jurors at all, i.e. an exclusion rule that quietly stopped excluding.
 */
export async function findAssignmentsForIncident(
  db: PgHandle,
  incidentId: string,
): Promise<AssignmentRow[]> {
  return db.select().from(assignments).where(eq(assignments.incidentId, incidentId));
}

/** One assignment by id. The token path and the replacement path both start here. */
export async function findAssignmentById(
  db: PgHandle,
  assignmentId: string,
): Promise<AssignmentRow | null> {
  const [row] = await db
    .select()
    .from(assignments)
    .where(eq(assignments.assignmentId, assignmentId))
    .limit(1);

  return row ?? null;
}

/**
 * The reviewer's next case: the one they were assigned longest ago.
 *
 * `LIMIT 1` with `ORDER BY offered_at ASC`, matching the Mongo call site's
 * `{ sort: { offeredAt: 1 }, limit: 1 }` — and returning the row rather than a
 * one-element array, because every caller immediately took `[0]`.
 *
 * `offered_at` is `NOT NULL`, so this needs no `NULLS LAST`. Stated because an
 * ordering that silently misplaces null rows is the house bug, and the next
 * reader should not have to go and check the column.
 *
 * `expires_at > now` is strict, matching Mongo's `$gt`. `>=` would hand a reviewer
 * an assignment expiring on the very instant, which `isLive` — the caller's own
 * predicate, also strict — would then reject, producing a null case for a reviewer
 * who has work waiting.
 */
export async function findNextOpenAssignment(
  db: PgHandle,
  reviewerId: string,
  now: Date,
): Promise<AssignmentRow | null> {
  const [row] = await db
    .select()
    .from(assignments)
    .where(and(eq(assignments.reviewerId, reviewerId), isOpen(), gt(assignments.expiresAt, now)))
    .orderBy(asc(assignments.offeredAt))
    .limit(1);

  return row ?? null;
}

/**
 * Open assignments whose deadline has passed, oldest first (§8.7's sweep).
 *
 * `<=` rather than `<`, matching Mongo's `$lte`, and it is the complement of
 * `findNextOpenAssignment`'s strict `>`: together they partition the open
 * assignments at any instant, so a seat expiring exactly now is swept rather than
 * being invisible to both queries.
 */
export async function findDueAssignments(
  db: PgHandle,
  now: Date,
  limit: number,
): Promise<AssignmentRow[]> {
  return db
    .select()
    .from(assignments)
    .where(and(isOpen(), lte(assignments.expiresAt, now)))
    .orderBy(asc(assignments.expiresAt))
    .limit(limit);
}

/**
 * §13.7's exposure rows: what these reviewers are holding, plus what they have
 * completed today.
 *
 * ONE query with an `OR`, as the Mongo site is, rather than two. Both arms are
 * bounded — open assignments by `MAX_OPEN_ASSIGNMENTS` and today's completions by
 * the daily limit — so the result is small by construction for every reviewer.
 *
 * `completed_at >= dayStart` needs no accompanying NOT NULL test, and that is
 * checked rather than assumed: `completed_at` is nullable and null on every seat
 * not yet finished. Mongo's `{ completedAt: { $gte: dayStart } }` does not match a
 * null; in SQL the comparison yields NULL, and a `WHERE` treats NULL as
 * not-matching. So the two stores agree, and adding `IS NOT NULL` would change
 * nothing. Written down because "is a null row included here?" is exactly the
 * question a port gets wrong silently, in the direction of counting a reviewer as
 * having done work they have not.
 */
export async function findExposureAssignments(
  db: PgHandle,
  reviewerIds: readonly string[],
  dayStart: Date,
): Promise<AssignmentRow[]> {
  return db
    .select()
    .from(assignments)
    .where(
      and(
        inArray(assignments.reviewerId, [...reviewerIds]),
        or(isOpen(), gte(assignments.completedAt, dayStart)),
      ),
    );
}

/**
 * Rotates the token and marks the assignment accepted, conditionally.
 *
 * The `status IN (open)` term in the WHERE is the whole point: it is what makes
 * "somebody expired or completed this between the read and this write" return no
 * row instead of overwriting a finished assignment. The caller turns the null into
 * a 409. A read-then-write would race with itself.
 *
 * `accepted_at` is set by the CALLER's coalesce (`assignment.acceptedAt ?? now`)
 * rather than by a `COALESCE` here, because that is where the read that produced
 * it lives — and re-deriving it in SQL would make the first acceptance's timestamp
 * move every time the reviewer reloads, which is the one thing the coalesce is
 * there to prevent.
 */
export async function openAssignment(
  db: PgHandle,
  assignmentId: string,
  patch: {
    readonly tokenHash: string;
    readonly acceptedAt: Date;
  },
): Promise<AssignmentRow | null> {
  const [row] = await db
    .update(assignments)
    .set({ status: 'accepted', tokenHash: patch.tokenHash, acceptedAt: patch.acceptedAt })
    .where(and(eq(assignments.assignmentId, assignmentId), isOpen()))
    .returning();

  return row ?? null;
}

/**
 * Marks an assignment as having produced a review. ONE VOTE PER JUROR.
 *
 * The conditional WHERE *is* that rule: a second submission — a double-click, a
 * retried request, a reviewer trying twice — finds the status no longer
 * `accepted`, updates no row, and the caller raises a conflict rather than storing
 * a second review.
 *
 * `status = 'accepted'` exactly, NOT the open set. An `offered` assignment has not
 * been opened, so its token was never rotated to the one the reviewer is holding;
 * widening this to `isOpen()` would let a submission skip the acceptance step.
 *
 * Takes a transaction because the Mongo call site does: it runs inside the
 * review's transaction, so a review that fails to store cannot leave a consumed
 * assignment behind, and a consumed assignment cannot exist without its review.
 */
export async function consumeAssignmentForReview(
  tx: PgTransactionHandle,
  assignmentId: string,
  now: Date,
): Promise<AssignmentRow | null> {
  requireTransaction(tx);

  const [row] = await tx
    .update(assignments)
    .set({ status: 'submitted', completedAt: now })
    .where(
      and(
        eq(assignments.assignmentId, assignmentId),
        eq(assignments.status, 'accepted'),
        gt(assignments.expiresAt, now),
      ),
    )
    .returning();

  return row ?? null;
}

/**
 * §8.7's recusal: the reviewer steps away, and the seat is vacated.
 *
 * `completed_at` is set to NULL explicitly, not left alone. A recusal is NOT a
 * completion — §13.7 counts completions toward a reviewer's daily exposure, and a
 * recusal that left a stale `completed_at` behind would charge somebody for work
 * they declined. The Mongo write sets it to null for the same reason; drizzle
 * would simply omit an undefined, so the null has to be written.
 *
 * Transactional because the vacancy's outbox row has to commit with it: the
 * replacement is drawn from that event, and a recusal recorded without one leaves
 * the panel permanently a member short with nothing recording why.
 */
export async function recuseAssignment(
  tx: PgTransactionHandle,
  assignmentId: string,
  recusalReason: string,
): Promise<AssignmentRow | null> {
  requireTransaction(tx);

  const [row] = await tx
    .update(assignments)
    .set({ status: 'recused', recusalReason, completedAt: null })
    .where(and(eq(assignments.assignmentId, assignmentId), isOpen()))
    .returning();

  return row ?? null;
}

/**
 * Expires one overdue assignment, conditionally.
 *
 * The condition makes a concurrent sweep harmless: whichever process updates the
 * row first is the one that gets a row back and therefore the one that emits its
 * outbox event. The loser updates nothing and emits nothing, so two sweeps running
 * together produce one replacement rather than two.
 */
export async function expireAssignment(
  tx: PgTransactionHandle,
  assignmentId: string,
): Promise<AssignmentRow | null> {
  requireTransaction(tx);

  const [row] = await tx
    .update(assignments)
    .set({ status: 'expired' })
    .where(and(eq(assignments.assignmentId, assignmentId), isOpen()))
    .returning();

  return row ?? null;
}

/**
 * Seats one reviewer, inside the draw's transaction.
 *
 * Transactional, and this is the strongest case in the file: §8.5 requires the
 * draw record to be persisted BEFORE the assignments it produced, in one
 * transaction, so neither can exist without the other. A seat committed outside it
 * would survive a draw that rolled back — a reviewer holding a case that no record
 * explains, which is precisely the thing sortition exists to make impossible.
 */
export async function insertAssignment(
  tx: PgTransactionHandle,
  row: typeof assignments.$inferInsert,
): Promise<void> {
  requireTransaction(tx);

  await tx.insert(assignments).values(row);
}

/**
 * Records which assignment took a vacated seat's place.
 *
 * No transaction: the Mongo call site (`sortition.worker.ts:113`) passes no
 * session, and it runs AFTER `openPanel` has committed the replacement. The
 * pointer is an audit convenience — the worker's own idempotency comes from
 * reading `replacementAssignmentId` back before drawing, so a crash between the
 * draw and this write costs a duplicate replacement at worst, never a lost seat.
 */
export async function setReplacementAssignment(
  db: PgHandle,
  assignmentId: string,
  replacementAssignmentId: string,
): Promise<void> {
  await db
    .update(assignments)
    .set({ replacementAssignmentId })
    .where(eq(assignments.assignmentId, assignmentId));
}

/**
 * Writes the record of a draw that DID seat a panel, inside its transaction.
 *
 * §8.5 ends with `persist(seed, candidateSnapshot, selected, rulesVersion)` before
 * `issueTemporaryAssignments(selected)`, and that ordering is the entire reason a
 * sortition can be audited afterwards: a draw whose seed was never written is a
 * draw nobody can check, and a seed written after the panel could have been
 * re-rolled until it came out well.
 */
export async function insertDrawnRecord(
  tx: PgTransactionHandle,
  row: typeof sortitionDraws.$inferInsert,
): Promise<void> {
  requireTransaction(tx);

  await tx.insert(sortitionDraws).values(row);
}

/**
 * Writes the record of a draw that produced NO panel.
 *
 * OUTSIDE a transaction, deliberately, mirroring `recordRefusal`'s own reasoning:
 * there is no domain write to be atomic with, and a refusal that failed to record
 * because some surrounding transaction aborted would leave exactly the silence
 * this row exists to break. A case that could not open a panel is the single most
 * important thing for an operator to see — it is the difference between "the pool
 * is too small" and "moderation silently stopped".
 *
 * So the `PgHandle` here is a decision, not an omission. Do not "tidy" it into a
 * `PgTransactionHandle` to match its sibling above.
 */
export async function recordRefusedDraw(
  db: PgHandle,
  row: typeof sortitionDraws.$inferInsert,
): Promise<void> {
  await db.insert(sortitionDraws).values(row);
}

/** One draw by id — `replayDraw`'s entry point (§16.3). */
export async function findSortitionDrawById(
  db: PgHandle,
  drawId: string,
): Promise<SortitionDrawRow | null> {
  const [row] = await db
    .select()
    .from(sortitionDraws)
    .where(eq(sortitionDraws.drawId, drawId))
    .limit(1);

  return row ?? null;
}

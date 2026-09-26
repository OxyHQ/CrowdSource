import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';

import {
  accountErasures,
  accountEventCursors,
  type AccountErasureSource,
} from '../schema/accountErasure';
import { organizationMembers, staffAuditEvents, trustSafetyStaff } from '../schema/console';
import { appTrustSnapshots } from '../schema/infrastructure';
import {
  reviewerAffinities,
  reviewerPrincipalLinks,
  reviewerProfiles,
  reviewerRelations,
} from '../schema/reviewers';
import { OPEN_ASSIGNMENT_STATUSES, assignments, reviews } from '../schema/sortition';
import { applications } from '../schema/tenancy';
import { webhookDeliveries } from '../schema/webhooks';
import { requireTransaction, type PgHandle, type PgTransactionHandle } from '../withTenant';

/**
 * Account erasure, the UNSCOPED half (`docs/architecture/account-erasure.md`).
 *
 * Two kinds of statement live here and neither can carry a tenant:
 *
 *  - the ledger and the feed cursor, which record work about a PERSON, and a
 *    person belongs to no application;
 *  - the erasure statements on tables the registry already files as unscoped
 *    (`tableRegistry.ts`): reviewer profiles and everything keyed on a reviewer,
 *    console memberships and staff rows, the operator audit trail, application
 *    standing, and webhook deliveries.
 *
 * The TENANT-scoped statements are in `scoped/accountErasure.ts` and take the
 * branded handle; the service enters each tenant from the stored application
 * row, exactly as the outbox workers do.
 */

export type AccountErasureRow = typeof accountErasures.$inferSelect;

// ── The ledger ───────────────────────────────────────────────────────────────

export interface AccountErasureRequest {
  readonly eventId: string;
  readonly oxyUserId: string;
  readonly source: AccountErasureSource;
  readonly occurredAt: Date | null;
  readonly retained: boolean;
}

/**
 * Record a verified event, once. A second arrival of the same event id (a
 * redelivery, or the push and the pull both carrying it) inserts nothing and
 * reads back the row the first arrival wrote.
 */
export async function recordAccountErasure(
  db: PgHandle,
  request: AccountErasureRequest,
): Promise<{ inserted: boolean; row: AccountErasureRow }> {
  const inserted = await db
    .insert(accountErasures)
    .values({
      eventId: request.eventId,
      oxyUserId: request.oxyUserId,
      source: request.source,
      occurredAt: request.occurredAt,
      retained: request.retained,
      status: 'pending',
      attempts: 0,
    })
    .onConflictDoNothing({ target: accountErasures.eventId })
    .returning();
  if (inserted[0] !== undefined) return { inserted: true, row: inserted[0] };

  const existing = await findAccountErasure(db, request.eventId);
  /* v8 ignore next -- a conflict on the primary key means the row exists; nothing deletes one. */
  if (!existing) throw new Error('An account erasure conflicted on its event id and cannot be read back.');
  return { inserted: false, row: existing };
}

export async function findAccountErasure(db: PgHandle, eventId: string): Promise<AccountErasureRow | null> {
  const [row] = await db.select().from(accountErasures).where(eq(accountErasures.eventId, eventId)).limit(1);
  return row ?? null;
}

/**
 * Take the lease on one erasure. Only a row that is not finished and not held
 * by a live lease can be taken, so two tasks never erase one account at once;
 * the loser gets `null` and does nothing.
 */
export async function claimAccountErasure(
  db: PgHandle,
  eventId: string,
  now: Date,
  leaseMs: number,
): Promise<AccountErasureRow | null> {
  const [row] = await db
    .update(accountErasures)
    .set({
      status: 'running',
      attempts: sql`${accountErasures.attempts} + 1`,
      leaseUntil: new Date(now.getTime() + leaseMs),
    })
    .where(
      and(
        eq(accountErasures.eventId, eventId),
        inArray(accountErasures.status, ['pending', 'failed', 'running']),
        or(isNull(accountErasures.leaseUntil), lte(accountErasures.leaseUntil, now)),
      ),
    )
    .returning();
  return row ?? null;
}

export async function completeAccountErasure(
  db: PgHandle,
  eventId: string,
  counts: Record<string, number>,
  now: Date,
): Promise<void> {
  await db
    .update(accountErasures)
    .set({ status: 'completed', completedAt: now, leaseUntil: null, counts, lastError: null })
    .where(eq(accountErasures.eventId, eventId));
}

export async function failAccountErasure(db: PgHandle, eventId: string, classification: string): Promise<void> {
  await db
    .update(accountErasures)
    .set({ status: 'failed', leaseUntil: null, lastError: classification })
    .where(eq(accountErasures.eventId, eventId));
}

/**
 * Unfinished erasures whose lease is free: never run (the in-process start was
 * lost to a restart), failed, or held by a task that died mid-run.
 */
export async function findRetryableAccountErasures(db: PgHandle, now: Date, limit: number): Promise<string[]> {
  const rows = await db
    .select({ eventId: accountErasures.eventId })
    .from(accountErasures)
    .where(
      and(
        inArray(accountErasures.status, ['pending', 'failed', 'running']),
        or(isNull(accountErasures.leaseUntil), lte(accountErasures.leaseUntil, now)),
      ),
    )
    .orderBy(asc(accountErasures.createdAt))
    .limit(limit);
  return rows.map((row) => row.eventId);
}

// ── The pull-feed cursor ─────────────────────────────────────────────────────

/**
 * Take the feed's lease for `owner`, creating the row on first use. Returns the
 * cursor to read from, or `undefined` when another task holds a live lease.
 */
export async function claimAccountEventFeed(
  db: PgHandle,
  feed: string,
  owner: string,
  now: Date,
  leaseMs: number,
): Promise<{ cursor: string | null } | undefined> {
  const leaseUntil = new Date(now.getTime() + leaseMs);
  await db
    .insert(accountEventCursors)
    .values({ feed, cursor: null, leaseOwner: null, leaseUntil: null })
    .onConflictDoNothing({ target: accountEventCursors.feed });
  const [row] = await db
    .update(accountEventCursors)
    .set({ leaseOwner: owner, leaseUntil })
    .where(
      and(
        eq(accountEventCursors.feed, feed),
        or(
          isNull(accountEventCursors.leaseUntil),
          lte(accountEventCursors.leaseUntil, now),
          eq(accountEventCursors.leaseOwner, owner),
        ),
      ),
    )
    .returning({ cursor: accountEventCursors.cursor });
  return row === undefined ? undefined : { cursor: row.cursor };
}

/**
 * Move the cursor, but only while `owner` still holds the lease. A task whose
 * lease lapsed mid-read must not rewind or skip a cursor another task now owns.
 */
export async function advanceAccountEventCursor(
  db: PgHandle,
  feed: string,
  owner: string,
  cursor: string,
): Promise<boolean> {
  const rows = await db
    .update(accountEventCursors)
    .set({ cursor })
    .where(and(eq(accountEventCursors.feed, feed), eq(accountEventCursors.leaseOwner, owner)))
    .returning({ feed: accountEventCursors.feed });
  return rows.length > 0;
}

export async function releaseAccountEventFeed(db: PgHandle, feed: string, owner: string): Promise<void> {
  await db
    .update(accountEventCursors)
    .set({ leaseOwner: null, leaseUntil: null })
    .where(and(eq(accountEventCursors.feed, feed), eq(accountEventCursors.leaseOwner, owner)));
}

// ── Erasure on unscoped tables ───────────────────────────────────────────────

/** Every application, whatever its status: a suspended tenant still holds rows. */
export async function listApplicationTenants(
  db: PgHandle,
): Promise<{ organizationId: string; applicationId: string }[]> {
  return await db
    .select({ organizationId: applications.organizationId, applicationId: applications.applicationId })
    .from(applications)
    .orderBy(asc(applications.applicationId));
}

export async function findReviewerIdByOxyUserId(db: PgHandle, oxyUserId: string): Promise<string | null> {
  const [row] = await db
    .select({ reviewerId: reviewerProfiles.reviewerId })
    .from(reviewerProfiles)
    .where(eq(reviewerProfiles.oxyUserId, oxyUserId))
    .limit(1);
  return row?.reviewerId ?? null;
}

export interface ReviewerErasureCounts {
  readonly assignmentsVacated: number;
  readonly principalLinksDeleted: number;
  readonly relationsDeleted: number;
  readonly affinitiesDeleted: number;
  readonly reviewNotesCleared: number;
  readonly profilesAnonymised: number;
}

/**
 * Detach a reviewer from the person, in ONE transaction, profile last.
 *
 * - Open seats are made due NOW rather than closed here, so the ordinary expiry
 *   sweep (`expireDueAssignments`) closes each one and writes the outbox event
 *   that draws a replacement. The panel is never left a juror short, and no
 *   second vacate path exists to drift from the first.
 * - The person's own reviewer data goes: the application accounts they said were
 *   theirs, their declared conflicts, their co-service pairs, and the free-text
 *   notes on their reviews.
 * - The profile row STAYS, with the Oxy id replaced and every preference
 *   cleared. Reviews and draws name the reviewer id, and a case still being
 *   counted reads the profile's state and specialisms to count a ballot that was
 *   cast (`consensus.service.ts#ballotsOf`). With `account_active` false it can
 *   never be drawn again.
 */
export async function eraseReviewer(
  tx: PgTransactionHandle,
  reviewerId: string,
  now: Date,
  erasedOxyUserId: string,
): Promise<ReviewerErasureCounts> {
  requireTransaction(tx);

  const vacated = await tx
    .update(assignments)
    .set({ expiresAt: now })
    .where(
      and(
        eq(assignments.reviewerId, reviewerId),
        inArray(assignments.status, [...OPEN_ASSIGNMENT_STATUSES]),
        gt(assignments.expiresAt, now),
      ),
    )
    .returning({ id: assignments.assignmentId });
  const links = await tx
    .delete(reviewerPrincipalLinks)
    .where(eq(reviewerPrincipalLinks.reviewerId, reviewerId))
    .returning({ id: reviewerPrincipalLinks.reviewerId });
  const relations = await tx
    .delete(reviewerRelations)
    .where(eq(reviewerRelations.reviewerId, reviewerId))
    .returning({ id: reviewerRelations.reviewerRelationId });
  const affinities = await tx
    .delete(reviewerAffinities)
    .where(or(eq(reviewerAffinities.reviewerIdA, reviewerId), eq(reviewerAffinities.reviewerIdB, reviewerId)))
    .returning({ id: reviewerAffinities.pairKey });
  const notes = await tx
    .update(reviews)
    .set({ notes: null })
    .where(and(eq(reviews.reviewerId, reviewerId), isNotNull(reviews.notes)))
    .returning({ id: reviews.reviewId });
  const profiles = await tx
    .update(reviewerProfiles)
    .set({
      oxyUserId: erasedOxyUserId,
      accountActive: false,
      available: false,
      riskClusterId: null,
      languages: [],
      categories: [],
      consentedSensitiveCategories: [],
      declaredConflictApplications: [],
      trainingCompletedModules: [],
    })
    .where(eq(reviewerProfiles.reviewerId, reviewerId))
    .returning({ id: reviewerProfiles.reviewerId });

  return {
    assignmentsVacated: vacated.length,
    principalLinksDeleted: links.length,
    relationsDeleted: relations.length,
    affinitiesDeleted: affinities.length,
    reviewNotesCleared: notes.length,
    profilesAnonymised: profiles.length,
  };
}

/**
 * Other reviewers' rows that name the person's APPLICATION account: a conflict
 * someone declared with them, or a link claiming it. Both exist only to keep a
 * reviewer off cases involving that account, and the account is gone.
 */
export async function deleteReviewerRowsNamingPrincipal(
  db: PgHandle,
  principalId: string,
): Promise<{ relationsDeleted: number; principalLinksDeleted: number }> {
  const relations = await db
    .delete(reviewerRelations)
    .where(eq(reviewerRelations.externalPrincipalId, principalId))
    .returning({ id: reviewerRelations.reviewerRelationId });
  const links = await db
    .delete(reviewerPrincipalLinks)
    .where(eq(reviewerPrincipalLinks.externalPrincipalId, principalId))
    .returning({ id: reviewerPrincipalLinks.reviewerId });
  return { relationsDeleted: relations.length, principalLinksDeleted: links.length };
}

export interface ConsoleErasureCounts {
  readonly membershipsDeleted: number;
  readonly invitationsAnonymised: number;
  readonly staffDeleted: number;
  readonly staffAuditAnonymised: number;
  readonly standingChangesAnonymised: number;
}

/**
 * The console and the operator trail. Access goes (a membership, a staff role);
 * the record of what the person DID as an operator stays, with the actor
 * replaced — the trail is how a privileged act is accounted for after the fact.
 */
export async function eraseConsoleIdentity(
  tx: PgTransactionHandle,
  oxyUserId: string,
  erased: string,
): Promise<ConsoleErasureCounts> {
  requireTransaction(tx);

  const memberships = await tx
    .delete(organizationMembers)
    .where(eq(organizationMembers.oxyUserId, oxyUserId))
    .returning({ id: organizationMembers.membershipId });
  const invitations = await tx
    .update(organizationMembers)
    .set({ invitedByOxyUserId: erased })
    .where(eq(organizationMembers.invitedByOxyUserId, oxyUserId))
    .returning({ id: organizationMembers.membershipId });
  const staff = await tx
    .delete(trustSafetyStaff)
    .where(eq(trustSafetyStaff.oxyUserId, oxyUserId))
    .returning({ id: trustSafetyStaff.oxyUserId });
  const audit = await tx
    .update(staffAuditEvents)
    .set({ actorOxyUserId: erased })
    .where(eq(staffAuditEvents.actorOxyUserId, oxyUserId))
    .returning({ id: staffAuditEvents.staffAuditId });
  const standing = await tx
    .update(appTrustSnapshots)
    .set({ standingChangedByOxyUserId: erased })
    .where(eq(appTrustSnapshots.standingChangedByOxyUserId, oxyUserId))
    .returning({ id: appTrustSnapshots.applicationId });

  return {
    membershipsDeleted: memberships.length,
    invitationsAnonymised: invitations.length,
    staffDeleted: staff.length,
    staffAuditAnonymised: audit.length,
    standingChangesAnonymised: standing.length,
  };
}

/**
 * Webhook bodies that name the person as a community note's writer, rewritten
 * with the id replaced. The body is signed when it is SENT
 * (`delivery.worker.ts`), never stored signed, so a pending delivery still
 * verifies at its receiver.
 */
export async function anonymiseWebhookBodies(
  db: PgHandle,
  principalId: string,
  erased: string,
): Promise<number> {
  const rows = await db
    .update(webhookDeliveries)
    .set({
      body: sql`jsonb_set(${webhookDeliveries.body}::jsonb, '{data,authorPrincipalId}', to_jsonb(${erased}::text))::text`,
    })
    .where(
      and(
        sql`strpos(${webhookDeliveries.body}, ${principalId}) > 0`,
        sql`${webhookDeliveries.body}::jsonb -> 'data' ->> 'authorPrincipalId' = ${principalId}`,
      ),
    )
    .returning({ id: webhookDeliveries.deliveryId });
  return rows.length;
}

import { sqlStateOf } from '@oxy.so/db';

import { getPostgresDatabase } from '../../db/postgres/database';
import {
  anonymiseWebhookBodies,
  claimAccountErasure,
  completeAccountErasure,
  deleteReviewerRowsNamingPrincipal,
  eraseConsoleIdentity,
  eraseReviewer,
  failAccountErasure,
  findReviewerIdByOxyUserId,
  listApplicationTenants,
  recordAccountErasure,
  type AccountErasureRow,
} from '../../db/postgres/repositories/accountErasure';
import {
  anonymiseAppellant,
  anonymiseAuditActor,
  anonymiseCommunityNoteSubjectAuthor,
  deleteCommunityNoteRatingsByRater,
  deleteCommunityNotesByAuthor,
  findCasesNamingPrincipal,
  findReportsNamingPrincipal,
  replaceCaseIdentity,
  replaceReportEnvelope,
} from '../../db/postgres/repositories/scoped/accountErasure';
import type { AccountErasureSource } from '../../db/postgres/schema/accountErasure';
import { withTenant } from '../../db/postgres/withTenant';
import { createTenantContext, type TenantContext } from '../../db/tenantScope';
import { withTransaction } from '../../db/transaction';
import { logger } from '../../utils/logger';
import { principalReporterKey, reporterFingerprint } from '../cases/case.service';
import { ERASED_ACCOUNT, ERASED_PREFIX, erasedRowIdentity } from './erasedIdentity';
import { eraseFromEnvelope, eraseFromSnapshot, replaceFingerprint } from './materialErasure';
import type { OxyAccountEvent } from './oxyAccountEvents';

/**
 * Erasing a deleted Oxy account (`docs/architecture/account-erasure.md`,
 * OxyHQ/Mention#1178).
 *
 * A verified `account.deleted` event is recorded once in `account_erasures`
 * (the ledger AND the durable work record), then run. A run takes a lease on
 * the row, so one account is never erased by two tasks at once, and every step
 * matches by the person's id and leaves nothing that still matches — so a
 * re-run after a crash, a redelivery or an overlap between push and pull
 * converges instead of repeating work. Only counts are logged and stored.
 *
 * The person's id is matched in two roles:
 *
 *  - as an OXY ACCOUNT: a reviewer profile, console memberships and staff rows,
 *    and the operator and tenant audit trails;
 *  - as an APPLICATION PRINCIPAL: in every tenant, wherever a principal id equals
 *    the Oxy id — an `oxy_user` binding's proof, or a principal id an
 *    application chose to be the Oxy id (Mention does, for reports and notes).
 *    An application whose principal ids are its own opaque ids simply has no
 *    row that matches, so this cannot touch another person's data unless a
 *    tenant gave someone the deleted person's exact Oxy id as their principal
 *    id — which makes them that person.
 */

/** A run holds its row this long; a task that dies mid-run frees it after. */
export const ERASURE_LEASE_MS = 10 * 60 * 1000;
/** Reports and cases rewritten per statement, per tenant. */
export const ERASURE_BATCH = 200;

export type ErasureCounts = Record<string, number>;

function add(counts: ErasureCounts, key: string, value: number): void {
  if (value > 0) counts[key] = (counts[key] ?? 0) + value;
}

/** A failure recorded on the ledger: a class, never a message (it may quote data). */
export function errorClassification(error: unknown): string {
  const state = sqlStateOf(error);
  if (state && /^[0-9A-Z]{5}$/.test(state)) return `sqlstate_${state}`;
  return error instanceof Error ? error.name : 'unknown';
}

async function eraseInTenant(
  context: TenantContext,
  oxyUserId: string,
  eventId: string,
  counts: ErasureCounts,
): Promise<void> {
  const db = getPostgresDatabase();

  await withTenant(db, context, async (tx) => {
    const notes = await deleteCommunityNotesByAuthor(tx, oxyUserId);
    add(counts, 'communityNotes.deleted', notes.notesDeleted);
    add(counts, 'communityNotes.ratingsOfDeletedNotes', notes.noteRatingsDeleted);
    add(counts, 'communityNotes.assignmentsOfDeletedNotes', notes.noteAssignmentsDeleted);
    add(counts, 'communityNotes.revisionsOfDeletedNotes', notes.noteRevisionsDeleted);

    const rated = await deleteCommunityNoteRatingsByRater(tx, oxyUserId);
    add(counts, 'communityNotes.ratingsDeleted', rated.ratingsDeleted);
    add(counts, 'communityNotes.rateAssignmentsDeleted', rated.assignmentsDeleted);

    add(
      counts,
      'communityNotes.subjectAuthorAnonymised',
      await anonymiseCommunityNoteSubjectAuthor(tx, oxyUserId, ERASED_ACCOUNT),
    );
    add(counts, 'appeals.appellantAnonymised', await anonymiseAppellant(tx, oxyUserId, ERASED_ACCOUNT));
    add(counts, 'auditEvents.actorAnonymised', await anonymiseAuditActor(tx, oxyUserId, ERASED_ACCOUNT));
  });

  // Reports and cases in bounded pages, each its own transaction. A rewritten
  // row no longer matches, so the loop ends when a page comes back empty.
  for (;;) {
    const rewritten = await withTenant(db, context, async (tx) => {
      const page = await findReportsNamingPrincipal(tx, oxyUserId, ERASURE_BATCH);
      for (const report of page) {
        const erased = eraseFromEnvelope(report.envelope, oxyUserId);
        /* v8 ignore next -- the query matched a binding naming the id, so the rewrite always finds it. */
        if (erased.envelope === null) continue;
        await replaceReportEnvelope(tx, report.reportId, erased.envelope);
        add(counts, 'reports.bindingsAnonymised', erased.bindingsErased);
        add(counts, 'reports.reporterDetailsCleared', erased.detailsCleared);
      }
      return page.length;
    });
    add(counts, 'reports.rewritten', rewritten);
    if (rewritten < ERASURE_BATCH) break;
  }

  const personal = reporterFingerprint(context.applicationId, principalReporterKey(oxyUserId));
  const standIn = reporterFingerprint(context.applicationId, `${ERASED_PREFIX}${eventId}`);
  for (;;) {
    const rewritten = await withTenant(db, context, async (tx) => {
      const page = await findCasesNamingPrincipal(tx, oxyUserId, personal, ERASURE_BATCH);
      for (const row of page) {
        const snapshot = eraseFromSnapshot(row.contentSnapshot, oxyUserId);
        const fingerprints = replaceFingerprint(row.reporterFingerprints, personal, standIn);
        await replaceCaseIdentity(
          tx,
          row.caseId,
          snapshot.snapshot ?? row.contentSnapshot,
          fingerprints.fingerprints,
        );
        add(counts, 'cases.principalsAnonymised', snapshot.principalsErased);
        add(counts, 'cases.reporterFingerprintsReplaced', fingerprints.replaced);
      }
      return page.length;
    });
    add(counts, 'cases.rewritten', rewritten);
    if (rewritten < ERASURE_BATCH) break;
  }
}

/**
 * Erase everything this service holds for one Oxy account. Idempotent: an
 * account with nothing left (or never seen) returns empty counts.
 */
export async function eraseAccount(oxyUserId: string, eventId: string, now: Date = new Date()): Promise<ErasureCounts> {
  const db = getPostgresDatabase();
  const counts: ErasureCounts = {};

  // Tenant data first, the reviewer profile last: the profile is what ties a
  // reviewer id to the person, and a crash before the end must leave it
  // findable so the re-run can finish the job.
  for (const tenant of await listApplicationTenants(db)) {
    await eraseInTenant(createTenantContext(tenant.organizationId, tenant.applicationId), oxyUserId, eventId, counts);
  }

  add(counts, 'webhookDeliveries.bodiesAnonymised', await anonymiseWebhookBodies(db, oxyUserId, ERASED_ACCOUNT));

  const named = await deleteReviewerRowsNamingPrincipal(db, oxyUserId);
  add(counts, 'reviewers.relationsNamingAccountDeleted', named.relationsDeleted);
  add(counts, 'reviewers.linksNamingAccountDeleted', named.principalLinksDeleted);

  await withTransaction(async (tx) => {
    const consoleCounts = await eraseConsoleIdentity(tx, oxyUserId, ERASED_ACCOUNT);
    add(counts, 'console.membershipsDeleted', consoleCounts.membershipsDeleted);
    add(counts, 'console.invitationsAnonymised', consoleCounts.invitationsAnonymised);
    add(counts, 'console.staffDeleted', consoleCounts.staffDeleted);
    add(counts, 'console.staffAuditAnonymised', consoleCounts.staffAuditAnonymised);
    add(counts, 'console.standingChangesAnonymised', consoleCounts.standingChangesAnonymised);
  });

  const reviewerId = await findReviewerIdByOxyUserId(db, oxyUserId);
  if (reviewerId !== null) {
    await withTransaction(async (tx) => {
      const reviewer = await eraseReviewer(tx, reviewerId, now, erasedRowIdentity(reviewerId));
      add(counts, 'reviewer.assignmentsVacated', reviewer.assignmentsVacated);
      add(counts, 'reviewer.principalLinksDeleted', reviewer.principalLinksDeleted);
      add(counts, 'reviewer.relationsDeleted', reviewer.relationsDeleted);
      add(counts, 'reviewer.affinitiesDeleted', reviewer.affinitiesDeleted);
      add(counts, 'reviewer.reviewNotesCleared', reviewer.reviewNotesCleared);
      add(counts, 'reviewer.profilesAnonymised', reviewer.profilesAnonymised);
    });
  }

  return counts;
}

/**
 * Run one recorded erasure, if its lease is free. Returns the outcome; never
 * throws for a failed run (the failure is on the row, and the reconciliation
 * tick retries it).
 */
export async function processAccountErasure(
  eventId: string,
  now: Date = new Date(),
): Promise<'completed' | 'failed' | 'skipped'> {
  const db = getPostgresDatabase();
  const row = await claimAccountErasure(db, eventId, now, ERASURE_LEASE_MS);
  if (!row) return 'skipped';

  logger.info({ eventId, attempt: row.attempts }, 'Account erasure started');
  try {
    const counts = await eraseAccount(row.oxyUserId, row.eventId, now);
    await completeAccountErasure(db, row.eventId, counts, new Date());
    logger.info({ eventId, counts }, 'Account erasure completed');
    return 'completed';
  } catch (caught: unknown) {
    const classification = errorClassification(caught);
    await failAccountErasure(db, row.eventId, classification);
    logger.error({ eventId, classification }, 'Account erasure failed; the reconciliation tick retries it');
    return 'failed';
  }
}

const background = new Set<Promise<unknown>>();

/**
 * Start a recorded erasure without holding up the caller. A completed row is
 * never re-run. The work is tracked so shutdown and tests can wait for it.
 */
export function scheduleAccountErasure(row: AccountErasureRow): void {
  if (row.status === 'completed') return;
  const run = processAccountErasure(row.eventId)
    .catch(() => {
      // Claiming or recording failed (the database went away). The row is
      // still unfinished, and the reconciliation tick retries it.
      logger.error({ eventId: row.eventId }, 'Account erasure could not be started');
    })
    .finally(() => background.delete(run));
  background.add(run);
}

/** Wait for every erasure started in the background. */
export async function settleBackgroundErasures(): Promise<void> {
  while (background.size > 0) await Promise.all([...background]);
}

export interface IntakeResult {
  readonly inserted: boolean;
  readonly status: AccountErasureRow['status'];
}

/** Record a VERIFIED event and start its erasure. Shared by push and pull. */
export async function acceptAccountEvent(event: OxyAccountEvent, source: AccountErasureSource): Promise<IntakeResult> {
  const occurredAt = new Date(event.occurredAt);
  const { inserted, row } = await recordAccountErasure(getPostgresDatabase(), {
    eventId: event.eventId,
    oxyUserId: event.userId,
    source,
    occurredAt: Number.isNaN(occurredAt.getTime()) ? null : occurredAt,
    retained: event.retained,
  });
  logger.info({ eventId: event.eventId, source, inserted, status: row.status }, 'Account event recorded');
  scheduleAccountErasure(row);
  return { inserted, status: row.status };
}

import { and, asc, eq, gt, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';

import {
  caseEvidenceFiles,
  oxyFileEvents,
  oxyFileReconciliations,
  type EvidenceFileStatus,
  type EvidenceFileVisibility,
  type EvidenceReferenceState,
  type OxyFileEventType,
} from '../schema/evidence';
import { requireTransaction, type PgHandle } from '../withTenant';

/**
 * The statements behind CrowdSource's use of Oxy files
 * (`docs/architecture/evidence-files.md`). UNSCOPED: every reader is a worker or
 * a receiver that spans tenants, or the reviewer surface, which carries none
 * (`tableRegistry.ts`). The rules — what a file event means, when evidence is
 * withheld — live in `modules/evidence/`; this file only reads and writes.
 */

export type CaseEvidenceFileRow = typeof caseEvidenceFiles.$inferSelect;

/** Reference states the worker acts on. */
const DUE_REFERENCE_STATES: readonly EvidenceReferenceState[] = ['pending', 'removal_pending'];

/**
 * The evidence rows of one case, in the report's own transaction.
 *
 * `ON CONFLICT DO NOTHING`: a report that merges into an existing case carries
 * the same material (matching the content hash is what merged it), so its files
 * are already there — with whatever Oxy has said about them since, which a
 * second report must not reset.
 */
export async function insertCaseEvidenceFiles(
  handle: PgHandle,
  input: {
    organizationId: string;
    applicationId: string;
    caseId: string;
    fileIds: readonly string[];
    now: Date;
  },
): Promise<void> {
  if (input.fileIds.length === 0) return;
  const tx = requireTransaction(handle);
  await tx
    .insert(caseEvidenceFiles)
    .values(
      input.fileIds.map((fileId) => ({
        organizationId: input.organizationId,
        applicationId: input.applicationId,
        caseId: input.caseId,
        fileId,
        fileStatus: 'active' as const,
        fileVisibility: null,
        fileStateAt: null,
        referenceState: 'pending' as const,
        referenceAttempts: 0,
        referenceDueAt: input.now,
        referenceClaim: null,
        referenceError: null,
      })),
    )
    .onConflictDoNothing({ target: [caseEvidenceFiles.caseId, caseEvidenceFiles.fileId] });
}

/**
 * Claims up to `limit` rows whose reference is owed (an add or a removal) and
 * due, across every tenant.
 *
 * `FOR UPDATE SKIP LOCKED` so two tasks never claim one row, and the claim is
 * a lease: `reference_due_at` moves to when it lapses, so a task that dies
 * mid-call leaves the row to be claimed again rather than stranded.
 */
export async function claimDueEvidenceReferences(
  db: PgHandle,
  input: { claim: string; now: Date; leaseUntil: Date; limit: number },
): Promise<CaseEvidenceFileRow[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ caseId: caseEvidenceFiles.caseId, fileId: caseEvidenceFiles.fileId })
      .from(caseEvidenceFiles)
      .where(
        and(
          inArray(caseEvidenceFiles.referenceState, [...DUE_REFERENCE_STATES]),
          lte(caseEvidenceFiles.referenceDueAt, input.now),
        ),
      )
      .orderBy(asc(caseEvidenceFiles.referenceDueAt))
      .limit(input.limit)
      .for('update', { skipLocked: true });
    if (due.length === 0) return [];

    return tx
      .update(caseEvidenceFiles)
      .set({
        referenceClaim: input.claim,
        referenceDueAt: input.leaseUntil,
        referenceAttempts: sql`${caseEvidenceFiles.referenceAttempts} + 1`,
        updatedAt: input.now,
      })
      .where(
        or(
          ...due.map((row) =>
            and(eq(caseEvidenceFiles.caseId, row.caseId), eq(caseEvidenceFiles.fileId, row.fileId)),
          ),
        ),
      )
      .returning();
  });
}

/**
 * Writes a claimed row's outcome — only while the claim is still this worker's
 * AND the row still asks for what was claimed.
 *
 * The second condition is the one that matters: a file event can turn a
 * `pending` row into `removal_pending` while the worker is adding its
 * reference, and writing `registered` over that would lose the removal. Such a
 * row is released due now, and the next pass does what it now asks for.
 */
export async function finishEvidenceReference(
  handle: PgHandle,
  input: {
    caseId: string;
    fileId: string;
    claim: string;
    claimedState: EvidenceReferenceState;
    now: Date;
    outcome:
      | { kind: 'done'; referenceState: EvidenceReferenceState }
      | { kind: 'retry'; dueAt: Date; error: string };
  },
): Promise<CaseEvidenceFileRow | undefined> {
  const key = and(
    eq(caseEvidenceFiles.caseId, input.caseId),
    eq(caseEvidenceFiles.fileId, input.fileId),
    eq(caseEvidenceFiles.referenceClaim, input.claim),
  );
  const [written] = await handle
    .update(caseEvidenceFiles)
    .set(
      input.outcome.kind === 'done'
        ? {
            referenceState: input.outcome.referenceState,
            referenceAttempts: 0,
            referenceClaim: null,
            referenceError: null,
            referenceDueAt: input.now,
            updatedAt: input.now,
          }
        : {
            referenceClaim: null,
            referenceError: input.outcome.error,
            referenceDueAt: input.outcome.dueAt,
            updatedAt: input.now,
          },
    )
    .where(and(key, eq(caseEvidenceFiles.referenceState, input.claimedState)))
    .returning();
  if (written) return written;

  // The row moved on under the claim: release it, due now.
  await handle
    .update(caseEvidenceFiles)
    .set({ referenceClaim: null, referenceDueAt: input.now, updatedAt: input.now })
    .where(key);
  return undefined;
}

/**
 * The file ids of one case a jury must not be shown: Oxy said the file is not
 * active or is private, or Oxy refused CrowdSource a reference to it.
 *
 * The predicate is `withheldReason` (modules/evidence/evidenceFiles.ts) in SQL;
 * `evidenceFiles.realdb.test.ts` holds the two equal.
 */
export async function withheldEvidenceFileIds(db: PgHandle, caseId: string): Promise<string[]> {
  const rows = await db
    .select({ fileId: caseEvidenceFiles.fileId })
    .from(caseEvidenceFiles)
    .where(
      and(
        eq(caseEvidenceFiles.caseId, caseId),
        or(
          ne(caseEvidenceFiles.fileStatus, 'active'),
          eq(caseEvidenceFiles.fileVisibility, 'private'),
          eq(caseEvidenceFiles.referenceState, 'refused'),
        ),
      ),
    );
  return rows.map((row) => row.fileId);
}

/**
 * Every (file, case) pair CrowdSource uses, across every tenant, for the
 * reconciliation's inventory: rows whose reference is held or owed. Paged on
 * the primary key so a large table streams rather than loads.
 */
export async function* referencedEvidenceInventory(
  db: PgHandle,
  pageSize = 1000,
): AsyncGenerator<{ fileId: string; entityId: string }> {
  let after: { caseId: string; fileId: string } | null = null;
  for (;;) {
    const page: { caseId: string; fileId: string }[] = await db
      .select({ caseId: caseEvidenceFiles.caseId, fileId: caseEvidenceFiles.fileId })
      .from(caseEvidenceFiles)
      .where(
        and(
          inArray(caseEvidenceFiles.referenceState, ['pending', 'registered']),
          after === null
            ? undefined
            : or(
                gt(caseEvidenceFiles.caseId, after.caseId),
                and(
                  eq(caseEvidenceFiles.caseId, after.caseId),
                  gt(caseEvidenceFiles.fileId, after.fileId),
                ),
              ),
        ),
      )
      .orderBy(asc(caseEvidenceFiles.caseId), asc(caseEvidenceFiles.fileId))
      .limit(pageSize);
    for (const row of page) yield { fileId: row.fileId, entityId: row.caseId };
    if (page.length < pageSize) return;
    after = page[page.length - 1];
  }
}

// ── File events ─────────────────────────────────────────────────────────────

/** Records a delivered event. False when Oxy's event id is already recorded. */
export async function recordOxyFileEvent(
  handle: PgHandle,
  event: {
    eventId: string;
    type: OxyFileEventType;
    fileId: string;
    occurredAt: Date;
    fileStatus: string;
    fileVisibility: string;
  },
): Promise<boolean> {
  const tx = requireTransaction(handle);
  const inserted = await tx
    .insert(oxyFileEvents)
    .values({ ...event, rowsChanged: 0 })
    .onConflictDoNothing({ target: oxyFileEvents.eventId })
    .returning({ eventId: oxyFileEvents.eventId });
  return inserted.length === 1;
}

/** Locks every evidence row of one file, in every tenant, for an event to change. */
export async function lockEvidenceByFile(
  handle: PgHandle,
  fileId: string,
): Promise<CaseEvidenceFileRow[]> {
  const tx = requireTransaction(handle);
  return tx
    .select()
    .from(caseEvidenceFiles)
    .where(eq(caseEvidenceFiles.fileId, fileId))
    .orderBy(asc(caseEvidenceFiles.caseId))
    .for('update');
}

/** Writes what an event changed on one evidence row, and the event's count. */
export async function applyFileEventToEvidence(
  handle: PgHandle,
  input: {
    eventId: string;
    now: Date;
    changes: ReadonlyArray<{
      caseId: string;
      fileId: string;
      fileStatus: EvidenceFileStatus;
      fileVisibility: EvidenceFileVisibility | null;
      fileStateAt: Date;
      referenceState: EvidenceReferenceState;
    }>;
  },
): Promise<void> {
  const tx = requireTransaction(handle);
  for (const change of input.changes) {
    await tx
      .update(caseEvidenceFiles)
      .set({
        fileStatus: change.fileStatus,
        fileVisibility: change.fileVisibility,
        fileStateAt: change.fileStateAt,
        referenceState: change.referenceState,
        // A newly owed removal is due now; anything else keeps its schedule.
        ...(change.referenceState === 'removal_pending'
          ? { referenceDueAt: input.now, referenceAttempts: 0, referenceError: null }
          : {}),
        updatedAt: input.now,
      })
      .where(
        and(
          eq(caseEvidenceFiles.caseId, change.caseId),
          eq(caseEvidenceFiles.fileId, change.fileId),
        ),
      );
  }
  await tx
    .update(oxyFileEvents)
    .set({ rowsChanged: input.changes.length, updatedAt: input.now })
    .where(eq(oxyFileEvents.eventId, input.eventId));
}

// ── Reconciliation ──────────────────────────────────────────────────────────

/**
 * Takes the reconciliation of one entity type for `owner`, or answers false:
 * another task holds an unexpired lease, or a run finished less than
 * `minIntervalMs` ago (every task runs the timer; one run a night is the job).
 */
export async function claimReconciliation(
  db: PgHandle,
  input: { entityType: string; owner: string; now: Date; leaseMs: number; minIntervalMs: number },
): Promise<boolean> {
  await db
    .insert(oxyFileReconciliations)
    .values({ entityType: input.entityType })
    .onConflictDoNothing({ target: oxyFileReconciliations.entityType });
  const claimed = await db
    .update(oxyFileReconciliations)
    .set({
      leaseOwner: input.owner,
      leaseUntil: new Date(input.now.getTime() + input.leaseMs),
      lastStartedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(oxyFileReconciliations.entityType, input.entityType),
        or(
          isNull(oxyFileReconciliations.leaseUntil),
          lte(oxyFileReconciliations.leaseUntil, input.now),
        ),
        or(
          isNull(oxyFileReconciliations.lastCompletedAt),
          lte(
            oxyFileReconciliations.lastCompletedAt,
            new Date(input.now.getTime() - input.minIntervalMs),
          ),
        ),
      ),
    )
    .returning({ entityType: oxyFileReconciliations.entityType });
  return claimed.length === 1;
}

/** Records a run's result and releases the lease, while `owner` still holds it. */
export async function finishReconciliation(
  db: PgHandle,
  input: {
    entityType: string;
    owner: string;
    now: Date;
    dryRun: boolean;
    outcome: { counts: Record<string, number> } | { error: string };
  },
): Promise<void> {
  await db
    .update(oxyFileReconciliations)
    .set({
      leaseOwner: null,
      leaseUntil: null,
      lastDryRun: input.dryRun,
      ...('counts' in input.outcome
        ? { lastCompletedAt: input.now, lastCounts: input.outcome.counts, lastError: null }
        : { lastError: input.outcome.error }),
      updatedAt: input.now,
    })
    .where(
      and(
        eq(oxyFileReconciliations.entityType, input.entityType),
        eq(oxyFileReconciliations.leaseOwner, input.owner),
      ),
    );
}

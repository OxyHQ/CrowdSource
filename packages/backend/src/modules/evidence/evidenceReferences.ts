import { randomUUID } from 'node:crypto';

import type { ServiceFileReference, ServiceFileReferenceResult } from '@oxy.so/core';

import { config } from '../../config';
import { getPostgresDatabase } from '../../db/postgres/database';
import {
  claimDueEvidenceReferences,
  claimReconciliation,
  finishEvidenceReference,
  finishReconciliation,
  referencedEvidenceInventory,
  type CaseEvidenceFileRow,
} from '../../db/postgres/repositories/evidenceFiles';
import type { EvidenceReferenceState } from '../../db/postgres/schema/evidence';
import { createTenantContext } from '../../db/tenantScope';
import { withTransaction } from '../../db/transaction';
import { logger } from '../../utils/logger';
import { appendAuditEvent } from '../audit/audit.collection';
import { withheldReason } from './evidenceFiles';
import { EVIDENCE_ENTITY_TYPE, oxyFilesClient } from './oxyFiles';

/**
 * Keeping Oxy's record of the files CrowdSource uses exact (oxy ADR 0043 D4, D6).
 *
 * ## The worker
 *
 * Every `case_evidence_files` row is born `pending` in its report's transaction.
 * This worker claims due rows across every tenant under a lease, adds the
 * references Oxy is owed (`files:references:write`) and removes the ones a
 * deleted file no longer needs, and writes each outcome only while its claim
 * still holds and the row still asks for what was claimed. A failed call
 * leaves the row owed, retried with a capped backoff and never dropped: an
 * unregistered reference is a file Oxy may garbage-collect from under a jury.
 * The nightly reconciliation below is the safety net under it, not instead of it.
 *
 * A reference Oxy REFUSES (`not_found`: the file is another application's
 * private file, or no longer active) is final. The row becomes `refused`, the
 * file is withheld from the jury and the tenant's audit trail says why.
 *
 * ## The reconciliation
 *
 * Once a night, under a lease on `oxy_file_reconciliations` (every task runs
 * the timer), the whole inventory — every (file, case) whose reference is held
 * or owed — is sent to `references.reconcile`: Oxy adds what it is missing and
 * removes what it holds that the inventory does not list. `OXY_FILE_RECONCILIATION`
 * is `apply` (default), `dry_run` (counts only) or `off`.
 */

export const REFERENCE_BATCH_SIZE = 100;
export const REFERENCE_LEASE_MS = 2 * 60 * 1000;
export const REFERENCE_INTERVAL_MS = 5 * 1000;
const REFERENCE_RETRY_BASE_MS = 30 * 1000;
export const REFERENCE_RETRY_MAX_MS = 60 * 60 * 1000;
const REFERENCE_MAX_PASSES = 10;

export function referenceRetryDelayMs(attempts: number): number {
  return Math.min(REFERENCE_RETRY_MAX_MS, REFERENCE_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

/** A failure's class for the row and the log: an HTTP status or an error name, never a message. */
function errorClass(error: unknown): string {
  const status =
    (error as { status?: unknown })?.status ??
    (error as { response?: { status?: unknown } })?.response?.status;
  if (typeof status === 'number') return `http_${status}`;
  return error instanceof Error ? error.name : 'unknown';
}

function referenceOf(row: CaseEvidenceFileRow): ServiceFileReference {
  return { fileId: row.fileId, entityType: EVIDENCE_ENTITY_TYPE, entityId: row.caseId };
}

export interface ReferencePassSummary {
  readonly claimed: number;
  readonly registered: number;
  readonly refused: number;
  readonly removed: number;
  readonly retried: number;
}

/** The final state an answer from Oxy puts a claimed row in, or null when it gave none. */
function settledState(
  claimed: EvidenceReferenceState,
  result: ServiceFileReferenceResult['result'] | undefined,
): EvidenceReferenceState | null {
  if (claimed === 'pending') {
    if (result === 'created' || result === 'exists') return 'registered';
    if (result === 'not_found') return 'refused';
    return null;
  }
  if (result === 'removed' || result === 'not_found') return 'removed';
  return null;
}

async function settle(
  row: CaseEvidenceFileRow,
  claim: string,
  now: Date,
  outcome: { state: EvidenceReferenceState } | { error: string },
): Promise<void> {
  const claimedState = row.referenceState;
  await withTransaction(async (tx) => {
    const written = await finishEvidenceReference(tx, {
      caseId: row.caseId,
      fileId: row.fileId,
      claim,
      claimedState,
      now,
      outcome:
        'state' in outcome
          ? { kind: 'done', referenceState: outcome.state }
          : {
              kind: 'retry',
              error: outcome.error,
              dueAt: new Date(now.getTime() + referenceRetryDelayMs(row.referenceAttempts)),
            },
    });
    if (!written || !('state' in outcome)) return;

    // A refusal is the one outcome that changes what the jury is shown.
    const before = withheldReason(row);
    const after = withheldReason(written);
    if (before === null && after !== null) {
      await appendAuditEvent(
        createTenantContext(row.organizationId, row.applicationId),
        { action: 'evidence.withheld', caseId: row.caseId, subjectId: row.fileId, reason: after },
        tx,
      );
    }
  });
}

/** One pass: claim due rows, call Oxy once for the adds and once for the removals, settle each. */
export async function runEvidenceReferencePass(
  now: Date = new Date(),
): Promise<ReferencePassSummary> {
  const claim = randomUUID();
  const rows = await claimDueEvidenceReferences(getPostgresDatabase(), {
    claim,
    now,
    leaseUntil: new Date(now.getTime() + REFERENCE_LEASE_MS),
    limit: REFERENCE_BATCH_SIZE,
  });
  const summary = { claimed: rows.length, registered: 0, refused: 0, removed: 0, retried: 0 };
  if (rows.length === 0) return summary;

  const groups: Array<{
    rows: CaseEvidenceFileRow[];
    call: (references: ServiceFileReference[]) => Promise<ServiceFileReferenceResult[]>;
  }> = [
    {
      rows: rows.filter((row) => row.referenceState === 'pending'),
      call: (references) => oxyFilesClient().addReferences(references),
    },
    {
      rows: rows.filter((row) => row.referenceState === 'removal_pending'),
      call: (references) => oxyFilesClient().removeReferences(references),
    },
  ];

  for (const group of groups) {
    if (group.rows.length === 0) continue;
    let results: ServiceFileReferenceResult[];
    try {
      results = await group.call(group.rows.map(referenceOf));
    } catch (error: unknown) {
      const failure = errorClass(error);
      logger.error(
        { classification: 'evidence_reference_failed', failure, rows: group.rows.length },
        'Oxy file references could not be written; will retry',
      );
      for (const row of group.rows) await settle(row, claim, new Date(), { error: failure });
      summary.retried += group.rows.length;
      continue;
    }

    const byKey = new Map(results.map((result) => [`${result.fileId} ${result.entityId}`, result]));
    for (const row of group.rows) {
      const state = settledState(
        row.referenceState,
        byKey.get(`${row.fileId} ${row.caseId}`)?.result,
      );
      if (state === null) {
        await settle(row, claim, new Date(), { error: 'missing_result' });
        summary.retried += 1;
        continue;
      }
      await settle(row, claim, new Date(), { state });
      if (state === 'registered') summary.registered += 1;
      else if (state === 'refused') summary.refused += 1;
      else summary.removed += 1;
    }
  }

  if (summary.refused > 0) {
    logger.warn(
      { classification: 'evidence_reference_refused', refused: summary.refused },
      'Oxy refused references to evidence files; they are withheld from juries',
    );
  }
  return summary;
}

/** Passes until nothing is due, bounded. */
export async function drainEvidenceReferences(now?: Date): Promise<ReferencePassSummary> {
  const total = { claimed: 0, registered: 0, refused: 0, removed: 0, retried: 0 };
  for (let pass = 0; pass < REFERENCE_MAX_PASSES; pass += 1) {
    const summary = await runEvidenceReferencePass(now);
    total.claimed += summary.claimed;
    total.registered += summary.registered;
    total.refused += summary.refused;
    total.removed += summary.removed;
    total.retried += summary.retried;
    if (summary.claimed < REFERENCE_BATCH_SIZE) break;
  }
  return total;
}

let referenceTimer: NodeJS.Timeout | null = null;
let referenceRunning = false;

export function startEvidenceReferenceWorker(intervalMs = REFERENCE_INTERVAL_MS): void {
  if (referenceTimer) return;
  referenceTimer = setInterval(() => {
    if (referenceRunning) return;
    referenceRunning = true;
    void drainEvidenceReferences()
      .catch(() => {
        logger.error(
          { classification: 'evidence_reference_pass_failed' },
          'Evidence reference pass failed',
        );
      })
      .finally(() => {
        referenceRunning = false;
      });
  }, intervalMs);
  referenceTimer.unref?.();
}

export function stopEvidenceReferenceWorker(): void {
  if (referenceTimer) clearInterval(referenceTimer);
  referenceTimer = null;
}

// ── Reconciliation ──────────────────────────────────────────────────────────

/** How often each task asks whether the night's run is due. */
export const RECONCILIATION_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const RECONCILIATION_FIRST_CHECK_MS = 2 * 60 * 1000;
/** One run a night: a run finished within this window is not repeated. */
export const RECONCILIATION_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;
/** Longer than Oxy's own one-hour session deadline, which each page slides. */
export const RECONCILIATION_LEASE_MS = 2 * 60 * 60 * 1000;

export type ReconciliationOutcome =
  | { readonly ran: false }
  | {
      readonly ran: true;
      readonly dryRun: boolean;
      readonly counts?: Record<string, number>;
      readonly error?: string;
    };

/**
 * Reconciles CrowdSource's `case` references with the evidence table, if this
 * task wins the night's lease. A failure is recorded and retried at the next
 * check; the SDK releases Oxy's session before rethrowing.
 */
export async function reconcileEvidenceReferences(options: {
  dryRun: boolean;
  owner?: string;
  now?: Date;
}): Promise<ReconciliationOutcome> {
  const db = getPostgresDatabase();
  const owner = options.owner ?? randomUUID();
  const now = options.now ?? new Date();
  const claimed = await claimReconciliation(db, {
    entityType: EVIDENCE_ENTITY_TYPE,
    owner,
    now,
    leaseMs: RECONCILIATION_LEASE_MS,
    minIntervalMs: RECONCILIATION_MIN_INTERVAL_MS,
  });
  if (!claimed) return { ran: false };

  try {
    const result = await oxyFilesClient().reconcile(
      EVIDENCE_ENTITY_TYPE,
      referencedEvidenceInventory(db),
      { dryRun: options.dryRun },
    );
    const counts = {
      added: result.added,
      removed: result.removed,
      unchanged: result.unchanged,
      refused: result.refused,
    };
    await finishReconciliation(db, {
      entityType: EVIDENCE_ENTITY_TYPE,
      owner,
      now: new Date(),
      dryRun: options.dryRun,
      outcome: { counts },
    });
    logger.info(
      { classification: 'evidence_reconciliation', dryRun: options.dryRun, ...counts },
      'Reconciled Oxy file references',
    );
    return { ran: true, dryRun: options.dryRun, counts };
  } catch (error: unknown) {
    const failure = errorClass(error);
    await finishReconciliation(db, {
      entityType: EVIDENCE_ENTITY_TYPE,
      owner,
      now: new Date(),
      dryRun: options.dryRun,
      outcome: { error: failure },
    });
    logger.error(
      { classification: 'evidence_reconciliation_failed', failure },
      'Reconciling Oxy file references failed; the next check retries',
    );
    return { ran: true, dryRun: options.dryRun, error: failure };
  }
}

let reconciliationTimer: NodeJS.Timeout | null = null;
let reconciliationFirstCheck: NodeJS.Timeout | null = null;

export function startEvidenceReconciliation(
  intervalMs = RECONCILIATION_CHECK_INTERVAL_MS,
  mode: 'apply' | 'dry_run' | 'off' = config.oxy.fileReconciliation,
): void {
  if (reconciliationTimer || mode === 'off') return;
  const check = () => {
    void reconcileEvidenceReferences({ dryRun: mode === 'dry_run' }).catch(() => {
      logger.error(
        { classification: 'evidence_reconciliation_check_failed' },
        'Evidence reconciliation check failed',
      );
    });
  };
  reconciliationTimer = setInterval(check, intervalMs);
  reconciliationTimer.unref?.();
  reconciliationFirstCheck = setTimeout(check, Math.min(RECONCILIATION_FIRST_CHECK_MS, intervalMs));
  reconciliationFirstCheck.unref?.();
}

export function stopEvidenceReconciliation(): void {
  if (reconciliationTimer) clearInterval(reconciliationTimer);
  if (reconciliationFirstCheck) clearTimeout(reconciliationFirstCheck);
  reconciliationTimer = null;
  reconciliationFirstCheck = null;
}

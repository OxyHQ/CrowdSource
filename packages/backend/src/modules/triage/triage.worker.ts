import type { TaxonomyCode } from '@oxyhq/crowdsource-contracts';

import { createTenantContext } from '../../db/tenantScope';
import { withTransaction } from '../../db/transaction';
import { cases } from '../cases/case.collection';
import {
  appendOutboxEvent,
  OUTBOX_EVENT_TYPES,
  type OutboxEventDocument,
} from '../outbox/outbox.collection';
import { registerOutboxHandler } from '../outbox/outbox.dispatcher';
import { triageCase } from './triage';

/**
 * The triage worker: consumes `case.ready_for_triage`, writes the case's
 * priority and route, and publishes `case.ready_for_review` (§12.5, §15.3).
 *
 * Idempotent because it has to be. Every outbox consumer is at-least-once — a
 * lease can expire mid-handler and a process can die between the domain write
 * and the completion write — and here that costs nothing, because triage is a
 * pure function of case state: running it twice on the same case produces the
 * same numbers and the same route. What is NOT idempotent is publishing, so the
 * `case.ready_for_review` row is only written when triage actually moved the
 * case out of `received`, which the conditional update below decides atomically.
 *
 * Note where the tenant comes from: the outbox row, which was stamped by
 * `tenantScopedDocument` inside the transaction that created it. A worker has no
 * credential to derive one from, and the row is the only trustworthy source —
 * which is exactly why `appendOutboxEvent` refuses to write a row without one.
 */

/**
 * Statuses whose priority and route triage may still refresh.
 *
 * A case already under review or decided must not be dragged backwards by a late
 * report merging into it: §9.9 makes a published decision immutable, and a
 * re-triage that reset the lifecycle would invite a second jury on a case that
 * already has one. A merge into a case past this point still records the report
 * and still updates the counters — only the lifecycle stays put.
 */
const RETRIAGEABLE_STATUSES = ['triaged', 'escalated'] as const;

/**
 * Exported so it can be tested directly rather than through the dispatcher.
 *
 * The dispatcher is deliberately not tenant-scoped — it publishes across every
 * tenant — so driving this handler through it would couple a test to whatever
 * else is on the queue. The dispatcher's own behaviour has its own suite.
 */
export async function handleCaseReadyForTriage(event: OutboxEventDocument): Promise<void> {
  const caseId = event.payload.caseId;
  if (!caseId) {
    throw new Error(`Outbox event '${event.eventId}' carries no caseId to triage.`);
  }

  const context = createTenantContext(event.organizationId, event.applicationId);

  await withTransaction(async (session) => {
    const stored = await cases.findOne(context, { caseId });
    if (!stored) {
      // The row names a case this tenant does not own or that never committed.
      // Neither is retryable, and both are defects worth surfacing rather than
      // absorbing: the outbox row and the case commit together, so one without
      // the other means something wrote a row outside a transaction.
      throw new Error(`Outbox event '${event.eventId}' names case '${caseId}', which does not exist.`);
    }

    const result = triageCase({
      allegationCodes: stored.allegationCodes as TaxonomyCode[],
      reportCount: stored.reportCount,
      uniqueReporterCount: stored.reporterFingerprints.length,
      reach: stored.reach,
      activeDistribution: stored.activeDistribution,
      allowCommunityReview: stored.allowCommunityReview,
      containsPersonalData: stored.containsPersonalData,
      firstReportedAt: stored.firstReportedAt,
      now: new Date(),
    });

    const outputs = {
      priorityScore: result.priorityScore,
      sensitivityClass: result.sensitivityClass,
      reviewPool: result.reviewPool,
      requiresRedaction: result.requiresRedaction,
      escalated: result.escalate,
      updatedAt: new Date(),
    };

    /**
     * The transition out of `received` is what decides whether to publish, and
     * it is a conditional update rather than a read-then-write so a replayed
     * event and a concurrent one cannot both take it.
     *
     * §7.5's urgent paths leave the ordinary queue: `escalated` here is a case
     * STATE, not §9.6's decision outcome of the same name — that one is what a
     * jury concludes, and no jury has seen this case yet.
     */
    const transitioned = await cases.updateOne(
      context,
      { caseId, status: 'received' },
      {
        set: {
          ...outputs,
          status: result.escalate ? 'escalated' : 'triaged',
          triagedAt: new Date(),
        },
      },
      session,
    );

    if (transitioned === 0) {
      /**
       * Either a replay of this event or a re-triage after a later report
       * merged in. Refresh the numbers — a merge changes velocity and can
       * withdraw community review — and publish nothing: asking sortition to
       * assemble a second jury for a case that already has one is the
       * duplicate-jury failure the outbox design exists to make impossible.
       */
      await cases.updateOne(
        context,
        { caseId, status: { $in: RETRIAGEABLE_STATUSES } },
        { set: outputs },
        session,
      );
      return;
    }

    await appendOutboxEvent(context, session, {
      type: OUTBOX_EVENT_TYPES.caseReadyForReview,
      payload: { caseId },
    });
  });
}

/** Wires the worker to its event type. Called once, from `registerWorkers`. */
export function registerTriageWorker(): void {
  registerOutboxHandler(OUTBOX_EVENT_TYPES.caseReadyForTriage, handleCaseReadyForTriage);
}

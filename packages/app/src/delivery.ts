import type { Model } from 'mongoose';
import type { CrowdSourceClientProvider } from './client';
import { buildModerationReportInput, type SubjectRegistry } from './evidence';
import type {
  ModerationLogger,
  ModerationMetrics,
  ModerationOutboxEvent,
  ModerationReportFields,
  ModerationTaxonomy,
} from './types';

/**
 * Delivering a stored report to CrowdSource.
 *
 * Everything hard about this is already handled elsewhere and the shape of this
 * file is what is left over: the SDK owns the envelope, the idempotency key, the
 * timeouts, the per-attempt retries and the classification of failures; the
 * outbox owns durability, backoff and dead-lettering. What remains is to
 * describe the material, hand it over, and write down what came back.
 *
 * The failures are as important as the success:
 *
 * - **Nowhere to send it.** The integration is not configured. The event stays
 *   pending, untouched, and delivers when it is — a delay, never a loss.
 * - **The object is gone.** Deleted between the report and its delivery. There
 *   is nothing to review, so the report closes locally instead of retrying for
 *   days.
 * - **The type has no provider.** Unreachable by design — such a report never
 *   gets a delivery event — so an event that reaches it is a defect and is
 *   dead-lettered rather than retried or filed as a state.
 * - **Anything else** is the SDK's `retryable` to answer, and the outbox obeys
 *   it.
 */

/** Thrown when there is nowhere to deliver to yet. Always retryable. */
export class CrowdSourceUnavailableError extends Error {
  readonly retryable = true;

  constructor() {
    super('The CrowdSource integration is not configured in this deployment.');
    this.name = 'CrowdSourceUnavailableError';
  }
}

/**
 * A delivery event that cannot become deliverable.
 *
 * `retryable: false` is the field the outbox reads to dead-letter instead of
 * backing off — the same contract every error from `@oxyhq/crowdsource` answers.
 */
export class ModerationDeliveryRejectedError extends Error {
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'ModerationDeliveryRejectedError';
  }
}

export function createDeliveryWorker<TReport extends ModerationReportFields>(input: {
  reportModel: Model<TReport>;
  registry: SubjectRegistry;
  taxonomy: ModerationTaxonomy;
  client: CrowdSourceClientProvider;
  logger: ModerationLogger;
  metrics?: ModerationMetrics;
}): (event: ModerationOutboxEvent) => Promise<void> {
  const count = (result: string): void => {
    input.metrics?.incrementCounter('crowdsource_report_delivery_total', 1, { result });
  };

  /** Close a report there is genuinely nothing left to do about. */
  const closeUndeliverable = async (reportId: string, reason: string): Promise<void> => {
    await input.reportModel.updateOne(
      { _id: reportId },
      { $set: { localStatus: 'closed', localStatusReason: reason } },
    );
  };

  return async (event) => {
    const reportId = event.payload.reportId;
    if (reportId === undefined) {
      throw new ModerationDeliveryRejectedError(
        'A report.submit event carried no reportId.',
      );
    }

    const report = await input.reportModel.findById(reportId).lean<TReport | null>();
    if (!report) {
      /**
       * The report is gone but its delivery event survived. Nothing to deliver
       * and nothing to fix, so the event completes — retrying would keep looking
       * for a row that no longer exists.
       */
      input.logger.warn('[CrowdSource] delivery event has no report', { reportId });
      return;
    }

    const crowdsource = input.client.get();
    if (!crowdsource) throw new CrowdSourceUnavailableError();

    /**
     * A `ModerationSubjectUnsupportedError` from here is NOT caught. It carries
     * `retryable: false`, so the outbox dead-letters the event and the
     * reconciliation sweep counts it — which is the right channel for a defect
     * that needs a human. Catching it and writing a local state would put the
     * report somewhere nothing alerts on.
     */
    const described = await buildModerationReportInput({
      report: {
        id: reportId,
        reportedType: report.reportedType,
        reportedId: report.reportedId,
        reporter: report.reporter,
        categories: report.categories,
        ...(report.details === undefined ? {} : { details: report.details }),
        createdAt: report.createdAt,
      },
      registry: input.registry,
      taxonomy: input.taxonomy,
    });

    if (described === null) {
      await closeUndeliverable(
        reportId,
        'The reported content no longer exists, so there is nothing to review.',
      );
      count('content_unavailable');
      return;
    }

    let receipt: Awaited<ReturnType<typeof crowdsource.reports.create>>;
    try {
      receipt = await crowdsource.reports.create(described.reportInput);
    } catch (error: unknown) {
      /**
       * The failure is visible on the report itself, not only in the outbox row.
       * `delivery_failed` is what a reporter's receipt and the reconciliation
       * sweep both read; leaving the report at `queued` while the outbox quietly
       * backed off would hide the problem in a collection nobody looks at.
       * Written before rethrowing so the outbox still applies its own backoff or
       * dead-letters the event.
       */
      await input.reportModel.updateOne(
        { _id: reportId },
        {
          $set: {
            localStatus: 'delivery_failed',
            lastDeliveryError: (error instanceof Error
              ? error.message
              : String(error)
            ).slice(0, 2_000),
          },
        },
      );
      count('failed');
      throw error;
    }

    await input.reportModel.updateOne(
      { _id: reportId },
      {
        $set: {
          localStatus: 'submitted',
          crowdSourceReportId: receipt.reportId,
          crowdSourceCaseId: receipt.caseId,
          crowdSourceMerged: receipt.merged,
          contentSnapshotHash: described.snapshotHash,
          submittedAt: new Date(),
        },
        $unset: { lastDeliveryError: '', localStatusReason: '' },
      },
    );

    count(receipt.merged ? 'merged' : 'delivered');
    input.logger.info('[CrowdSource] report delivered', {
      reportId,
      caseId: receipt.caseId,
      merged: receipt.merged,
    });
  };
}

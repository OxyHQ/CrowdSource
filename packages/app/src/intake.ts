import type { SubjectRegistry } from './evidence.js';
import { reportSubmitEventId, type OutboxService } from './outbox/service.js';
import type {
  ModerationReportStore,
  ModerationTransactionRunner,
} from './store/types.js';
import type {
  CreateReportInput,
  CreateReportResult,
  ModerationReportFields,
} from './types.js';

/**
 * Storing a report and, when there is somewhere to send it, the promise to
 * deliver it — in one operation.
 *
 * This is the only thing in the integration that a user waits for. A 201 from an
 * application's report route means the report row and its outbox event committed
 * together. It does NOT mean CrowdSource accepted anything — CrowdSource may be
 * unreachable, mid-deploy or not yet configured, and the reporter is told their
 * report was received either way, because it was.
 *
 * The transaction is the whole mechanism. Two writes outside one would give two
 * failure modes that are both silent: a report with no delivery event (the
 * report exists, nothing will ever send it, and nobody finds out until somebody
 * asks why a case never opened) or a delivery event with no report (a delivery
 * worker looking up an id that was rolled back). Neither surfaces as an error at
 * the moment it happens, which is exactly why this has to be atomic rather than
 * carefully ordered.
 *
 * The one report with NO delivery event is the one whose type has no subject
 * provider, and that is a different claim entirely: not "delivery failed" but
 * "there was never a route out of this application for this kind of object".
 * Those two must not be conflated, which is why they are different `localStatus`
 * values and why the absent route is written down as a reason rather than
 * inferred from a missing row.
 */

export class DuplicateReportError<TReport> extends Error {
  readonly existing: TReport;

  constructor(existing: TReport) {
    super('This item has already been reported by this reporter.');
    this.name = 'DuplicateReportError';
    this.existing = existing;
  }
}

/**
 * Refuses an identifier that is not a string, before it reaches the store.
 *
 * The input type says these are strings, but a type is erased at runtime and a
 * truthiness check passes anything non-empty — including an object. What that
 * costs depends on the backend, and the difference is worth stating rather than
 * flattening: on Mongo a `{ $ne: null }` becomes a query OPERATOR, so the
 * duplicate lookup matches an UNRELATED report and answers "you already reported
 * this" about somebody else's row; on Postgres a bound parameter cannot become
 * an operator, so that particular failure class does not exist there.
 *
 * The guard is not Mongo's, though. A non-string still reaches the insert and
 * stores something that is not an id where an id belongs, on any backend — and
 * the check lives here rather than at an application's route because this
 * function is exported: a queue worker, a reconciliation script or a future
 * admin path is under no obligation to have passed a route's validation, and a
 * guard that only exists at one caller is a guard that holds until the second
 * one arrives.
 */
function requireIdentifier(value: unknown, field: string): string {
  /**
   * `trim()` and not `length === 0`, because `'   '` is not an identifier.
   *
   * A whitespace-only reporter or reported id is not a string somebody meant:
   * it comes from a form field, a trimmed-elsewhere value, or a client that
   * sends `' '` for absent. Stored, it is an id that matches nothing and reads
   * as present — the duplicate check finds no earlier report, the delivery
   * carries it as `externalReportId`, and nothing fails until a human asks why
   * a case names nobody.
   */
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`createReport: ${field} must be a non-empty string.`);
  }
  return value;
}

/**
 * Why a report is not going anywhere, in words an operator can read.
 *
 * Stored on the row rather than left to be inferred from a missing outbox event.
 * A missing row is also what a lost write looks like, and the two need to be
 * distinguishable months later without re-deriving which types had providers at
 * the time. Bounded by the schema's 300-character limit.
 */
function localOnlyReason(reportedType: string): string {
  return (
    `There is no moderation subject provider for '${reportedType}', so this report is ` +
    'recorded locally and is not sent for community review.'
  );
}

/**
 * Store the report, and queue its delivery in the same transaction.
 *
 * Delivery is queued when — and only when — the reported type has a subject
 * provider. A type without one is stored at `received` with the reason recorded,
 * which is the behaviour the application had before CrowdSource existed: the
 * report is a receipt and a local record, and nothing else ever happens to it.
 *
 * That branch is the reason the two writes stay in one transaction rather than
 * being ordered carefully. The condition is read BEFORE the transaction body
 * decides anything, so `localStatus` and the presence of an outbox row are
 * decided together from one fact — a report can never commit as `queued` with
 * nothing to deliver it, nor as `received` with a delivery event that will try
 * anyway.
 *
 * Intake deliberately does not read whether the integration is enabled. A report
 * taken while it is off still gets its delivery event, so turning the flag on
 * delivers the backlog instead of stranding it — the dispatcher is what is
 * gated, not the durable record. Nothing here is conditional on a third party's
 * state; only on whether this application knows how to describe the object at
 * all.
 */
export function createIntake<TReport extends ModerationReportFields, TTx>(input: {
  transaction: ModerationTransactionRunner<TTx>;
  reports: ModerationReportStore<TReport, TTx>;
  registry: SubjectRegistry;
  outbox: OutboxService<TTx>;
}): (report: CreateReportInput) => Promise<CreateReportResult<TReport>> {
  return async (report) => {
    const reporter = requireIdentifier(report.reporter, 'reporter');
    const reportedId = requireIdentifier(report.reportedId, 'reportedId');
    const reportedType = requireIdentifier(report.reportedType, 'reportedType');
    if (!Array.isArray(report.categories) || report.categories.length === 0) {
      throw new TypeError('createReport: categories must be a non-empty array.');
    }
    for (const category of report.categories) {
      requireIdentifier(category, 'categories[]');
    }
    const deliverable = input.registry.providerFor(reportedType) !== undefined;

    return await input.transaction.run(async (tx) => {
      const existing = await input.reports.findDuplicate(
        { reporter, reportedId, reportedType },
        tx,
      );
      if (existing) throw new DuplicateReportError(existing);

      const created = await input.reports.insert(
        {
          reportedType,
          reportedId,
          reporter,
          categories: [...report.categories],
          ...(report.details === undefined ? {} : { details: report.details }),
          localStatus: deliverable ? 'queued' : 'received',
          ...(deliverable ? {} : { localStatusReason: localOnlyReason(reportedType) }),
          ...(report.extra === undefined ? {} : { extra: report.extra }),
        },
        tx,
      );

      if (!deliverable) return { report: created };

      const outboxEventId = await input.outbox.enqueue(
        {
          eventId: reportSubmitEventId(created.id),
          kind: 'report.submit',
          payload: { reportId: created.id },
        },
        tx,
      );

      return { report: created, outboxEventId };
    });
  };
}

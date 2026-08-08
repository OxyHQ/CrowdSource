import { DecisionSchema, type Decision } from '@oxyhq/crowdsource-contracts';
import type { EnforcementExecutor } from './enforcement/executor.js';
import { primaryAction } from './enforcement/planner.js';
import { localStatusForDecision } from './reportStatus.js';
import type { ModerationReportStore } from './store/types.js';
import type {
  EnforcementOutcome,
  ModerationEnforcementConfig,
  ModerationLogger,
  ModerationOutboxEvent,
  ModerationReportFields,
  ReportDecisionExtraFields,
} from './types.js';

/**
 * Applying a decision that has already been received and recorded.
 *
 * The webhook answered 2xx long before this runs. What is left is the part that
 * touches several collections: write the decision onto every report that opened
 * or joined the case, and enforce it once.
 *
 * "Once" is the invariant that shapes this file. A hundred reports about the
 * same material produce ONE case and ONE consequence, so enforcement is keyed on
 * the decision and not on the reports — the executor is called a single time no
 * matter how many reports are updated, and its own unique index makes even that
 * call safe to repeat.
 */

/** A failure that will not be fixed by trying again. */
export class ModerationDecisionRejectedError extends Error {
  /** Read by the outbox: `false` dead-letters instead of retrying. */
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'ModerationDecisionRejectedError';
  }
}

/** A failure that a later attempt can still resolve. */
export class ModerationDecisionDeferredError extends Error {
  readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = 'ModerationDecisionDeferredError';
  }
}

export function createDecisionWorker<
  TReport extends ModerationReportFields,
  TAction extends string,
  TTx,
>(input: {
  reports: ModerationReportStore<TReport, TTx>;
  executor: EnforcementExecutor<TAction>;
  enforcement: ModerationEnforcementConfig<TAction>;
  logger: ModerationLogger;
  reportDecisionExtraFields?: (decision: Decision) => ReportDecisionExtraFields;
}): (event: ModerationOutboxEvent) => Promise<void> {
  /**
   * Write the decision onto one report.
   *
   * `decision.revision` is passed as the ceiling the store guards on, so it is
   * the DATABASE that refuses a stale write rather than a read-then-write in
   * this process. Deliveries can overlap — CrowdSource retries for 24 hours, and
   * a correction can arrive while the decision it supersedes is still being
   * applied — and an older revision landing last would otherwise overwrite the
   * current answer with a stale one.
   */
  const applyToReport = async (
    reportId: string,
    decision: Decision,
    enforced: { action: TAction; at: Date | null } | undefined,
  ): Promise<boolean> =>
    await input.reports.applyDecision(
      reportId,
      {
        localStatus: localStatusForDecision(decision.status),
        decisionId: decision.id,
        decisionRevision: decision.revision,
        decisionOutcome: decision.outcome,
        decisionStatus: decision.status,
        decidedAt: new Date(decision.publishedAt),
        /**
         * `enforcedAction` is what the application DECIDED to do; `enforcedAt`
         * is when an effect actually landed. They are written separately because
         * they are different claims, and conflating them puts a timestamp on
         * something that never happened — which is the normal case in `observe`
         * mode, and the permanent case for an application with no sanction
         * primitive. An audit row that says "enforced at 14:02" for an effect
         * nobody carried out is not explainable, and every effect being
         * explainable is the invariant.
         */
        ...(enforced === undefined
          ? {}
          : {
              enforcedAction: enforced.action,
              ...(enforced.at === null ? {} : { enforcedAt: enforced.at }),
            }),
        ...(input.reportDecisionExtraFields === undefined
          ? {}
          : { extra: input.reportDecisionExtraFields(decision) }),
      },
      decision.revision,
    );

  return async (event) => {
    const caseId = event.payload.caseId;
    if (caseId === undefined) {
      throw new ModerationDecisionRejectedError(
        'A decision.apply event carried no caseId.',
      );
    }

    /**
     * Parsed HERE rather than at the webhook.
     *
     * The receiver's job was to prove the bytes came from CrowdSource and to
     * record them; refusing an unrecognised shape at the door would put a real
     * decision back on a retry schedule until it expired. Parsing at the point
     * of use means an event this deployment cannot yet read waits in the outbox
     * until it can.
     */
    const parsed = DecisionSchema.safeParse(event.payload.decision);
    if (!parsed.success) {
      throw new ModerationDecisionRejectedError(
        `The decision for case ${caseId} does not match the published contract: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    const decision = parsed.data;

    const reports = await input.reports.findByCaseId(caseId);

    if (reports.length === 0) {
      /**
       * Retryable, and the race is real rather than theoretical: CrowdSource can
       * decide a case and deliver the webhook while the response that carried
       * the case id back to this deployment is still being written, or while a
       * delivery is being retried. Backing off is correct; dead-lettering would
       * throw the decision away.
       */
      throw new ModerationDecisionDeferredError(
        `No local report is linked to case ${caseId} yet.`,
      );
    }

    /**
     * One subject per case. The dedup key includes the subject's external id, so
     * every report merged into a case is about the same object — the first
     * report names it.
     */
    const [first] = reports;
    const outcomes = await input.executor.apply({
      decision,
      caseId,
      subject: { type: first.reportedType, id: first.reportedId },
    });

    /**
     * The EFFECTIVE action, not the planned one. `apply` is the only place that
     * knows a planned action could not apply to this particular object, and
     * `recordedAs` is how it says so — see `EnforcementEffect`.
     */
    const effectiveAction = (outcome: EnforcementOutcome<TAction>): TAction =>
      outcome.recordedAs ?? outcome.action;

    const enforcedAction = primaryAction(
      outcomes.map(effectiveAction),
      input.enforcement.precedence ?? input.enforcement.actions,
    );
    /**
     * The timestamp belongs to the outcome of THIS action, not to the plan. An
     * action that was claimed and recorded — observe mode, a mode that does not
     * apply it, or an application with nothing to apply — leaves `enforcedAt`
     * unset while `enforcedAction` still says what was decided.
     */
    const enforced =
      enforcedAction === undefined
        ? undefined
        : {
            action: enforcedAction,
            at: outcomes.some(
              (outcome) =>
                effectiveAction(outcome) === enforcedAction &&
                outcome.result === 'applied',
            )
              ? new Date()
              : null,
          };

    let updated = 0;
    for (const report of reports) {
      if (await applyToReport(report.id, decision, enforced)) updated += 1;
    }

    input.logger.info('[CrowdSource] decision applied', {
      caseId,
      decisionId: decision.id,
      revision: decision.revision,
      outcome: decision.outcome,
      reportsMatched: reports.length,
      reportsUpdated: updated,
      actions: outcomes.map((outcome) => `${outcome.action}:${outcome.result}`).join(','),
    });
  };
}

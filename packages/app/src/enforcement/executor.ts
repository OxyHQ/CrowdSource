import type { Model } from 'mongoose';
import type { Decision } from '@oxyhq/crowdsource-contracts';
import type { ModerationEnforcementDocument } from '../models';
import { planEnforcement } from './planner';
import type {
  EnforcementEffect,
  EnforcementOutcome,
  EnforcementPreviousState,
  EnforcementSubject,
  ModerationEnforcementConfig,
  ModerationEnforcementMode,
  ModerationLogger,
  ModerationMetrics,
  PlannedEnforcementAction,
} from '../types';

/**
 * Carrying out a decision, exactly once.
 *
 * Two guarantees, and everything here exists for one of them.
 *
 * **Once.** The idempotency key is `decisionId + revision + action`, and the
 * unique index on the enforcement collection is that key. Each action CLAIMS its
 * row before doing anything; a second attempt — a redelivered webhook, a
 * reclaimed outbox lease, a manual replay — loses the insert and does nothing.
 * Reading "have I done this?" and then acting would leave the gap between the
 * two, which is exactly when a redelivery arrives.
 *
 * **Reversibly.** Every action that changes state records what the state WAS,
 * and a reversal puts that back. So a correction does not lift a content warning
 * the author set themselves, and a restore returns an object to the state it
 * actually had rather than to a guess at one.
 *
 * `observe` mode runs all of this except the effect. That is deliberate: the
 * plan, the claim and the record are identical to production, so what the mode
 * proves is exactly what will happen when it is switched off — and the audit
 * trail is real rather than a log line saying a decision was seen.
 *
 * The application supplies the tables and one `apply`. Everything above is this
 * package's and is not configurable, because it is the invariant rather than the
 * policy.
 */

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    Number((error as { code?: unknown }).code) === 11000
  );
}

/**
 * Whether the current mode allows this action to actually happen.
 *
 * `observe` allows nothing — that is the mode. `manual` allows what the
 * application declared reversible: those actions give something BACK, and
 * holding them behind a human review means a wrongly-removed object stays
 * removed while somebody reads a queue. Taking content down still waits for a
 * person. `automatic` allows the mapped set.
 */
function modeAllows<TAction extends string>(
  mode: ModerationEnforcementMode,
  action: TAction,
  config: ModerationEnforcementConfig<TAction>,
): boolean {
  switch (mode) {
    case 'observe':
      return false;
    case 'manual':
      return (config.reversibleActions ?? []).includes(action);
    case 'automatic':
      return true;
  }
}

export interface EnforcementExecutor<TAction extends string> {
  /**
   * Plan and carry out everything this decision revision asks for.
   *
   * Returns one outcome per planned action, in plan order, so a caller can
   * record what happened without asking a second time.
   */
  apply(input: {
    decision: Decision;
    caseId: string;
    subject: EnforcementSubject;
    /** Defaults to the configured mode. Explicit in tests. */
    mode?: ModerationEnforcementMode;
  }): Promise<EnforcementOutcome<TAction>[]>;
}

export function createEnforcementExecutor<TAction extends string>(input: {
  model: Model<ModerationEnforcementDocument>;
  config: ModerationEnforcementConfig<TAction>;
  defaultMode: ModerationEnforcementMode;
  logger: ModerationLogger;
  metrics?: ModerationMetrics;
}): EnforcementExecutor<TAction> {
  const { model, config, logger } = input;

  const count = (
    action: TAction,
    mode: ModerationEnforcementMode,
    result: string,
  ): void => {
    input.metrics?.incrementCounter('crowdsource_enforcement_total', 1, {
      action,
      mode,
      result,
    });
  };

  /**
   * What the earlier action this one reverses left behind.
   *
   * Read from the most recent APPLIED row, so an action that was recorded but
   * never carried out cannot be mistaken for one that changed something. This is
   * the mechanism behind "only lift what moderation set": an absent row means
   * the state was not moderation's doing, and the application's `apply` decides
   * what to do with that.
   */
  const previousStateFor = async (
    action: TAction,
    subject: EnforcementSubject,
  ): Promise<
    { previousState?: EnforcementPreviousState; previousAction: TAction } | undefined
  > => {
    const reversed: TAction | readonly TAction[] | undefined = config.reverses?.[action];
    if (reversed === undefined) return undefined;
    /**
     * One action may reverse several. The most recent APPLIED row across the
     * whole set wins, so `apply` receives what actually happened last rather
     * than what a single declared action happened to be.
     */
    const candidates: readonly TAction[] =
      typeof reversed === 'string' ? [reversed] : reversed;
    if (candidates.length === 0) return undefined;
    const row = await model
      .findOne({
        subjectType: subject.type,
        subjectId: subject.id,
        action: { $in: [...candidates] },
        applied: true,
      })
      .sort({ createdAt: -1 })
      .select('previousState action')
      .lean<Pick<ModerationEnforcementDocument, 'previousState' | 'action'> | null>();
    if (row === null) return undefined;
    /**
     * The row's own action, narrowed THROUGH the declared set rather than cast.
     * The query guarantees membership; finding it here is what lets
     * `previousAction` be a `TAction` without asserting that it is one.
     */
    const previousAction = candidates.find((candidate) => candidate === row.action);
    if (previousAction === undefined) return undefined;
    return {
      ...(row.previousState === undefined ? {} : { previousState: row.previousState }),
      previousAction,
    };
  };

  const applyOne = async (
    planned: PlannedEnforcementAction<TAction>,
    context: { decision: Decision; caseId: string; subject: EnforcementSubject },
    mode: ModerationEnforcementMode,
  ): Promise<EnforcementOutcome<TAction>> => {
    const { decision, caseId, subject } = context;

    /**
     * The claim. The unique index refuses a second row for this
     * `decisionId + revision + action`, so losing this insert is the answer
     * "another delivery already handled it" and not an error.
     */
    let recordId: unknown;
    try {
      const [record] = await model.create([
        {
          decisionId: decision.id,
          decisionRevision: decision.revision,
          action: planned.action,
          caseId,
          subjectType: subject.type,
          subjectId: subject.id,
          outcome: decision.outcome,
          ...(planned.recommendedAction === undefined
            ? {}
            : { recommendedAction: planned.recommendedAction }),
          reason: planned.reason.slice(0, 500),
          mode,
          applied: false,
        },
      ]);
      recordId = record._id;
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) {
        count(planned.action, mode, 'duplicate');
        return { action: planned.action, result: 'duplicate' };
      }
      throw error;
    }

    if (!modeAllows(mode, planned.action, config)) {
      await model.updateOne(
        { _id: recordId },
        {
          $set: {
            skippedReason:
              mode === 'observe'
                ? 'observe mode: recorded, not applied'
                : `${mode} mode does not apply '${planned.action}' automatically`,
          },
        },
      );
      count(planned.action, mode, 'recorded');
      return { action: planned.action, result: 'recorded' };
    }

    try {
      const reversal = await previousStateFor(planned.action, subject);
      /**
       * An application with no sanction primitive supplies no `apply`, and every
       * planned action is recorded with the reason rather than silently
       * dropped. The plan, the claim and the audit row stay real, so "CrowdSource
       * decided this and this application has no way to carry it out" is written
       * down — which is the record that would justify building the primitive.
       */
      const noPrimitive: EnforcementEffect<TAction> = {
        changed: false,
        reason: 'This application has no enforcement primitive for any action',
      };
      const effect: EnforcementEffect<TAction> = await (config.apply?.({
        action: planned.action,
        subject,
        ...(reversal ?? {}),
        decision,
      }) ?? Promise.resolve(noPrimitive));

      if (!effect.changed) {
        /**
         * `recordedAs` corrects the LABEL, never the claim. The row keeps the
         * planned action because that is half the idempotency key and is what
         * was decided; the effective label rides alongside it and is what
         * reaches the report.
         */
        await model.updateOne(
          { _id: recordId },
          {
            $set: {
              skippedReason: effect.reason.slice(0, 300),
              ...(effect.recordedAs === undefined
                ? {}
                : { recordedAs: effect.recordedAs }),
            },
          },
        );
        count(planned.action, mode, 'recorded');
        return {
          action: planned.action,
          result: 'recorded',
          ...(effect.recordedAs === undefined ? {} : { recordedAs: effect.recordedAs }),
        };
      }

      await model.updateOne(
        { _id: recordId },
        {
          $set: {
            applied: true,
            appliedAt: new Date(),
            ...(effect.previousState === undefined
              ? {}
              : { previousState: effect.previousState }),
          },
        },
      );
      count(planned.action, mode, 'applied');
      return { action: planned.action, result: 'applied' };
    } catch (error: unknown) {
      /**
       * The claim goes back so a retry can try again. Keeping it would make a
       * transient failure permanent: the action would be deduplicated away
       * forever and the decision would silently never be carried out.
       */
      await model.deleteOne({ _id: recordId });
      logger.error('[CrowdSource] enforcement effect failed, claim released', {
        decisionId: decision.id,
        revision: decision.revision,
        action: planned.action,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  return {
    async apply(applyInput) {
      const mode = applyInput.mode ?? input.defaultMode;
      const plan = planEnforcement(applyInput.decision, config);
      const outcomes: EnforcementOutcome<TAction>[] = [];
      for (const planned of plan) {
        outcomes.push(
          await applyOne(
            planned,
            {
              decision: applyInput.decision,
              caseId: applyInput.caseId,
              subject: applyInput.subject,
            },
            mode,
          ),
        );
      }
      return outcomes;
    },
  };
}

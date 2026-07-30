import type { Decision, RecommendedAction, Severity } from '@oxyhq/crowdsource-contracts';
import type { ModerationEnforcementConfig, PlannedEnforcementAction } from '../types';

/**
 * Deciding what an application will do about a decision — and nothing else.
 *
 * Pure: no database, no clock, no configuration. A decision in, a plan out. That
 * is what makes the mapping testable as a table rather than as an integration
 * scenario, and it is why `observe` mode is a real audit rather than a comment —
 * the plan is computed identically in every mode and only its EXECUTION is
 * gated.
 *
 * ## The application maps recommendations, not findings
 *
 * `decision.recommendedActions` is what this reads, falling back to severity
 * only when a violation arrives with no recommendation at all.
 *
 * The reason is a division of labour: the jury classified the material and the
 * consensus engine turned that into a recommendation under a versioned policy.
 * An application that re-derived its action from raw severity would be quietly
 * re-deciding the case with a second, unversioned policy of its own — and the
 * two would diverge the first time CrowdSource's policy was updated. The
 * fallback exists because a `violation` the application did nothing about would
 * be worse than a mapped one.
 *
 * ## Why this ALGORITHM is shared and only the TABLES are per-application
 *
 * Every application has different actions, so the tables have to be its own. The
 * algorithm must not be, because it carries a correctness property that is
 * invisible by construction — see {@link withRestoreForNoViolation}. An
 * application writing its own planner is a chance to ship that bug silently, and
 * no test written against the application's own mapping would catch it.
 */

const SEVERITY_ORDER: readonly Severity[] = ['low', 'medium', 'high', 'critical'];

/**
 * Recommendations that ask for NO effect.
 *
 * An unmapped recommendation goes to `reviewAction`, because a recommendation
 * this application has no action for is a decision a human should see. These
 * three are the exception, and the distinction is not cosmetic: they are
 * CrowdSource saying "take no action", so routing them to review would put a
 * human in front of every cleared case and bury the ones that need looking at.
 *
 * An application's own table still wins — it may genuinely want `allow` to mean
 * something — but the default for an application that maps nothing has to be
 * "do nothing" rather than "wake somebody".
 */
const NO_EFFECT_RECOMMENDATIONS: ReadonlySet<string> = new Set([
  'allow',
  'no_action',
  'no_global_effect',
]);

function actionForRecommendation<TAction extends string>(
  recommended: RecommendedAction,
  config: ModerationEnforcementConfig<TAction>,
): TAction {
  const mapped = config.recommendationToAction?.[recommended];
  if (mapped !== undefined) return mapped;
  return NO_EFFECT_RECOMMENDATIONS.has(recommended)
    ? config.noneAction
    : config.reviewAction;
}

function highestSeverity(decision: Decision): Severity | undefined {
  let highest: Severity | undefined;
  for (const finding of decision.findings) {
    if (
      highest === undefined ||
      SEVERITY_ORDER.indexOf(finding.severity) > SEVERITY_ORDER.indexOf(highest)
    ) {
      highest = finding.severity;
    }
  }
  return highest;
}

/**
 * `no_violation` always carries a restore, whatever it recommended.
 *
 * This exists because of a failure that is very easy to ship and very hard to
 * see. A correction is a new revision whose outcome is `no_violation`, and its
 * recommendation is frequently `no_action` — which is CrowdSource saying "take
 * no NEW action", not "leave what you already did in place". Mapping that
 * straight through plans nothing, and the object an earlier revision removed
 * stays removed forever: the appeal succeeded, the case says the content was
 * fine, and nothing in the application ever puts it back. No error, no log line,
 * no failing test anywhere else.
 *
 * `allow`, `restore` and `no_action` are listed together as an application's
 * options for `no_violation` precisely because choosing between them needs
 * knowledge only the application has — whether it did something earlier. So the
 * plan always includes the restore, and the executor records "there was nothing
 * restricted" when that is the case, which is evidence rather than a silent
 * no-op.
 */
function withRestoreForNoViolation<TAction extends string>(
  decision: Decision,
  planned: readonly PlannedEnforcementAction<TAction>[],
  restoreAction: TAction | null,
): readonly PlannedEnforcementAction<TAction>[] {
  /**
   * `null` is a decision the application made, not an omission — the type
   * requires it to be written down. An application with no sanction primitive
   * has nothing an earlier revision could have removed, so there is nothing for
   * a correction to put back.
   */
  if (restoreAction === null) return planned;
  if (decision.outcome !== 'no_violation') return planned;
  if (planned.some((entry) => entry.action === restoreAction)) return planned;
  return [
    ...planned,
    { action: restoreAction, reason: 'No violation: undo any earlier restriction' },
  ];
}

/**
 * Collapse a plan to the actions that can coexist.
 *
 * A decision may recommend both removal and a label; a removed object does not
 * need one, and recording both would claim two effects where one happened. So an
 * action absorbs whatever the application declared it absorbs, and the explicit
 * "nothing" never survives alongside anything else.
 *
 * `reviewAction` always survives — it is a note for a human, and dropping it
 * because something else was also done is how a `suspend_user` recommendation
 * gets lost.
 */
function collapse<TAction extends string>(
  actions: readonly PlannedEnforcementAction<TAction>[],
  config: ModerationEnforcementConfig<TAction>,
): PlannedEnforcementAction<TAction>[] {
  const byAction = new Map<TAction, PlannedEnforcementAction<TAction>>();
  for (const planned of actions) {
    if (!byAction.has(planned.action)) byAction.set(planned.action, planned);
  }

  for (const [action, absorbed] of Object.entries(config.absorb ?? {}) as [
    TAction,
    readonly TAction[] | undefined,
  ][]) {
    if (!byAction.has(action)) continue;
    for (const loser of absorbed ?? []) {
      if (loser === config.reviewAction) continue;
      byAction.delete(loser);
    }
  }

  if (byAction.size > 1) byAction.delete(config.noneAction);

  return Array.from(byAction.values());
}

/**
 * What the application will do about this decision.
 *
 * Never empty: a decision that produces no action produces an explicit
 * `noneAction`, because a row saying "we decided to do nothing, and why" is
 * evidence and an absent row is a question.
 */
export function planEnforcement<TAction extends string>(
  decision: Decision,
  config: ModerationEnforcementConfig<TAction>,
): PlannedEnforcementAction<TAction>[] {
  const fromRecommendations = decision.recommendedActions.map(
    (recommended): PlannedEnforcementAction<TAction> => ({
      action: actionForRecommendation(recommended.action, config),
      reason: `CrowdSource recommended ${recommended.action}`,
      recommendedAction: recommended.action,
    }),
  );

  if (fromRecommendations.length > 0) {
    const collapsed = collapse(
      withRestoreForNoViolation(decision, fromRecommendations, config.restoreAction),
      config,
    );
    return collapsed.length > 0
      ? collapsed
      : [
          {
            action: config.noneAction,
            reason: 'No recommended action maps to an effect this application has',
          },
        ];
  }

  switch (decision.outcome) {
    case 'violation': {
      const severity = highestSeverity(decision);
      /**
       * A `violation` with no findings cannot happen — the contract refuses it —
       * so an absent severity here means a newer CrowdSource sent something this
       * code has not seen. A human looks at it rather than a default removing an
       * object.
       */
      if (severity === undefined) {
        return [
          {
            action: config.reviewAction,
            reason: 'Violation carried no finding severity this version understands',
          },
        ];
      }
      return [
        {
          action: config.severityFallback?.[severity] ?? config.reviewAction,
          reason: `Violation with no recommended action, highest severity ${severity}`,
        },
      ];
    }

    case 'no_violation':
      /**
       * A restore, always planned — even when nothing was restricted. The
       * executor records it as not applied with the reason, which is how "we
       * checked and there was nothing to undo" is distinguishable from "we never
       * looked".
       */
      return config.restoreAction === null
        ? [
            {
              action: config.noneAction,
              reason: 'No violation, and this application has nothing to restore',
            },
          ]
        : [
            {
              action: config.restoreAction,
              reason: 'No violation: undo any earlier restriction',
            },
          ];

    case 'insufficient_context':
    case 'inconclusive':
    case 'escalated':
      /**
       * None of these is "remove", and none is "it was fine": absence of
       * consensus is neither guilt nor innocence, so the application changes
       * nothing on its own and asks a human.
       */
      return [
        {
          action: config.reviewAction,
          reason: `Outcome ${decision.outcome}: no automatic action, internal review`,
        },
      ];

    case 'content_unavailable':
    case 'duplicate':
      return [
        {
          action: config.noneAction,
          reason: `Outcome ${decision.outcome}: nothing to enforce`,
        },
      ];

    default:
      /**
       * An outcome the contract does not currently define. A newer server must
       * not break an older client, and the safe reading of an unknown outcome is
       * a human, never a default effect.
       */
      return [
        {
          action: config.reviewAction,
          reason: 'Decision outcome not recognised by this version of the application',
        },
      ];
  }
}

/**
 * The one action worth recording on the report.
 *
 * One field, several planned actions, so it has to be the one that answers "what
 * happened to this object". The application's `precedence` decides, strongest
 * first — and `reviewAction` should sit near the end but ABOVE `noneAction`,
 * because a reporter told "nothing happened" when a human is about to look is
 * being told something untrue.
 */
export function primaryAction<TAction extends string>(
  actions: readonly TAction[],
  precedence: readonly TAction[],
): TAction | undefined {
  for (const candidate of precedence) {
    if (actions.includes(candidate)) return candidate;
  }
  return actions[0];
}

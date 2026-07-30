/**
 * Step 2 of the review form — evaluate the described material against a policy.
 *
 * Everything on this screen starts empty. `createInitialReviewFormState()` takes
 * no arguments, so nothing here can be pre-filled from the allegation, and the
 * allegation itself is rendered as what it is: an unverified claim by someone
 * whose identity, reputation and report count the reviewer does not get to see
 * (PLAN §9.1).
 *
 * The findings a reviewer may record come from the policy brief the SERVER sent
 * with the assignment — the applicable policy at its stated version — never from
 * the category the reporter picked.
 */

import { Checkbox } from '@oxyhq/bloom/checkbox';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxyhq/bloom/segmented-control';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Text, TextInput, View } from 'react-native';

import { ChoiceRow } from '@/components/ChoiceRow';
import { Panel } from '@/components/Screen';
import {
  CERTAINTY_LEVELS,
  FINDING_CONFIDENCE,
  FINDING_EXCEPTIONS,
  FINDING_SEVERITIES,
  REVIEW_OUTCOMES,
  REVIEWER_RECOMMENDED_ACTIONS,
  type ReviewFormAction,
  type ReviewFormState,
} from '@/lib/review-form';
import type {
  AssignmentPackage,
  ContextSufficiency,
} from '@oxyhq/crowdsource-contracts';

const CONTEXT_SUFFICIENCY: readonly ContextSufficiency[] = ['sufficient', 'insufficient'];

interface PolicyStepProps {
  state: ReviewFormState;
  dispatch: (action: ReviewFormAction) => void;
  policy: AssignmentPackage['policy'];
  allegations: AssignmentPackage['allegations'];
}

export function PolicyStep({ state, dispatch, policy, allegations }: PolicyStepProps) {
  const { t } = useTranslation();

  return (
    <View className="gap-4">
      <Panel
        title={t('review.step2.allegation.title')}
        description={t('review.step2.allegation.help')}
      >
        {/* Plural, and labelled from `unverified` rather than from a comment: a
            case is the union of every report about the same material (§7.3), and
            reporters do not all choose the same code. There is no reporter
            statement — §9.1 keeps the reporter's own words, identity and count off
            this screen entirely. */}
        {allegations.unverified ? (
          <Text className="text-sm font-semibold text-muted-foreground">
            {t('review.step2.allegation.unverified')}
          </Text>
        ) : null}
        {allegations.codes.map((code) => (
          <Text key={code} className="text-base text-foreground">
            {t(`taxonomy.${code}`, { defaultValue: code })}
          </Text>
        ))}
      </Panel>

      <Panel
        title={t('review.step2.policy.title')}
        description={t('review.step2.policy.version', {
          policySet: policy.policySetId,
          version: policy.version,
        })}
      >
        {/* §9.1 also asks for "ejemplos", and the published policy contract has no
            field for them: `PolicySetVersion` carries rules and nothing else. The
            rules ARE given in full, with the severities and actions each suggests
            (§9.2 step two) — inventing an examples field the policy registry
            cannot fill would show a reviewer text nobody authored. */}
        {policy.rules.map((rule) => (
          <View key={rule.id} className="gap-1">
            <Text className="text-sm font-semibold text-foreground">{rule.title}</Text>
            {rule.description === undefined ? null : (
              <Text className="text-sm leading-5 text-muted-foreground">{rule.description}</Text>
            )}
          </View>
        ))}
      </Panel>

      <Panel title={t('review.step2.outcome.title')} description={t('review.step2.outcome.help')}>
        <View className="gap-1">
          {REVIEW_OUTCOMES.map((outcome) => (
            <ChoiceRow
              key={outcome}
              label={t(`outcome.${outcome}`)}
              description={t(`outcome.${outcome}.help`)}
              selected={state.outcome === outcome}
              onSelect={() => dispatch({ type: 'setOutcome', outcome })}
            />
          ))}
        </View>
      </Panel>

      <Panel title={t('review.step2.context.title')}>
        <View className="gap-1">
          {CONTEXT_SUFFICIENCY.map((sufficiency) => (
            <ChoiceRow
              key={sufficiency}
              label={t(`contextSufficiency.${sufficiency}`)}
              selected={state.contextSufficiency === sufficiency}
              onSelect={() => dispatch({ type: 'setContextSufficiency', sufficiency })}
            />
          ))}
        </View>
      </Panel>

      <Panel title={t('review.step2.findings.title')} description={t('review.step2.findings.help')}>
        {policy.rules.map((rule) => {
          const finding = state.findings.find((candidate) => candidate.ruleId === rule.id);
          return (
            <View key={rule.id} className="gap-2">
              <Checkbox
                checked={finding !== undefined}
                onCheckedChange={() => dispatch({ type: 'toggleFinding', ruleId: rule.id })}
                label={rule.title}
                description={t('review.step2.findings.code', {
                  code: rule.taxonomyCodes.join(t('history.familySeparator')),
                })}
              />
              {finding ? (
                <View className="gap-3 pl-8">
                  <SegmentedControl
                    label={t('review.step2.findings.severity')}
                    type="radio"
                    size="small"
                    value={finding.severity}
                    onChange={(severity) =>
                      dispatch({ type: 'setFindingSeverity', ruleId: rule.id, severity })
                    }
                  >
                    {FINDING_SEVERITIES.map((severity) => (
                      <SegmentedControlItem key={severity} value={severity}>
                        <SegmentedControlItemText>
                          {t(`severity.${severity}`)}
                        </SegmentedControlItemText>
                      </SegmentedControlItem>
                    ))}
                  </SegmentedControl>
                  <SegmentedControl
                    label={t('review.step2.findings.confidence')}
                    type="radio"
                    size="small"
                    value={finding.confidence}
                    onChange={(confidence) =>
                      dispatch({ type: 'setFindingConfidence', ruleId: rule.id, confidence })
                    }
                  >
                    {CERTAINTY_LEVELS.map((level) => (
                      <SegmentedControlItem key={level} value={level}>
                        <SegmentedControlItemText>
                          {t('review.step2.findings.confidenceOption', {
                            label: t(`certainty.${level}`),
                            value: FINDING_CONFIDENCE[level].toFixed(2),
                          })}
                        </SegmentedControlItemText>
                      </SegmentedControlItem>
                    ))}
                  </SegmentedControl>
                  {/* §6.2 puts the exception BESIDE the code and severity, not in
                      a form-level list: "artistic nudity" is a different
                      description of the material rather than a different verdict
                      about it, and one review can find one thing documentary and
                      another not. The vocabulary is closed because §9.4 measures
                      consensus on it — two reviewers who answer `no_violation` for
                      incompatible reasons have not agreed. */}
                  <View className="gap-1">
                    <Text className="text-xs uppercase tracking-wide text-muted-foreground">
                      {t('review.step2.findings.exception')}
                    </Text>
                    <ChoiceRow
                      label={t('review.step2.findings.noException')}
                      selected={finding.exception === null}
                      onSelect={() =>
                        dispatch({ type: 'setFindingException', ruleId: rule.id, exception: null })
                      }
                    />
                    {FINDING_EXCEPTIONS.map((exception) => (
                      <ChoiceRow
                        key={exception}
                        label={t(`findingContext.${exception}`)}
                        selected={finding.exception === exception}
                        onSelect={() =>
                          dispatch({ type: 'setFindingException', ruleId: rule.id, exception })
                        }
                      />
                    ))}
                  </View>
                </View>
              ) : null}
            </View>
          );
        })}
      </Panel>

      <Panel title={t('review.step2.actions.title')} description={t('review.step2.actions.help')}>
        <View className="gap-1">
          {REVIEWER_RECOMMENDED_ACTIONS.map((action) => (
            <Checkbox
              key={action}
              checked={state.recommendedActions.includes(action)}
              onCheckedChange={() => dispatch({ type: 'toggleAction', action })}
              label={t(`action.${action}`)}
            />
          ))}
        </View>
      </Panel>

      <Panel title={t('review.step2.notes.title')} description={t('review.step2.notes.help')}>
        <TextInput
          className="min-h-[96px] rounded-md border border-border bg-background p-3 text-base text-foreground"
          multiline
          value={state.notes}
          onChangeText={(notes) => dispatch({ type: 'setNotes', notes })}
          placeholder={t('review.step2.notes.placeholder')}
          accessibilityLabel={t('review.step2.notes.title')}
        />
      </Panel>
    </View>
  );
}

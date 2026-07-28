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
  FINDING_SEVERITIES,
  RECOMMENDED_ACTIONS,
  REVIEW_OUTCOMES,
  type ReviewFormAction,
  type ReviewFormState,
} from '@/lib/review-form';
import type { Allegation, ContextSufficiency, PolicyBrief } from '@/lib/reviewer-api/types';

const CONTEXT_SUFFICIENCY: readonly ContextSufficiency[] = ['sufficient', 'insufficient'];

interface PolicyStepProps {
  state: ReviewFormState;
  dispatch: (action: ReviewFormAction) => void;
  policy: PolicyBrief;
  allegation: Allegation;
}

export function PolicyStep({ state, dispatch, policy, allegation }: PolicyStepProps) {
  const { t } = useTranslation();

  return (
    <View className="gap-4">
      <Panel
        title={t('review.step2.allegation.title')}
        description={t('review.step2.allegation.help')}
      >
        <Text className="text-base text-foreground">
          {t(`taxonomy.${allegation.code}`, { defaultValue: allegation.code })}
        </Text>
        {allegation.statement ? (
          <Text className="text-sm leading-5 text-muted-foreground" selectable={false}>
            {allegation.statement}
          </Text>
        ) : null}
      </Panel>

      <Panel
        title={t('review.step2.policy.title')}
        description={t('review.step2.policy.version', {
          policySet: policy.policySetId,
          version: policy.policyVersion,
        })}
      >
        {policy.rules.map((rule) => (
          <View key={rule.id} className="gap-1">
            <Text className="text-sm font-semibold text-foreground">{rule.title}</Text>
            <Text className="text-sm leading-5 text-muted-foreground">{rule.text}</Text>
          </View>
        ))}
        {policy.examples.length > 0 ? (
          <View className="gap-2 rounded-md bg-muted p-3">
            <Text className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('review.step2.policy.examples')}
            </Text>
            {policy.examples.map((example) => (
              <Text key={example.id} className="text-sm leading-5 text-foreground">
                {example.violating
                  ? t('review.step2.policy.exampleViolating', { text: example.text })
                  : t('review.step2.policy.examplePermitted', { text: example.text })}
              </Text>
            ))}
          </View>
        ) : null}
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
                description={t('review.step2.findings.code', { code: rule.taxonomyCode })}
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
                </View>
              ) : null}
            </View>
          );
        })}
      </Panel>

      {policy.exceptions.length > 0 ? (
        <Panel
          title={t('review.step2.exceptions.title')}
          description={t('review.step2.exceptions.help')}
        >
          {policy.exceptions.map((exception) => (
            <Checkbox
              key={exception.id}
              checked={state.appliedExceptionIds.includes(exception.id)}
              onCheckedChange={() =>
                dispatch({ type: 'toggleException', exceptionId: exception.id })
              }
              label={exception.title}
              description={exception.text}
            />
          ))}
        </Panel>
      ) : null}

      <Panel title={t('review.step2.actions.title')} description={t('review.step2.actions.help')}>
        <View className="gap-1">
          {RECOMMENDED_ACTIONS.map((action) => (
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

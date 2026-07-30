/**
 * Step 1 of the review form — describe what the material contains.
 *
 * The allegation is NOT on this screen. PLAN §9.2 separates the steps to stop
 * the reporter's chosen category anchoring the reviewer, and the cheapest way to
 * lose that is to put the accusation next to the description box. It appears in
 * step 2, labelled as an unverified claim, where it belongs — it is a statement
 * about policy, and policy is step 2's subject.
 */

import { Checkbox } from '@oxyhq/bloom/checkbox';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { ChoiceRow } from '@/components/ChoiceRow';
import { Panel } from '@/components/Screen';
import {
  CERTAINTY_LEVELS,
  CONTENT_DESCRIPTORS,
  MISSING_CONTEXT_CODES,
  type ReviewFormAction,
  type ReviewFormState,
} from '@/lib/review-form';
import type { ReviewerResource } from '@oxyhq/crowdsource-contracts';

interface DescriptiveStepProps {
  state: ReviewFormState;
  dispatch: (action: ReviewFormAction) => void;
  resources: readonly ReviewerResource[];
}

export function DescriptiveStep({ state, dispatch, resources }: DescriptiveStepProps) {
  const { t } = useTranslation();

  return (
    <View className="gap-4">
      <Panel title={t('review.step1.contains.title')} description={t('review.step1.contains.help')}>
        <View className="gap-1">
          {CONTENT_DESCRIPTORS.map((descriptor) => (
            <Checkbox
              key={descriptor}
              checked={state.contentDescriptors.includes(descriptor)}
              onCheckedChange={() => dispatch({ type: 'toggleDescriptor', descriptor })}
              label={t(`descriptor.${descriptor}`)}
            />
          ))}
        </View>
      </Panel>

      <Panel
        title={t('review.step1.resources.title')}
        description={t('review.step1.resources.help')}
      >
        <View className="gap-1">
          {resources.map((resource, index) => (
            <Checkbox
              key={resource.id}
              checked={state.affectedResourceIds.includes(resource.id)}
              onCheckedChange={() => dispatch({ type: 'toggleResource', resourceId: resource.id })}
              label={t('review.step1.resources.item', {
                index: index + 1,
                kind: t(`review.resource.kind.${resource.type}`, { defaultValue: resource.type }),
              })}
            />
          ))}
          {resources.length === 0 ? (
            <Text className="text-sm text-muted-foreground">
              {t('review.step1.resources.empty')}
            </Text>
          ) : null}
        </View>
      </Panel>

      <Panel title={t('review.step1.missing.title')} description={t('review.step1.missing.help')}>
        <View className="gap-1">
          {MISSING_CONTEXT_CODES.map((code) => (
            <Checkbox
              key={code}
              checked={state.missingContext.includes(code)}
              onCheckedChange={() => dispatch({ type: 'toggleMissingContext', code })}
              label={t(`missingContext.${code}`)}
            />
          ))}
        </View>
      </Panel>

      <Panel title={t('review.step1.certainty.title')} description={t('review.step1.certainty.help')}>
        <View className="gap-1">
          {CERTAINTY_LEVELS.map((certainty) => (
            <ChoiceRow
              key={certainty}
              label={t(`certainty.${certainty}`)}
              selected={state.certainty === certainty}
              onSelect={() => dispatch({ type: 'setCertainty', certainty })}
            />
          ))}
        </View>
      </Panel>
    </View>
  );
}

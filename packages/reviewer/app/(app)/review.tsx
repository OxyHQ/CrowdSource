/**
 * The case viewer and the two-step review form.
 *
 * This route takes NO parameters. There is no `/review/[caseId]`, no query
 * string and nothing to paste into a chat: the assignment lives in memory for
 * this session only (`lib/reviewer-api/active-assignment.ts`), so there is no
 * URL that names a case and reloading the page ends the sitting rather than
 * reopening the material.
 *
 * What the reviewer sees is what PLAN §9.1 permits and nothing else. The payload
 * that reaches this screen has already been projected onto the app's own types,
 * field by field, so the hidden half of that table has no representation to
 * render even if a server sends it.
 */

import { Button } from '@oxyhq/bloom/button';
import { useRouter } from 'expo-router';
import React, { useReducer } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { ApiStateNotice } from '@/components/ApiStateNotice';
import { Panel, Screen } from '@/components/Screen';
import { DescriptiveStep } from '@/components/review/DescriptiveStep';
import { PolicyStep } from '@/components/review/PolicyStep';
import { ResourceView } from '@/components/review/ResourceView';
import { SensitiveGate } from '@/components/review/SensitiveGate';
import { WatermarkedMaterial } from '@/components/review/WatermarkedMaterial';
import {
  buildReviewSubmission,
  createInitialReviewFormState,
  isDescriptiveComplete,
  reviewFormReducer,
} from '@/lib/review-form';
import { useActiveAssignment } from '@/lib/reviewer-api/active-assignment';
import { useReviewerProfile, useSubmitReview } from '@/lib/reviewer-api/queries';
import type { AssignmentPackage } from '@/lib/reviewer-api/types';

export default function ReviewScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const assignment = useActiveAssignment();

  if (!assignment) {
    return (
      <Screen title={t('review.title')}>
        <Panel title={t('review.noCase.title')} description={t('review.noCase.body')}>
          <Button variant="secondary" onPress={() => router.replace('/')}>
            {t('review.noCase.action')}
          </Button>
        </Panel>
      </Screen>
    );
  }

  // Keyed on the assignment so a new case can never inherit the previous case's
  // half-filled form. Cheaper and more reliable than resetting state by hand.
  return <ReviewFlow key={assignment.assignmentId} assignment={assignment} />;
}

function ReviewFlow({ assignment }: { assignment: AssignmentPackage }) {
  const { t } = useTranslation();
  const router = useRouter();
  const profileQuery = useReviewerProfile();
  const submitReview = useSubmitReview();

  // No initial argument, on purpose: step 2 cannot be seeded from the allegation
  // because there is nothing to seed it from. See `lib/review-form.ts`.
  const [formState, dispatch] = useReducer(
    reviewFormReducer,
    undefined,
    createInitialReviewFormState,
  );

  // Fails closed: until the profile confirms consent for this category, no
  // sensitive resource can be revealed (PLAN §13.7).
  const consentedCategories = profileQuery.data?.consent.sensitiveCategories ?? [];
  const consented = consentedCategories.includes(assignment.category);

  const submission = buildReviewSubmission(formState, assignment.policy.rules);

  const handleSubmit = () => {
    if (!submission) {
      return;
    }
    submitReview.mutate(
      { assignmentId: assignment.assignmentId, review: submission },
      { onSuccess: () => router.replace('/') },
    );
  };

  return (
    <Screen
      title={t('review.title')}
      subtitle={t('review.subtitle', {
        category: t(`category.${assignment.category}`, { defaultValue: assignment.category }),
        language: assignment.language,
      })}
    >
      <Panel title={t('review.hidden.title')} description={t('review.hidden.body')} />

      <Panel
        title={t('review.material.title')}
        description={t('review.material.expires', {
          time: new Date(assignment.expiresAt).toLocaleString(),
        })}
      >
        {assignment.warnings.length > 0 ? (
          <View className="gap-1 rounded-md bg-muted p-3">
            {assignment.warnings.map((warning) => (
              <Text key={warning} className="text-sm text-muted-foreground">
                {t(`warning.${warning}`, { defaultValue: warning })}
              </Text>
            ))}
          </View>
        ) : null}

        <WatermarkedMaterial label={assignment.watermark}>
          <View className="gap-3">
            {assignment.resources.map((resource) =>
              resource.sensitive ? (
                <SensitiveGate
                  key={resource.id}
                  warnings={resource.warnings}
                  consented={consented}
                >
                  <ResourceView resource={resource} />
                </SensitiveGate>
              ) : (
                <ResourceView key={resource.id} resource={resource} />
              ),
            )}
          </View>
        </WatermarkedMaterial>

        {assignment.watermark ? (
          <Text className="text-xs leading-4 text-muted-foreground">
            {t('review.watermark.note')}
          </Text>
        ) : null}
      </Panel>

      {assignment.context.length > 0 ? (
        <Panel title={t('review.context.title')} description={t('review.context.help')}>
          {assignment.context.map((note) => (
            <Text key={note.id} className="text-sm leading-5 text-foreground" selectable={false}>
              {note.text}
            </Text>
          ))}
        </Panel>
      ) : null}

      <Text className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {formState.step === 'descriptive' ? t('review.step1.label') : t('review.step2.label')}
      </Text>

      {formState.step === 'descriptive' ? (
        <DescriptiveStep
          state={formState}
          dispatch={dispatch}
          resources={assignment.resources}
        />
      ) : (
        <PolicyStep
          state={formState}
          dispatch={dispatch}
          policy={assignment.policy}
          allegation={assignment.allegation}
        />
      )}

      {submitReview.error ? <ApiStateNotice error={submitReview.error} /> : null}

      <View className="gap-3 pb-6">
        {formState.step === 'descriptive' ? (
          <Button
            variant="primary"
            onPress={() => dispatch({ type: 'advance' })}
            disabled={!isDescriptiveComplete(formState)}
          >
            {t('review.action.continue')}
          </Button>
        ) : (
          <>
            <Button variant="secondary" onPress={() => dispatch({ type: 'back' })}>
              {t('review.action.back')}
            </Button>
            <Button
              variant="primary"
              onPress={handleSubmit}
              disabled={submission === null}
              loading={submitReview.isPending}
            >
              {t('review.action.submit')}
            </Button>
          </>
        )}

        {/*
         * Recusal sits with submission, at the same size and in the same block —
         * PLAN §13.7 requires it never be penalised, and burying it behind a menu
         * is a penalty made of friction. The wording says stepping back, not
         * failing.
         */}
        <Button variant="outline" onPress={() => router.push('/recuse')}>
          {t('review.action.recuse')}
        </Button>
        <Text className="text-xs leading-4 text-muted-foreground">
          {t('review.action.recuseNote')}
        </Text>
      </View>
    </Screen>
  );
}

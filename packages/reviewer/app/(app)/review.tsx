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
import type { AssignmentPackage, ReviewSubmission } from '@oxyhq/crowdsource-contracts';

export default function ReviewScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const assignment = useActiveAssignment();
  // The mutation is owned HERE, not by the flow below.
  //
  // A successful submission clears the assignment, which unmounts the flow — and
  // React Query drops a mutation's per-call callbacks when the component that
  // called `mutate` unmounts, so a confirmation driven from inside the flow
  // never runs. This screen survives, so its `isSuccess` is the reliable signal.
  const submitReview = useSubmitReview();

  if (assignment) {
    // Keyed on the assignment so a new case can never inherit the previous
    // case's half-filled form. Cheaper and more reliable than resetting by hand.
    return (
      <ReviewFlow
        key={assignment.assignmentId}
        assignment={assignment}
        onSubmit={(review) =>
          submitReview.mutate({ assignmentId: assignment.assignmentId, review })
        }
        submitting={submitReview.isPending}
        submitError={submitReview.error}
      />
    );
  }

  if (submitReview.isSuccess) {
    return (
      <Screen title={t('review.title')}>
        <Panel title={t('review.submitted.title')} description={t('review.submitted.body')}>
          <Button variant="primary" onPress={() => router.replace('/')}>
            {t('review.submitted.action')}
          </Button>
        </Panel>
      </Screen>
    );
  }

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

interface ReviewFlowProps {
  assignment: AssignmentPackage;
  onSubmit: (review: ReviewSubmission) => void;
  submitting: boolean;
  submitError: Error | null;
}

function ReviewFlow({ assignment, onSubmit, submitting, submitError }: ReviewFlowProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const profileQuery = useReviewerProfile();

  // No initial argument, on purpose: step 2 cannot be seeded from the allegation
  // because there is nothing to seed it from. See `lib/review-form.ts`.
  const [formState, dispatch] = useReducer(
    reviewFormReducer,
    undefined,
    createInitialReviewFormState,
  );

  /**
   * Fails closed, and against EVERY family the case alleges.
   *
   * §8.2 requires consent for each family a case carries, so `some` would let a
   * reviewer who consented to one of three reveal material from the other two.
   * An empty profile (still loading, or failed) consents to nothing.
   */
  const consentedCategories = profileQuery.data?.consent.sensitiveCategories ?? [];
  const consented =
    assignment.families.length > 0 &&
    assignment.families.every((family) => consentedCategories.includes(family));

  const submission = buildReviewSubmission(formState, assignment.policy.rules);

  const handleSubmit = () => {
    if (submission) {
      onSubmit(submission);
    }
  };

  return (
    <Screen title={t('review.title')}>
      {/* Families, plural: a case is the union of every report about the same
          material (§7.3), and a reviewer is only drawn when they accept ALL of
          them (§8.2) — naming one would misdescribe what they were asked to
          judge. The language is nullable because an envelope may declare none. */}
      <Text className="text-base leading-6 text-muted-foreground">
        {t(assignment.language === null ? 'review.subtitleNoLanguage' : 'review.subtitle', {
          category: assignment.families
            .map((family) => t(`category.${family}`, { defaultValue: family }))
            .join(t('history.familySeparator')),
          language: assignment.language,
        })}
      </Text>

      <Panel title={t('review.hidden.title')} description={t('review.hidden.body')} />

      <Panel
        title={t('review.material.title')}
        description={t('review.material.expires', {
          time: new Date(assignment.expiresAt).toLocaleString(),
        })}
      >
        {/* §9.1's "advertencias": the codes that were alleged, and the class
            triage computed. There is no separate warning list on the wire — the
            allegation IS the warning, and inventing a second one would mean
            showing the reviewer a claim the server never made. */}
        <View className="gap-1 rounded-md bg-muted p-3">
          <Text className="text-sm text-muted-foreground">
            {t(`sensitivity.${assignment.presentation.sensitivityClass}`)}
          </Text>
          {assignment.allegations.codes.map((code) => (
            <Text key={code} className="text-sm text-muted-foreground">
              {t(`taxonomy.${code}`, { defaultValue: code })}
            </Text>
          ))}
          {assignment.presentation.requiresRedaction ? (
            <Text className="text-sm text-muted-foreground">{t('review.material.redacted')}</Text>
          ) : null}
        </View>

        <WatermarkedMaterial label={assignment.watermark}>
          <View className="gap-3">
            {/* The gate is decided by the CASE's computed class, not by a
                per-resource flag: §13.7 blurs before revealing whenever triage
                classed the case above `standard`, and the tenant's own
                per-resource hint is a hint, never a verdict (§5.2). */}
            {assignment.resources.map((resource) =>
              assignment.presentation.blurBeforeReveal ? (
                <SensitiveGate
                  key={resource.id}
                  sensitivityClass={assignment.presentation.sensitivityClass}
                  allegationCodes={assignment.allegations.codes}
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

      {/* §5.5's relations, which is the context the envelope actually carries:
          which resource replies to, quotes or contextualises which. The app used
          to expect server-authored prose notes, which nothing has ever produced —
          and which would have arrived untranslated if anything had. */}
      {assignment.relations.length > 0 ? (
        <Panel title={t('review.context.title')} description={t('review.context.help')}>
          {assignment.relations.map((relation) => (
            <Text
              key={`${relation.from}:${relation.type}:${relation.to}`}
              className="text-sm leading-5 text-foreground"
            >
              {t('review.context.relation', {
                from: relation.from,
                relation: t(`relation.${relation.type}`, { defaultValue: relation.type }),
                to: relation.to,
              })}
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
          allegations={assignment.allegations}
        />
      )}

      {submitError ? <ApiStateNotice error={submitError} /> : null}

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
              loading={submitting}
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

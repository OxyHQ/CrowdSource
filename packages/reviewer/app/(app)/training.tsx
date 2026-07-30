/**
 * Training and calibration (PLAN §4.1, §8.1, §9.7).
 *
 * This is the screen that moves an `applicant` toward being drawable, and until
 * now it could not: it listed the modules and offered no way to complete one, and
 * offered no way to calibrate at all. §8.1 makes both of them gates —
 * `openCalibrationIfReady` needs every module, and `community` needs a passed
 * calibration — so a reviewer who only ever saw this screen could never be drawn
 * for anything.
 *
 * Two things it deliberately still does NOT do:
 *
 *  - There is no practice arena. A `calibrating` reviewer receives gold cases that
 *    are indistinguishable from real ones (§8.1, §9.7), through the same "review
 *    next case" door as everything else, which is the whole point of them.
 *  - The calibration form never shows which answer was right. A calibration that
 *    hands back the key is one everybody passes on the second attempt, which
 *    measures attendance rather than judgement — so a failed attempt names the
 *    items that were wrong and stops there.
 */

import { Button } from '@oxyhq/bloom/button';
import { Beaker_Stroke2_Corner2_Rounded } from '@oxyhq/bloom/icons';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxyhq/bloom/segmented-control';
import type { ReviewerCalibrationSubmission } from '@oxyhq/crowdsource-contracts';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { ApiStateNotice, LoadingPanel } from '@/components/ApiStateNotice';
import { EmptyState } from '@/components/EmptyState';
import { Panel, Screen } from '@/components/Screen';
import {
  useCompleteTrainingModule,
  useSubmitCalibration,
  useTrainingState,
} from '@/lib/reviewer-api/queries';

export default function TrainingScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const trainingQuery = useTrainingState();
  const completeModule = useCompleteTrainingModule();
  const training = trainingQuery.data;

  return (
    <Screen title={t('training.title')}>
      <Text className="text-base leading-6 text-muted-foreground">{t('training.subtitle')}</Text>

      {trainingQuery.isPending ? <LoadingPanel /> : null}
      {trainingQuery.error ? <ApiStateNotice error={trainingQuery.error} /> : null}

      {training ? (
        <>
          <Panel title={t('training.modules.title')} description={t('training.modules.help')}>
            {training.modules.length === 0 ? (
              <EmptyState
                icon={
                  <Beaker_Stroke2_Corner2_Rounded
                    width={28}
                    height={28}
                    fill="currentColor"
                    className="text-muted-foreground"
                  />
                }
                title={t('training.modules.empty')}
                description={t('training.modules.emptyHelp')}
              />
            ) : null}
            {training.modules.map((module, index) => (
              <View
                key={module.moduleId}
                className={
                  index < training.modules.length - 1 ? 'gap-2 border-b border-border pb-3' : 'gap-2'
                }
              >
                <Text className="text-base font-semibold text-foreground">{module.title}</Text>
                <Text className="text-sm text-muted-foreground">
                  {module.families
                    .map((family) => t(`category.${family}`, { defaultValue: family }))
                    .join(t('history.familySeparator'))}
                </Text>
                {module.completed ? (
                  <Text className="text-sm text-muted-foreground">
                    {t('training.modules.completed')}
                  </Text>
                ) : (
                  <Button
                    variant="secondary"
                    onPress={() => completeModule.mutate(module.moduleId)}
                    loading={
                      completeModule.isPending && completeModule.variables === module.moduleId
                    }
                  >
                    {t('training.modules.complete')}
                  </Button>
                )}
              </View>
            ))}
            {completeModule.error ? <ApiStateNotice error={completeModule.error} /> : null}
          </Panel>

          <Panel
            title={t('training.calibration.title')}
            description={
              training.calibrationOpen
                ? t('training.calibration.open', {
                    score: Math.round(training.calibrationPassScore * 100),
                  })
                : t('training.calibration.locked')
            }
          >
            <Text className="text-sm text-muted-foreground">
              {training.calibrationCurrentUntil
                ? t('training.calibration.currentUntil', {
                    date: new Date(training.calibrationCurrentUntil).toLocaleDateString(),
                  })
                : t('training.calibration.notCalibrated')}
            </Text>
            {training.calibrationAttempts > 0 ? (
              <Text className="text-sm text-muted-foreground">
                {t('training.calibration.attempts', { count: training.calibrationAttempts })}
              </Text>
            ) : null}
            <Text className="text-sm leading-5 text-muted-foreground">
              {t('training.calibration.goldNote')}
            </Text>
            <Button variant="text" onPress={() => router.push('/')}>
              {t('training.calibration.action')}
            </Button>
          </Panel>

          {training.calibrationOpen ? <CalibrationForm items={training.calibrationItems} /> : null}
        </>
      ) : null}
    </Screen>
  );
}

interface CalibrationFormProps {
  items: readonly { readonly itemId: string; readonly text: string }[];
}

function CalibrationForm({ items }: CalibrationFormProps) {
  const { t } = useTranslation();
  const submitCalibration = useSubmitCalibration();
  const [answers, setAnswers] = useState<Record<string, boolean>>({});

  const result = submitCalibration.data;
  const incorrect = new Set(result?.incorrectItemIds ?? []);
  const complete = items.every((item) => item.itemId in answers);

  const handleSubmit = () => {
    if (!complete) {
      return;
    }
    const submission: ReviewerCalibrationSubmission = {
      answers: items.map((item) => ({
        itemId: item.itemId,
        violation: answers[item.itemId] === true,
      })),
    };
    submitCalibration.mutate(submission);
  };

  return (
    <Panel
      title={t('training.calibration.form.title')}
      description={t('training.calibration.form.help')}
    >
      {items.map((item) => (
        <View key={item.itemId} className="gap-2 border-b border-border pb-3">
          {/* Gold-case material. Not selectable, for the same reason real case
              material is not (§13.8). */}
          <Text className="text-sm leading-5 text-foreground" selectable={false}>
            {item.text}
          </Text>
          <SegmentedControl
            label={t('training.calibration.form.question')}
            type="radio"
            size="small"
            // An empty value matches no item, so an unanswered question shows
            // nothing selected rather than defaulting to one of the two answers.
            value={item.itemId in answers ? String(answers[item.itemId]) : ''}
            onChange={(value) =>
              setAnswers((current) => ({ ...current, [item.itemId]: value === 'true' }))
            }
          >
            <SegmentedControlItem value="true">
              <SegmentedControlItemText>
                {t('training.calibration.form.violation')}
              </SegmentedControlItemText>
            </SegmentedControlItem>
            <SegmentedControlItem value="false">
              <SegmentedControlItemText>
                {t('training.calibration.form.noViolation')}
              </SegmentedControlItemText>
            </SegmentedControlItem>
          </SegmentedControl>
          {/* Which items were wrong, never which answer was right. */}
          {incorrect.has(item.itemId) ? (
            <Text className="text-sm text-muted-foreground">
              {t('training.calibration.form.wasIncorrect')}
            </Text>
          ) : null}
        </View>
      ))}

      {result ? (
        <Text className="text-base font-semibold text-foreground">
          {result.passed
            ? t('training.calibration.form.passed', { score: Math.round(result.score * 100) })
            : t('training.calibration.form.failed', { score: Math.round(result.score * 100) })}
        </Text>
      ) : null}
      {submitCalibration.error ? <ApiStateNotice error={submitCalibration.error} /> : null}

      <Button
        variant="primary"
        onPress={handleSubmit}
        disabled={!complete}
        loading={submitCalibration.isPending}
      >
        {t('training.calibration.form.submit')}
      </Button>
      {/* §9.7: being wrong in calibration is what calibration is for, so a failed
          attempt costs nothing but the gate staying shut. Said plainly, because a
          reviewer who thinks a failure is held against them answers differently. */}
      <Text className="text-xs leading-4 text-muted-foreground">
        {t('training.calibration.form.retryNote')}
      </Text>
    </Panel>
  );
}

/**
 * Training and calibration (PLAN §4.1, §8.1, §9.7).
 *
 * A `calibrating` reviewer receives gold cases that are indistinguishable from
 * real ones and whose answers resolve nothing (§8.1, §9.7). That is deliberate,
 * and it is why this screen shows progress rather than a practice arena: there
 * is no separate "training case" surface to open. Calibration cases arrive
 * through the same "review next case" door as everything else.
 */

import { useRouter } from 'expo-router';
import { Button } from '@oxyhq/bloom/button';
import { Beaker_Stroke2_Corner2_Rounded } from '@oxyhq/bloom/icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { ApiStateNotice, LoadingPanel } from '@/components/ApiStateNotice';
import { EmptyState } from '@/components/EmptyState';
import { Panel, Screen } from '@/components/Screen';
import { useTrainingState } from '@/lib/reviewer-api/queries';

export default function TrainingScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const trainingQuery = useTrainingState();

  return (
    <Screen title={t('training.title')}>
      <Text className="text-base leading-6 text-muted-foreground">{t('training.subtitle')}</Text>

      {trainingQuery.isPending ? <LoadingPanel /> : null}
      {trainingQuery.error ? <ApiStateNotice error={trainingQuery.error} /> : null}

      {trainingQuery.data ? (
        <>
          <Panel
            title={t('training.calibration.title')}
            description={t('training.calibration.progress', {
              answered: trainingQuery.data.calibrationCasesAnswered,
              required: trainingQuery.data.calibrationCasesRequired,
            })}
          >
            <Text className="text-sm text-muted-foreground">
              {trainingQuery.data.calibrationCurrentUntil
                ? t('training.calibration.currentUntil', {
                    date: new Date(trainingQuery.data.calibrationCurrentUntil).toLocaleDateString(),
                  })
                : t('training.calibration.notCalibrated')}
            </Text>
            <Text className="text-sm leading-5 text-muted-foreground">
              {t('training.calibration.goldNote')}
            </Text>
            <Button variant="secondary" onPress={() => router.push('/')}>
              {t('training.calibration.action')}
            </Button>
          </Panel>

          <Panel title={t('training.modules.title')} description={t('training.modules.help')}>
            {trainingQuery.data.modules.length === 0 ? (
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
            {trainingQuery.data.modules.map((module, index) => (
              <View
                key={module.id}
                className={
                  index < trainingQuery.data.modules.length - 1
                    ? 'gap-1 border-b border-border pb-3'
                    : 'gap-1'
                }
              >
                <Text className="text-base font-semibold text-foreground">{module.title}</Text>
                <Text className="text-sm text-muted-foreground">
                  {t(`category.${module.category}`, { defaultValue: module.category })}
                </Text>
                <Text className="text-sm text-muted-foreground">
                  {module.completedAt
                    ? t('training.modules.completed', {
                        date: new Date(module.completedAt).toLocaleDateString(),
                      })
                    : t('training.modules.notCompleted')}
                </Text>
                {module.expiresAt ? (
                  <Text className="text-sm text-muted-foreground">
                    {t('training.modules.expires', {
                      date: new Date(module.expiresAt).toLocaleDateString(),
                    })}
                  </Text>
                ) : null}
              </View>
            ))}
          </Panel>
        </>
      ) : null}
    </Screen>
  );
}

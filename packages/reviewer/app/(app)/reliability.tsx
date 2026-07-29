/**
 * Reliability (PLAN §4.1) — the reviewer's own standing, and only their own.
 *
 * Every figure on this screen belongs to the person reading it. There is no
 * leaderboard, no comparison and no way to see anyone else's: §8.4 lets
 * reliability affect eligibility and selection probability, and §9.1 keeps
 * everybody else's reputation out of the review entirely. One qualified person,
 * one vote — a high figure here buys more invitations, never a louder one.
 */

import { Growth_Stroke2_Corner0_Rounded } from '@oxyhq/bloom/icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { ApiStateNotice, LoadingPanel } from '@/components/ApiStateNotice';
import { EmptyState } from '@/components/EmptyState';
import { Panel, Screen } from '@/components/Screen';
import { useReviewerProfile } from '@/lib/reviewer-api/queries';

export default function ReliabilityScreen() {
  const { t } = useTranslation();
  const profileQuery = useReviewerProfile();

  return (
    <Screen title={t('reliability.title')}>
      <Text className="text-base leading-6 text-muted-foreground">{t('reliability.subtitle')}</Text>

      {profileQuery.isPending ? <LoadingPanel /> : null}
      {profileQuery.error ? <ApiStateNotice error={profileQuery.error} /> : null}

      {profileQuery.data ? (
        <>
          <Panel
            title={t('reliability.state.title')}
            description={t(`reviewerState.${profileQuery.data.state}`)}
          />

          <Panel
            title={t('reliability.standings.title')}
            description={t('reliability.standings.help')}
          >
            {profileQuery.data.standings.length === 0 ? (
              <EmptyState
                icon={
                  <Growth_Stroke2_Corner0_Rounded
                    width={28}
                    height={28}
                    fill="currentColor"
                    className="text-muted-foreground"
                  />
                }
                title={t('reliability.standings.empty')}
                description={t('reliability.standings.emptyHelp')}
              />
            ) : null}
            {profileQuery.data.standings.map((standing, index) => (
              <View
                key={`${standing.category}:${standing.language}`}
                className={
                  index < profileQuery.data.standings.length - 1
                    ? 'gap-1 border-b border-border pb-3'
                    : 'gap-1'
                }
              >
                <Text className="text-base font-semibold text-foreground">
                  {t(`category.${standing.category}`, { defaultValue: standing.category })}
                </Text>
                <Text className="text-sm text-muted-foreground">
                  {t('reliability.standings.row', {
                    language: standing.language,
                    reliability: Math.round(standing.reliability * 100),
                    reviews: standing.reviewsCompleted,
                  })}
                </Text>
                <Text className="text-sm text-muted-foreground">
                  {standing.calibrationCurrent
                    ? t('reliability.standings.calibrated')
                    : t('reliability.standings.needsCalibration')}
                </Text>
              </View>
            ))}
          </Panel>

          <Panel
            title={t('reliability.eligibility.title')}
            description={t('reliability.eligibility.help')}
          >
            {profileQuery.data.eligibility.map((requirement) => (
              <View key={requirement.id} className="gap-1">
                <Text className="text-sm font-semibold text-foreground">
                  {requirement.met
                    ? t('reliability.eligibility.met', {
                        requirement: t(`eligibility.${requirement.id}`),
                      })
                    : t('reliability.eligibility.unmet', {
                        requirement: t(`eligibility.${requirement.id}`),
                      })}
                </Text>
                {requirement.detail ? (
                  <Text className="text-sm text-muted-foreground">{requirement.detail}</Text>
                ) : null}
              </View>
            ))}
          </Panel>

          <Panel title={t('reliability.exposure.title')} description={t('reliability.exposure.help')}>
            <Text className="text-sm text-muted-foreground">
              {t('home.state.exposure', {
                reviewed: profileQuery.data.exposure.reviewedToday,
                limit: profileQuery.data.exposure.dailyLimit,
              })}
            </Text>
            {profileQuery.data.exposure.breakRequiredUntil ? (
              <Text className="text-sm text-muted-foreground">
                {t('reliability.exposure.break', {
                  time: new Date(profileQuery.data.exposure.breakRequiredUntil).toLocaleString(),
                })}
              </Text>
            ) : null}
          </Panel>
        </>
      ) : null}
    </Screen>
  );
}

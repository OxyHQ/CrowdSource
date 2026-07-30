/**
 * An application's standing, its trust signals, and what it has used against its
 * quota.
 *
 * The screen exists to answer two questions an integrator asks in this order: "am I
 * allowed to do what I am trying to do", and "how close am I to the limit". Standing
 * answers the first — a sandbox application has a small daily budget and cannot move
 * an Oxy Trust figure at all — and the usage panel answers the second.
 *
 * The three quality signals are shown even though every one of them is currently
 * `null`, and they are shown as ABSENT rather than as zero. Nothing measures them
 * yet; a `0.0` beside "Evidence integrity" reports the worst possible score for a
 * signal that has never been taken, and an integrator would open a support thread
 * about it. `formatOptionalNumber` is the one place that decision is implemented.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { ApiStateNotice, LoadingPanel } from '@/components/ApiStateNotice';
import { CopyValue } from '@/components/data/CopyValue';
import { KeyValueList } from '@/components/data/KeyValueList';
import { StatusPill } from '@/components/data/StatusPill';
import { Panel, Screen } from '@/components/Screen';
import { useRouteParam } from '@/hooks/useRouteParam';
import { formatOptionalNumber, formatRatio, standingTone } from '@/lib/console-api/presentation';
import { useApplication, useUsage } from '@/lib/console-api/queries';
import type { UsageSummary } from '@/lib/console-api/types';
import { USAGE_WINDOW_DAYS } from '@/lib/constants';

export default function ApplicationOverviewScreen() {
  const { t } = useTranslation();
  const applicationId = useRouteParam('applicationId');
  const application = useApplication(applicationId);
  const usage = useUsage(applicationId, USAGE_WINDOW_DAYS);

  return (
    <Screen
      title={application.data?.name ?? t('overview.title')}
      subtitle={
        application.data ? (
          <View className="flex-row items-center gap-2">
            <StatusPill
              label={t(`standing.${application.data.trust.standing}`)}
              tone={standingTone(application.data.trust.standing)}
            />
            <Text className="text-xs text-muted-foreground">
              {t(`role.${application.data.role}`)}
            </Text>
          </View>
        ) : null
      }
    >
      {application.isPending ? <LoadingPanel count={3} /> : null}
      {application.error ? <ApiStateNotice error={application.error} /> : null}

      {application.data ? (
        <>
          <Panel title={t('overview.identity.title')} description={t('overview.identity.body')}>
            <KeyValueList
              rows={[
                {
                  label: t('overview.identity.applicationId'),
                  // Copyable because this is the value an integrator puts in an
                  // environment variable, and a mis-selected id fails as a 404
                  // that reads as "not yours".
                  value: (
                    <CopyValue
                      value={application.data.applicationId}
                      label={t('overview.identity.applicationId')}
                    />
                  ),
                },
                {
                  label: t('overview.identity.organizationId'),
                  value: (
                    <CopyValue
                      value={application.data.organizationId}
                      label={t('overview.identity.organizationId')}
                    />
                  ),
                },
                {
                  label: t('overview.identity.status'),
                  value: t(`applicationStatus.${application.data.status}`),
                  hint: t('overview.identity.statusHint'),
                },
                { label: t('overview.identity.createdAt'), value: application.data.createdAt },
              ]}
            />
          </Panel>

          <Panel title={t('overview.trust.title')} description={t('overview.trust.body')}>
            <KeyValueList
              rows={[
                {
                  label: t('overview.trust.standing'),
                  value: (
                    <StatusPill
                      label={t(`standing.${application.data.trust.standing}`)}
                      tone={standingTone(application.data.trust.standing)}
                    />
                  ),
                  hint: t(`standingHint.${application.data.trust.standing}`),
                },
                {
                  label: t('overview.trust.globalEffects'),
                  value: application.data.trust.globalReputationEffectsAllowed
                    ? t('common.yes')
                    : t('common.no'),
                  hint: t('overview.trust.globalEffectsHint'),
                },
                {
                  label: t('overview.trust.lastReason'),
                  value: t(`standingReason.${application.data.trust.lastStandingReason}`, {
                    defaultValue: application.data.trust.lastStandingReason,
                  }),
                },
                {
                  label: t('overview.trust.changedAt'),
                  value: application.data.trust.standingChangedAt,
                },
                {
                  label: t('overview.trust.evidenceIntegrity'),
                  value: formatOptionalNumber(application.data.trust.evidenceIntegrity, formatRatio),
                },
                {
                  label: t('overview.trust.identityBinding'),
                  value: formatOptionalNumber(
                    application.data.trust.identityBindingReliability,
                    formatRatio,
                  ),
                },
                {
                  label: t('overview.trust.policyQuality'),
                  value: formatOptionalNumber(application.data.trust.policyQuality, formatRatio),
                },
              ]}
            />
            {/* Said once, here, rather than as a dash the reader has to interpret. */}
            <Text className="text-xs leading-4 text-muted-foreground">
              {t('overview.trust.signalsAbsent')}
            </Text>
          </Panel>

          <Panel title={t('overview.quota.title')} description={t('overview.quota.body')}>
            <KeyValueList
              rows={[
                {
                  label: t('overview.quota.reportsPerDay'),
                  value: String(application.data.quota.reportsPerDay),
                },
                {
                  label: t('overview.quota.webhookEndpoints'),
                  value: String(application.data.quota.webhookEndpoints),
                },
                {
                  label: t('overview.quota.globalEffects'),
                  value: application.data.quota.globalReputationEffects
                    ? t('common.yes')
                    : t('common.no'),
                },
              ]}
            />
          </Panel>
        </>
      ) : null}

      {usage.isPending ? <LoadingPanel count={1} /> : null}
      {usage.error ? <ApiStateNotice error={usage.error} /> : null}
      {usage.data ? <UsagePanel usage={usage.data} /> : null}
    </Screen>
  );
}

/** Width (px) of the label column beside a daily bar, so the bars share a baseline. */
const DAILY_LABEL_WIDTH = 96;
/** How many days of the window the daily list shows. The window itself is longer. */
const DAILY_ROWS = 14;

function UsagePanel({ usage }: { usage: UsageSummary }) {
  const { t } = useTranslation();
  // The bar scale. `1` as the floor so a window of all-zero days does not divide by
  // zero and does not draw a full-width bar for nothing.
  const peak = Math.max(1, ...usage.daily.map((day) => day.reportsReceived));

  return (
    <Panel
      title={t('overview.usage.title')}
      description={t('overview.usage.body', { days: usage.window.days })}
    >
      {usage.atDailyLimit ? (
        // The one thing on this screen that is actionable right now: reports are
        // being refused as this is read.
        <View className="rounded-md bg-destructive/10 p-3">
          <Text className="text-sm font-semibold text-destructive">
            {t('overview.usage.atLimit.title')}
          </Text>
          <Text className="pt-1 text-xs leading-4 text-foreground">
            {t('overview.usage.atLimit.body', { limit: usage.quota.reportsPerDay })}
          </Text>
        </View>
      ) : null}

      <KeyValueList
        rows={[
          {
            label: t('overview.usage.reportsReceived'),
            value: String(usage.counts.reportsReceived),
          },
          { label: t('overview.usage.casesCreated'), value: String(usage.counts.casesCreated) },
          {
            label: t('overview.usage.decisionsPublished'),
            value: String(usage.counts.decisionsPublished),
          },
          {
            label: t('overview.usage.window'),
            value: t('overview.usage.windowValue', { from: usage.window.from, to: usage.window.to }),
          },
        ]}
      />

      <View className="gap-1">
        <Text className="text-xs uppercase tracking-wide text-muted-foreground">
          {t('overview.usage.daily')}
        </Text>
        {usage.daily.length === 0 ? (
          <Text className="text-sm text-muted-foreground">{t('overview.usage.dailyEmpty')}</Text>
        ) : (
          // Newest first, as served. Not reversed: the day an operator cares about
          // is today, and it belongs at the top where the eye lands.
          usage.daily.slice(0, DAILY_ROWS).map((day) => (
            <View key={day.day} className="flex-row items-center gap-2">
              <Text
                className="font-bloom-mono text-xs text-muted-foreground"
                style={{ width: DAILY_LABEL_WIDTH }}
              >
                {day.day}
              </Text>
              <View className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                <View
                  className="h-2 rounded-full bg-primary"
                  // A proportion, which no utility class can express.
                  style={{ width: `${(day.reportsReceived / peak) * 100}%` }}
                />
              </View>
              <Text className="w-12 text-right font-bloom-mono text-xs text-foreground">
                {day.reportsReceived}
              </Text>
            </View>
          ))
        )}
      </View>
    </Panel>
  );
}

/**
 * Honest states for a surface whose backend is still being built.
 *
 * `packages/backend` serves health and nothing else today; the reviewer
 * endpoints are being written in parallel. A screen that met that with sample
 * data would look finished and be a lie — someone would demo it. So a screen
 * that cannot load says which endpoint it is waiting for, by name, and offers
 * nothing else.
 *
 * When the endpoint ships, the same screens light up with no changes here.
 */

import { Loading } from '@oxyhq/bloom/loading';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { Panel } from '@/components/Screen';
import { API_URL } from '@/config';
import {
  ReviewerApiUnavailableError,
  isAssignmentNotHeld,
  isReviewerApiUnreachable,
} from '@/lib/reviewer-api/errors';

export function LoadingPanel() {
  const { t } = useTranslation();
  return (
    <View className="items-center gap-3 py-10">
      <Loading variant="spinner" size="medium" />
      <Text className="text-sm text-muted-foreground">{t('state.loading')}</Text>
    </View>
  );
}

interface ApiStateNoticeProps {
  error: unknown;
}

export function ApiStateNotice({ error }: ApiStateNoticeProps) {
  const { t } = useTranslation();

  if (error instanceof ReviewerApiUnavailableError) {
    return (
      <Panel title={t('state.unavailable.title')} description={t('state.unavailable.body')}>
        <View className="gap-1 rounded-md bg-muted p-3">
          <Text className="text-xs uppercase tracking-wide text-muted-foreground">
            {t('state.unavailable.endpointLabel')}
          </Text>
          <Text className="font-bloom-mono text-sm text-foreground" selectable>
            {error.endpoint}
          </Text>
        </View>
      </Panel>
    );
  }

  if (isReviewerApiUnreachable(error)) {
    return (
      <Panel
        title={t('state.unreachable.title')}
        description={t('state.unreachable.body', { origin: API_URL })}
      />
    );
  }

  if (isAssignmentNotHeld(error)) {
    return <Panel title={t('state.notHeld.title')} description={t('state.notHeld.body')} />;
  }

  return (
    <Panel title={t('state.error.title')} description={t('state.error.body')}>
      {error instanceof Error ? (
        <Text className="font-bloom-mono text-xs text-muted-foreground" selectable>
          {error.message}
        </Text>
      ) : null}
    </Panel>
  );
}

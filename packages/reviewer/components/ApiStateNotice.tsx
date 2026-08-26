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

import * as Skeleton from '@oxyhq/bloom/skeleton';
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

/** Text lines the placeholder draws per panel, matching a typical panel's body. */
const PLACEHOLDER_LINES_PER_PANEL = 3;

/**
 * The placeholder a screen shows while its panels are on the way.
 *
 * Shaped like what it replaces, not like a spinner. Every one of these screens
 * resolves into a short stack of bordered panels, so the placeholder is that
 * same stack with its text greyed out: the page lands at roughly the height it
 * will keep, instead of a centred spinner collapsing into a full screen of
 * content and shoving everything the reviewer was reading down the page.
 *
 * `count` is how many panels the caller is about to render, so the guess is the
 * screen's own rather than a global average.
 */
export function LoadingPanel({ count = 2 }: { count?: number }) {
  const { t } = useTranslation();
  return (
    <View className="gap-6" accessibilityRole="progressbar" accessibilityLabel={t('state.loading')}>
      {Array.from({ length: count }, (_, index) => (
        <Panel key={index}>
          <View className="gap-2">
            {Array.from({ length: PLACEHOLDER_LINES_PER_PANEL }, (_, line) => (
              <Skeleton.Box key={line} width="100%" height={16} borderRadius={4} />
            ))}
          </View>
        </Panel>
      ))}
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

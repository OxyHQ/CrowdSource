/**
 * History (PLAN §4.1) — reviews this person completed.
 *
 * A decision appears next to a review only once it is final AND disclosable. Up
 * to that point the entry says the case is still open and nothing more: showing
 * "2 of 3 so far" would be a partial vote by another name, and §9.1 forbids it
 * on the review screen precisely so that it cannot be reconstructed afterwards.
 *
 * There is nothing to click through to. A completed review does not reopen the
 * material — the assignment is spent, and the case was never the reviewer's to
 * revisit.
 */

import { Button } from '@oxyhq/bloom/button';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { ApiStateNotice, LoadingPanel } from '@/components/ApiStateNotice';
import { Panel, Screen } from '@/components/Screen';
import { useReviewHistory } from '@/lib/reviewer-api/queries';

export default function HistoryScreen() {
  const { t } = useTranslation();
  const historyQuery = useReviewHistory();

  const entries = historyQuery.data?.pages.flatMap((page) => page.entries) ?? [];

  return (
    <Screen title={t('history.title')} subtitle={t('history.subtitle')}>
      {historyQuery.isPending ? <LoadingPanel /> : null}
      {historyQuery.error ? <ApiStateNotice error={historyQuery.error} /> : null}

      {historyQuery.data ? (
        <Panel>
          {entries.length === 0 ? (
            <Text className="text-sm text-muted-foreground">{t('history.empty')}</Text>
          ) : null}
          {entries.map((entry) => (
            <View key={entry.reviewId} className="gap-1 border-b border-border pb-3">
              <Text className="text-base font-semibold text-foreground">
                {t(`category.${entry.category}`, { defaultValue: entry.category })}
              </Text>
              <Text className="text-sm text-muted-foreground">
                {t('history.submitted', {
                  date: new Date(entry.submittedAt).toLocaleString(),
                  language: entry.language,
                })}
              </Text>
              <Text className="text-sm text-muted-foreground">
                {t('history.yourOutcome', { outcome: t(`outcome.${entry.outcome}`) })}
              </Text>
              <Text className="text-sm text-muted-foreground">
                {entry.decision
                  ? t('history.decision', {
                      outcome: t(`outcome.${entry.decision.outcome}`, {
                        defaultValue: entry.decision.outcome,
                      }),
                      date: new Date(entry.decision.publishedAt).toLocaleDateString(),
                    })
                  : t('history.decisionPending')}
              </Text>
            </View>
          ))}

          {historyQuery.hasNextPage ? (
            <Button
              variant="secondary"
              onPress={() => historyQuery.fetchNextPage()}
              loading={historyQuery.isFetchingNextPage}
            >
              {t('history.loadMore')}
            </Button>
          ) : null}
        </Panel>
      ) : null}
    </Screen>
  );
}

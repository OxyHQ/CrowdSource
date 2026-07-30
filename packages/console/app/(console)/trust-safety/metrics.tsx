/**
 * Platform metrics, and an explicit list of the metrics this deployment cannot
 * compute.
 *
 * ## The `unavailable` list is the most important thing on the screen
 *
 * §16.4 names case queue age, cases created, the inconclusive rate, the appeal rate,
 * the overturn rate and reviewer exposure. None of them can be computed here: `cases`
 * and `decisions` are tenant-scoped collections that expose no cross-tenant read at
 * all, and §12.9 puts cross-tenant correlation behind a privileged `Incident` module
 * that does not exist. The API returns their names in `unavailable` rather than
 * omitting the keys, precisely so a dashboard cannot render them as zero — a
 * dashboard reading absent as zero is the exact failure the field exists to prevent.
 *
 * So they are rendered, by name, as unavailable. Hiding the list would recreate the
 * problem one layer up: an operator would see four healthy delivery figures and
 * conclude the platform was fully instrumented.
 *
 * `successRate` follows the same rule: it is `null` and not `0` when nothing has been
 * attempted, because a 0% success rate on an empty deployment is the most alarming
 * possible way to say "no data".
 *
 * ## The dead-letter queue
 *
 * `security` only, and a narrower read than the trust table above it. §10.9 promises
 * the tenant an alert and a manual replay; this is the other half — the view an
 * operator needs when several tenants stop receiving at once, which is the shape of a
 * fault on our side rather than on theirs. The rows carry no event body: a
 * cross-tenant reader has no relationship with the case they name.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { ApiStateNotice, LoadingPanel } from '@/components/ApiStateNotice';
import { Cell, DataTable, IdentifierCell, type Column } from '@/components/data/DataTable';
import { KeyValueList } from '@/components/data/KeyValueList';
import { Panel, Screen } from '@/components/Screen';
import {
  formatOptionalNumber,
  formatOptionalText,
  formatRatio,
} from '@/lib/console-api/presentation';
import { canOperateSecurity } from '@/lib/console-api/roles';
import {
  useConsoleSession,
  useDeadLetterQueue,
  usePlatformMetrics,
} from '@/lib/console-api/queries';
import type { DeadLetteredDelivery } from '@/lib/console-api/types';

export default function PlatformMetricsScreen() {
  const { t } = useTranslation();
  const session = useConsoleSession();
  const metrics = usePlatformMetrics();
  const maySeeQueue = canOperateSecurity(session.data?.staffRoles ?? []);

  return (
    <Screen
      title={t('metrics.title')}
      subtitle={<Text className="text-xs text-muted-foreground">{t('metrics.subtitle')}</Text>}
    >
      {metrics.isPending ? <LoadingPanel count={2} /> : null}
      {metrics.error ? <ApiStateNotice error={metrics.error} /> : null}

      {metrics.data ? (
        <>
          <Panel title={t('metrics.standing.title')} description={t('metrics.standing.body')}>
            <KeyValueList
              rows={[
                {
                  label: t('standing.sandbox'),
                  value: String(metrics.data.applicationsByStanding.sandbox),
                },
                {
                  label: t('standing.trusted'),
                  value: String(metrics.data.applicationsByStanding.trusted),
                },
                {
                  label: t('standing.restricted'),
                  value: String(metrics.data.applicationsByStanding.restricted),
                },
              ]}
            />
          </Panel>

          <Panel title={t('metrics.deliveries.title')} description={t('metrics.deliveries.body')}>
            <KeyValueList
              rows={[
                {
                  label: t('deliveryStatus.pending'),
                  value: String(metrics.data.deliveries.pending),
                },
                {
                  label: t('deliveryStatus.delivering'),
                  value: String(metrics.data.deliveries.delivering),
                },
                {
                  label: t('deliveryStatus.succeeded'),
                  value: String(metrics.data.deliveries.succeeded),
                },
                {
                  label: t('deliveryStatus.dead_letter'),
                  value: String(metrics.data.deliveries.deadLetter),
                },
                {
                  label: t('metrics.deliveries.successRate'),
                  // Absent, not 0%, when nothing has been attempted.
                  value: formatOptionalNumber(metrics.data.deliveries.successRate, formatRatio),
                  hint:
                    metrics.data.deliveries.successRate === null
                      ? t('metrics.deliveries.successRateAbsent')
                      : undefined,
                },
              ]}
            />
          </Panel>

          <Panel
            title={t('metrics.unavailable.title')}
            description={t('metrics.unavailable.body')}
          >
            {metrics.data.unavailable.length === 0 ? (
              <Text className="text-sm text-muted-foreground">
                {t('metrics.unavailable.none')}
              </Text>
            ) : (
              <View className="gap-1">
                {metrics.data.unavailable.map((metric) => (
                  <View key={metric} className="flex-row items-center gap-2">
                    <Text className="font-bloom-mono text-xs text-foreground" selectable>
                      {metric}
                    </Text>
                    <Text className="text-xs text-muted-foreground">
                      {t('metrics.unavailable.marker')}
                    </Text>
                  </View>
                ))}
              </View>
            )}
            <Text className="text-xs leading-4 text-muted-foreground">
              {t('metrics.unavailable.why')}
            </Text>
          </Panel>
        </>
      ) : null}

      {maySeeQueue ? <DeadLetterPanel /> : null}
    </Screen>
  );
}

function DeadLetterPanel() {
  const { t } = useTranslation();
  const queue = useDeadLetterQueue();

  const columns: Column<DeadLetteredDelivery>[] = [
    {
      id: 'deadLetteredAt',
      header: t('metrics.queue.column.at'),
      width: 180,
      render: (row) => <Cell>{formatOptionalText(row.deadLetteredAt)}</Cell>,
    },
    {
      id: 'eventType',
      header: t('metrics.queue.column.eventType'),
      flex: 2,
      render: (row) => <Cell>{row.eventType}</Cell>,
    },
    {
      id: 'applicationId',
      header: t('metrics.queue.column.application'),
      flex: 2,
      render: (row) => <IdentifierCell>{row.applicationId}</IdentifierCell>,
    },
    {
      id: 'endpoint',
      header: t('metrics.queue.column.endpoint'),
      flex: 2,
      render: (row) => <IdentifierCell>{row.webhookEndpointId}</IdentifierCell>,
    },
    {
      id: 'attempts',
      header: t('metrics.queue.column.attempts'),
      width: 100,
      align: 'right',
      render: (row) => <Cell>{String(row.attemptCount)}</Cell>,
    },
    {
      id: 'lastResponse',
      header: t('metrics.queue.column.lastResponse'),
      width: 110,
      align: 'right',
      render: (row) => (
        <Cell muted={row.lastResponseStatus === null}>
          {row.lastResponseStatus === null ? t('common.absent') : String(row.lastResponseStatus)}
        </Cell>
      ),
    },
    {
      id: 'reason',
      header: t('metrics.queue.column.reason'),
      flex: 2,
      render: (row) => (
        <Cell muted={row.deadLetterReason === null}>
          {formatOptionalText(row.deadLetterReason)}
        </Cell>
      ),
    },
    {
      id: 'replays',
      header: t('metrics.queue.column.replays'),
      width: 90,
      align: 'right',
      render: (row) => <Cell muted={row.replayCount === 0}>{String(row.replayCount)}</Cell>,
    },
  ];

  return (
    <Panel title={t('metrics.queue.title')} description={t('metrics.queue.body')}>
      {queue.isPending ? <LoadingPanel count={1} /> : null}
      {queue.error ? <ApiStateNotice error={queue.error} /> : null}
      {queue.data ? (
        <>
          <DataTable
            columns={columns}
            rows={queue.data}
            keyOf={(row) => row.deliveryId}
            emptyTitle={t('metrics.queue.empty.title')}
            emptyDescription={t('metrics.queue.empty.body')}
          />
          {/* Replay is per-tenant and lives on the tenant's own webhooks screen: the
              cross-tenant queue is a read. Saying so here stops an operator looking
              for a button that is deliberately not on this screen. */}
          <Text className="text-xs leading-4 text-muted-foreground">
            {t('metrics.queue.replayElsewhere')}
          </Text>
        </>
      ) : null}
    </Panel>
  );
}

/**
 * Webhook endpoints, their delivery health, and the delivery log.
 *
 * This is the screen an integrator opens when decisions stopped arriving, so the
 * order is the order of that diagnosis: which endpoints exist and whether they are
 * still enabled, then how their deliveries are going, then the individual deliveries
 * — with the dead-letter filter one tap away, because §10.9's promise to the tenant
 * is an alert and a manual replay and this is where both land.
 *
 * ## Two things this screen deliberately does not do
 *
 * **It does not create or delete endpoints.** The console API exposes rotation and
 * nothing else; endpoints are managed through the application API with a
 * `crowdsource:webhooks:manage` credential. Offering a create form that had no
 * endpoint to call would be worse than its absence.
 *
 * **It does not show a delivery's body.** The delivery row carries the exact signed
 * bytes of the event; the server withholds them and the projection has no field for
 * them. What a diagnosis needs is the status, the attempt count, the last response
 * code and the reason it stopped, and all four are here.
 *
 * The rotated secret is a one-time value, handled exactly like an issued credential:
 * component state, shown once, never cached. `signingStartsAt` is surfaced beside it
 * because that instant is what makes the overlap a procedure — deploy the new secret
 * before it, and no delivery is ever signed with a key the receiver does not have.
 */

import { Button } from '@oxyhq/bloom/button';
import { toast } from '@oxyhq/bloom/toast';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from 'react-native';

import { ApiStateNotice, LoadingPanel } from '@/components/ApiStateNotice';
import { Cell, DataTable, IdentifierCell, type Column } from '@/components/data/DataTable';
import { FilterChips } from '@/components/data/FilterChips';
import { KeyValueList } from '@/components/data/KeyValueList';
import { OneTimeSecret } from '@/components/data/OneTimeSecret';
import { StatusPill } from '@/components/data/StatusPill';
import { Panel, Screen } from '@/components/Screen';
import { useRouteParam } from '@/hooks/useRouteParam';
import {
  deliveryStatusTone,
  endpointNeedsAttention,
  endpointStatusTone,
  formatOptionalText,
} from '@/lib/console-api/presentation';
import { canAdminister } from '@/lib/console-api/roles';
import {
  useApplication,
  useDeliveries,
  useReplayDelivery,
  useRotateSecret,
  useWebhookEndpoints,
} from '@/lib/console-api/queries';
import {
  DELIVERY_STATUSES,
  type RotatedSecret,
  type WebhookDelivery,
  type WebhookEndpoint,
} from '@/lib/console-api/types';
import { DEFAULT_SECRET_OVERLAP_SECONDS } from '@/lib/constants';

export default function WebhooksScreen() {
  const { t } = useTranslation();
  const applicationId = useRouteParam('applicationId');
  const application = useApplication(applicationId);
  const endpoints = useWebhookEndpoints(applicationId);
  const mayAdminister = application.data !== undefined && canAdminister(application.data.role);

  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [endpointFilter, setEndpointFilter] = useState<string | null>(null);
  const [rotated, setRotated] = useState<RotatedSecret | null>(null);

  const deliveries = useDeliveries(applicationId, {
    ...(statusFilter === null ? {} : { status: statusFilter }),
    ...(endpointFilter === null ? {} : { webhookEndpointId: endpointFilter }),
  });

  return (
    <Screen
      title={t('webhooks.title')}
      subtitle={
        <Text className="text-xs text-muted-foreground">
          {application.data?.name ?? t('webhooks.subtitle')}
        </Text>
      }
      toolbar={
        <>
          <FilterChips
            label={t('webhooks.deliveries.statusFilter')}
            selected={statusFilter}
            onSelect={setStatusFilter}
            options={[
              { value: null, label: t('common.all') },
              ...DELIVERY_STATUSES.map((status) => ({
                value: status,
                label: t(`deliveryStatus.${status}`),
              })),
            ]}
          />
          {/* Only offered when there is more than one endpoint: filtering a list of
              one is a control that cannot change the answer. */}
          {(endpoints.data?.length ?? 0) > 1 ? (
            <FilterChips
              label={t('webhooks.deliveries.endpointFilter')}
              selected={endpointFilter}
              onSelect={setEndpointFilter}
              options={[
                { value: null, label: t('common.all') },
                ...(endpoints.data ?? []).map((endpoint) => ({
                  value: endpoint.webhookEndpointId,
                  label: endpoint.url,
                })),
              ]}
            />
          ) : null}
        </>
      }
    >
      {rotated ? (
        <OneTimeSecret
          title={t('webhooks.rotated.title')}
          value={rotated.secret.value}
          valueLabel={t('webhooks.rotated.secretLabel')}
          onDismiss={() => setRotated(null)}
          details={
            <KeyValueList
              rows={[
                {
                  label: t('webhooks.rotated.version'),
                  value: String(rotated.secret.version),
                },
                {
                  label: t('webhooks.rotated.signingStartsAt'),
                  value: rotated.secret.signingStartsAt,
                  hint: t('webhooks.rotated.signingStartsAtHint'),
                },
                {
                  label: t('webhooks.rotated.previous'),
                  value:
                    rotated.previousSecret === null
                      ? null
                      : t('webhooks.rotated.previousValue', {
                          version: rotated.previousSecret.version,
                          expiresAt: rotated.previousSecret.expiresAt,
                        }),
                  hint:
                    rotated.previousSecret === null
                      ? t('webhooks.rotated.noPreviousHint')
                      : undefined,
                },
              ]}
            />
          }
        />
      ) : null}

      {endpoints.isPending ? <LoadingPanel count={2} /> : null}
      {endpoints.error ? <ApiStateNotice error={endpoints.error} /> : null}

      {endpoints.data?.length === 0 ? (
        <Panel title={t('webhooks.empty.title')} description={t('webhooks.empty.body')} />
      ) : null}

      {endpoints.data?.map((endpoint) => (
        <EndpointPanel
          key={endpoint.webhookEndpointId}
          applicationId={applicationId ?? ''}
          endpoint={endpoint}
          mayAdminister={mayAdminister}
          onRotated={setRotated}
        />
      ))}

      <Panel
        title={t('webhooks.deliveries.title')}
        description={t('webhooks.deliveries.description')}
      >
        {deliveries.isPending ? <LoadingPanel count={1} /> : null}
        {deliveries.error ? <ApiStateNotice error={deliveries.error} /> : null}
        {deliveries.data && applicationId ? (
          <DeliveriesTable
            applicationId={applicationId}
            deliveries={deliveries.data}
            mayAdminister={mayAdminister}
          />
        ) : null}
      </Panel>
    </Screen>
  );
}

function EndpointPanel({
  applicationId,
  endpoint,
  mayAdminister,
  onRotated,
}: {
  applicationId: string;
  endpoint: WebhookEndpoint;
  mayAdminister: boolean;
  onRotated: (rotated: RotatedSecret) => void;
}) {
  const { t } = useTranslation();
  const rotate = useRotateSecret(applicationId);

  return (
    <Panel
      title={endpoint.url}
      actions={
        <>
          <StatusPill
            label={t(`endpointStatus.${endpoint.status}`)}
            tone={endpointStatusTone(endpoint.status)}
          />
          {endpointNeedsAttention(endpoint.health) ? (
            <StatusPill
              label={t('webhooks.health.deadLetterFlag', { deadLetter: endpoint.health.deadLetter })}
              tone="danger"
            />
          ) : null}
          {mayAdminister ? (
            <Button
              variant="secondary"
              size="small"
              loading={rotate.isPending}
              onPress={() =>
                rotate.mutate(
                  {
                    webhookEndpointId: endpoint.webhookEndpointId,
                    overlapSeconds: DEFAULT_SECRET_OVERLAP_SECONDS,
                  },
                  {
                    onSuccess: onRotated,
                    onError: () => toast.error(t('webhooks.rotate.failed')),
                  },
                )
              }
            >
              {t('webhooks.rotate.action')}
            </Button>
          ) : null}
        </>
      }
    >
      {rotate.error ? <ApiStateNotice error={rotate.error} /> : null}

      <KeyValueList
        rows={[
          {
            label: t('webhooks.column.endpointId'),
            value: <IdentifierCell>{endpoint.webhookEndpointId}</IdentifierCell>,
          },
          {
            label: t('webhooks.column.eventTypes'),
            value: endpoint.eventTypes.length === 0 ? null : endpoint.eventTypes.join('\n'),
          },
          {
            label: t('webhooks.column.disabledReason'),
            // Only meaningful on a disabled endpoint. `gone` means the receiver
            // answered 410 and the delivery service stopped trying, which is a
            // different problem from an operator having switched it off.
            value:
              endpoint.status === 'active'
                ? null
                : t(`disabledReason.${endpoint.disabledReason ?? 'operator'}`),
            hint: endpoint.status === 'active' ? undefined : t('webhooks.disabledHint'),
          },
          {
            label: t('webhooks.health.title'),
            value: t('webhooks.health.summary', {
              pending: endpoint.health.pending,
              delivering: endpoint.health.delivering,
              succeeded: endpoint.health.succeeded,
              deadLetter: endpoint.health.deadLetter,
            }),
          },
          { label: t('webhooks.column.updatedAt'), value: endpoint.updatedAt },
        ]}
      />

      <Text className="text-xs leading-4 text-muted-foreground">{t('webhooks.rotate.hint')}</Text>
    </Panel>
  );
}

function DeliveriesTable({
  applicationId,
  deliveries,
  mayAdminister,
}: {
  applicationId: string;
  deliveries: WebhookDelivery[];
  mayAdminister: boolean;
}) {
  const { t } = useTranslation();
  const replay = useReplayDelivery(applicationId);

  const columns: Column<WebhookDelivery>[] = [
    {
      id: 'eventType',
      header: t('webhooks.deliveries.column.eventType'),
      flex: 2,
      render: (row) => <Cell>{row.eventType}</Cell>,
    },
    {
      id: 'status',
      header: t('webhooks.deliveries.column.status'),
      width: 120,
      render: (row) => (
        <StatusPill
          label={t(`deliveryStatus.${row.status}`)}
          tone={deliveryStatusTone(row.status)}
        />
      ),
    },
    {
      id: 'attempts',
      header: t('webhooks.deliveries.column.attempts'),
      width: 100,
      align: 'right',
      // Total attempts and attempts in the CURRENT retry cycle are different
      // numbers, and the pair is what says whether a delivery has been replayed.
      render: (row) => <Cell>{`${row.attemptCount} / ${row.cycleAttemptCount}`}</Cell>,
    },
    {
      id: 'lastResponse',
      header: t('webhooks.deliveries.column.lastResponse'),
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
      header: t('webhooks.deliveries.column.reason'),
      flex: 2,
      render: (row) => (
        <Cell muted={row.deadLetterReason === null}>
          {formatOptionalText(row.deadLetterReason)}
        </Cell>
      ),
    },
    {
      id: 'next',
      header: t('webhooks.deliveries.column.next'),
      width: 180,
      render: (row) => (
        <Cell muted>{formatOptionalText(row.nextAttemptAt ?? row.succeededAt)}</Cell>
      ),
    },
    {
      id: 'replays',
      header: t('webhooks.deliveries.column.replays'),
      width: 90,
      align: 'right',
      render: (row) => <Cell muted={row.replayCount === 0}>{String(row.replayCount)}</Cell>,
    },
    {
      id: 'replay',
      header: t('webhooks.deliveries.column.replay'),
      width: 110,
      align: 'right',
      // Only a dead-lettered delivery can be replayed; the API answers 409 for
      // anything else, so the control exists exactly where it can succeed.
      render: (row) =>
        mayAdminister && row.status === 'dead_letter' ? (
          <Button
            variant="secondary"
            size="small"
            loading={replay.isPending}
            onPress={() =>
              replay.mutate(
                { deliveryId: row.deliveryId },
                {
                  onSuccess: (updated) =>
                    toast.success(
                      t('webhooks.deliveries.replayed', {
                        status: t(`deliveryStatus.${updated.status}`),
                      }),
                    ),
                  onError: () => toast.error(t('webhooks.deliveries.replayFailed')),
                },
              )
            }
          >
            {t('webhooks.deliveries.replayAction')}
          </Button>
        ) : null,
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={deliveries}
      keyOf={(row) => row.deliveryId}
      emptyTitle={t('webhooks.deliveries.empty.title')}
      emptyDescription={t('webhooks.deliveries.empty.body')}
    />
  );
}

/**
 * Application trust, across every tenant — and the one control that moves it.
 *
 * ## This is a different authorization, not a bigger version of the same one
 *
 * Every other screen in this app is scoped to an organization the signed-in account
 * holds a seat in. This one reads across tenants, which is the whole point of the
 * surface and therefore the reason it is confined to a collection that is unscoped by
 * design (`app_trust_snapshots`) and to a projection that carries no case material.
 *
 * The navigation entry that leads here exists only for a session with a staff role,
 * and that is a COURTESY. The route behind it checks its own role and answers 403,
 * which is the boundary. `security` and `policy` can read this table; only `security`
 * can move a standing, so the control is offered to `security` alone and the API
 * refuses it for anyone else regardless.
 *
 * ## Why a standing change is a form and not a toggle
 *
 * Standing decides whether an application may ingest at all and whether its decisions
 * may ever move an Oxy Trust figure, and §11.13 puts a technical review, an identity
 * verification and a quality period behind the promotion. The reason is a code from a
 * closed vocabulary — never free text, because this row is kept indefinitely and
 * shown on an operator screen.
 *
 * `globalReputationEffectsAllowed` is a REQUEST. Asking for it at a standing that
 * forbids it is accepted and simply not granted: the server decides, and the row it
 * returns is the answer. So the screen reports what came back rather than what was
 * sent — presenting the request as if it had won is how an operator comes to believe
 * an application can move reputation when it cannot.
 */

import { Button } from '@oxyhq/bloom/button';
import { toast } from '@oxyhq/bloom/toast';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { ApiStateNotice, LoadingPanel } from '@/components/ApiStateNotice';
import { Cell, DataTable, IdentifierCell, type Column } from '@/components/data/DataTable';
import { FilterChips } from '@/components/data/FilterChips';
import { KeyValueList } from '@/components/data/KeyValueList';
import { StatusPill } from '@/components/data/StatusPill';
import { Panel, Screen } from '@/components/Screen';
import {
  formatOptionalNumber,
  formatOptionalText,
  formatRatio,
  standingTone,
} from '@/lib/console-api/presentation';
import { canOperateSecurity } from '@/lib/console-api/roles';
import {
  useConsoleSession,
  useSetStanding,
  useTrustSafetyApplications,
} from '@/lib/console-api/queries';
import {
  APPLICATION_STANDINGS,
  STANDING_REASONS,
  type ApplicationStanding,
  type StandingReason,
  type TrustSafetyApplication,
} from '@/lib/console-api/types';

export default function ApplicationTrustScreen() {
  const { t } = useTranslation();
  const session = useConsoleSession();
  const [standingFilter, setStandingFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<TrustSafetyApplication | null>(null);

  const applications = useTrustSafetyApplications(
    standingFilter === null ? {} : { standing: standingFilter },
  );
  const maySetStanding = canOperateSecurity(session.data?.staffRoles ?? []);

  const columns: Column<TrustSafetyApplication>[] = [
    {
      id: 'application',
      header: t('trustSafety.column.application'),
      flex: 2,
      // The name is nullable — a trust row can outlive the application document it
      // describes — so the id is the fallback rather than an empty cell.
      render: (row) =>
        row.applicationName === null ? (
          <IdentifierCell>{row.applicationId}</IdentifierCell>
        ) : (
          <Cell>{row.applicationName}</Cell>
        ),
    },
    {
      id: 'organization',
      header: t('trustSafety.column.organization'),
      flex: 2,
      render: (row) =>
        row.organizationName === null ? (
          <IdentifierCell>{row.organizationId}</IdentifierCell>
        ) : (
          <Cell>{row.organizationName}</Cell>
        ),
    },
    {
      id: 'standing',
      header: t('trustSafety.column.standing'),
      width: 120,
      render: (row) => (
        <StatusPill label={t(`standing.${row.standing}`)} tone={standingTone(row.standing)} />
      ),
    },
    {
      id: 'effects',
      header: t('trustSafety.column.globalEffects'),
      width: 130,
      render: (row) => (
        <Cell muted={!row.globalReputationEffectsAllowed}>
          {row.globalReputationEffectsAllowed ? t('common.yes') : t('common.no')}
        </Cell>
      ),
    },
    {
      id: 'evidenceIntegrity',
      header: t('trustSafety.column.evidenceIntegrity'),
      width: 130,
      align: 'right',
      // Absent, not zero. Nothing measures this yet.
      render: (row) => (
        <Cell muted={row.evidenceIntegrity === null}>
          {formatOptionalNumber(row.evidenceIntegrity, formatRatio)}
        </Cell>
      ),
    },
    {
      id: 'identityBinding',
      header: t('trustSafety.column.identityBinding'),
      width: 130,
      align: 'right',
      render: (row) => (
        <Cell muted={row.identityBindingReliability === null}>
          {formatOptionalNumber(row.identityBindingReliability, formatRatio)}
        </Cell>
      ),
    },
    {
      id: 'policyQuality',
      header: t('trustSafety.column.policyQuality'),
      width: 120,
      align: 'right',
      render: (row) => (
        <Cell muted={row.policyQuality === null}>
          {formatOptionalNumber(row.policyQuality, formatRatio)}
        </Cell>
      ),
    },
    {
      id: 'lastReason',
      header: t('trustSafety.column.lastReason'),
      flex: 2,
      render: (row) => (
        <Cell muted>
          {t(`standingReason.${row.lastStandingReason}`, {
            defaultValue: row.lastStandingReason,
          })}
        </Cell>
      ),
    },
    {
      id: 'changedAt',
      header: t('trustSafety.column.changedAt'),
      width: 180,
      render: (row) => <Cell muted>{formatOptionalText(row.standingChangedAt)}</Cell>,
    },
    {
      id: 'change',
      header: t('trustSafety.column.change'),
      width: 120,
      align: 'right',
      render: (row) =>
        maySetStanding ? (
          <Button variant="secondary" size="small" onPress={() => setSelected(row)}>
            {t('trustSafety.standing.action')}
          </Button>
        ) : null,
    },
  ];

  return (
    <Screen
      title={t('trustSafety.title')}
      subtitle={<Text className="text-xs text-muted-foreground">{t('trustSafety.subtitle')}</Text>}
      toolbar={
        <FilterChips
          label={t('trustSafety.column.standing')}
          selected={standingFilter}
          onSelect={setStandingFilter}
          options={[
            { value: null, label: t('common.all') },
            ...APPLICATION_STANDINGS.map((standing) => ({
              value: standing,
              label: t(`standing.${standing}`),
            })),
          ]}
        />
      }
    >
      {selected ? (
        <SetStandingForm application={selected} onDone={() => setSelected(null)} />
      ) : null}

      {applications.isPending ? <LoadingPanel count={2} /> : null}
      {applications.error ? <ApiStateNotice error={applications.error} /> : null}
      {applications.data ? (
        <DataTable
          columns={columns}
          rows={applications.data}
          keyOf={(row) => row.applicationId}
          emptyTitle={t('trustSafety.empty.title')}
          emptyDescription={t('trustSafety.empty.body')}
        />
      ) : null}

      {/* Said on the screen rather than left to be inferred from a table of dashes. */}
      <Panel title={t('trustSafety.signals.title')} description={t('trustSafety.signals.body')} />
    </Screen>
  );
}

function SetStandingForm({
  application,
  onDone,
}: {
  application: TrustSafetyApplication;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const setStanding = useSetStanding();
  const [standing, setStandingValue] = useState<ApplicationStanding>(application.standing);
  const [reason, setReason] = useState<StandingReason>('promotion_review_passed');
  const [requestEffects, setRequestEffects] = useState(application.globalReputationEffectsAllowed);

  const handleSubmit = useCallback(() => {
    setStanding.mutate(
      {
        applicationId: application.applicationId,
        input: { standing, reason, globalReputationEffectsAllowed: requestEffects },
      },
      {
        onSuccess: (row) => {
          // What the SERVER decided, not what was asked for. A request for global
          // effects at a standing that forbids them is accepted and not granted, and
          // the operator has to be told which of the two happened.
          toast.success(
            t('trustSafety.standing.done', {
              standing: t(`standing.${row.standing}`),
              effects: row.globalReputationEffectsAllowed ? t('common.yes') : t('common.no'),
            }),
          );
          onDone();
        },
      },
    );
  }, [application.applicationId, onDone, reason, requestEffects, setStanding, standing, t]);

  return (
    <Panel
      title={t('trustSafety.standing.title', {
        name: application.applicationName ?? application.applicationId,
      })}
      description={t('trustSafety.standing.description')}
    >
      <View className="gap-3">
        <KeyValueList
          rows={[
            {
              label: t('trustSafety.standing.current'),
              value: (
                <StatusPill
                  label={t(`standing.${application.standing}`)}
                  tone={standingTone(application.standing)}
                />
              ),
            },
            {
              label: t('trustSafety.column.application'),
              value: <IdentifierCell>{application.applicationId}</IdentifierCell>,
            },
          ]}
        />

        <FilterChips
          label={t('trustSafety.standing.newStanding')}
          selected={standing}
          onSelect={(value) => {
            // Narrowed through the vocabulary, not cast to it: this control decides
            // whether an application may ingest at all, and a value that is not a
            // standing must not reach the request.
            const next = APPLICATION_STANDINGS.find((candidate) => candidate === value);
            if (next !== undefined) {
              setStandingValue(next);
            }
          }}
          options={APPLICATION_STANDINGS.map((candidate) => ({
            value: candidate,
            label: t(`standing.${candidate}`),
          }))}
        />

        <FilterChips
          label={t('trustSafety.standing.reason')}
          selected={reason}
          onSelect={(value) => {
            const next = STANDING_REASONS.find((candidate) => candidate === value);
            if (next !== undefined) {
              setReason(next);
            }
          }}
          options={STANDING_REASONS.map((candidate) => ({
            value: candidate,
            label: t(`standingReason.${candidate}`),
          }))}
        />

        <FilterChips
          label={t('trustSafety.standing.effects')}
          selected={requestEffects ? 'yes' : 'no'}
          onSelect={(value) => setRequestEffects(value === 'yes')}
          options={[
            { value: 'no', label: t('common.no') },
            { value: 'yes', label: t('common.yes') },
          ]}
        />
        <Text className="text-xs leading-4 text-muted-foreground">
          {t('trustSafety.standing.effectsHint')}
        </Text>

        {setStanding.error ? <ApiStateNotice error={setStanding.error} /> : null}

        <View className="flex-row justify-end gap-2">
          <Button variant="secondary" size="small" onPress={onDone}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            size="small"
            disabled={setStanding.isPending}
            loading={setStanding.isPending}
            onPress={handleSubmit}
          >
            {t('trustSafety.standing.submit')}
          </Button>
        </View>
      </View>
    </Panel>
  );
}

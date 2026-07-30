/**
 * The tenant's own audit trail.
 *
 * Every effect in the system is meant to be explainable, and this is where an
 * integrator reads the explanation for their own application: which action happened,
 * which of THEIR credentials did it, which report and case it touched, and when.
 *
 * `actorCredentialId` is the only actor a row carries, and that is the design. An
 * ingestion or an appeal reaches the API as a service credential, so naming the
 * credential names the integrator's own component; a row would never carry a
 * reviewer or a reporter, because neither acts through this surface and neither has a
 * field in the projected type.
 *
 * `reason` is a CODE from a closed vocabulary rather than free text, for the same
 * reason the server refuses free text on a standing change: this record is kept
 * indefinitely, and a free field beside a case is where a fragment of reported
 * material eventually lands. It is rendered verbatim because the vocabulary belongs
 * to the modules that write it, and inventing a translation for each would put this
 * screen's copy out of step with them.
 */

import { TextField, TextFieldInput, TextFieldLabel } from '@oxyhq/bloom/text-field';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { ApiStateNotice, LoadingPanel } from '@/components/ApiStateNotice';
import { Cell, DataTable, IdentifierCell, type Column } from '@/components/data/DataTable';
import { Panel, Screen } from '@/components/Screen';
import { useRouteParam } from '@/hooks/useRouteParam';
import { formatOptionalText } from '@/lib/console-api/presentation';
import { useApplication, useAuditTrail } from '@/lib/console-api/queries';
import type { AuditEvent } from '@/lib/console-api/types';

export default function AuditScreen() {
  const { t } = useTranslation();
  const applicationId = useRouteParam('applicationId');
  const application = useApplication(applicationId);

  // The API filters by case id server-side. Held as its own state and trimmed at
  // the edge: a stray space would reach the endpoint as an id that cannot exist and
  // come back as an empty trail, which reads as "nothing happened".
  const [caseFilter, setCaseFilter] = useState('');
  const trimmedCaseFilter = caseFilter.trim();

  const events = useAuditTrail(
    applicationId,
    trimmedCaseFilter === '' ? {} : { caseId: trimmedCaseFilter },
  );

  const columns: Column<AuditEvent>[] = [
    {
      id: 'occurredAt',
      header: t('audit.column.occurredAt'),
      width: 180,
      render: (row) => <Cell>{row.occurredAt}</Cell>,
    },
    {
      id: 'action',
      header: t('audit.column.action'),
      flex: 2,
      render: (row) => <Cell>{row.action}</Cell>,
    },
    {
      id: 'actor',
      header: t('audit.column.actor'),
      flex: 2,
      render: (row) =>
        row.actorCredentialId === null ? (
          <Cell muted>{t('audit.noCredential')}</Cell>
        ) : (
          <IdentifierCell>{row.actorCredentialId}</IdentifierCell>
        ),
    },
    {
      id: 'caseId',
      header: t('audit.column.caseId'),
      flex: 2,
      render: (row) =>
        row.caseId === null ? (
          <Cell muted>{t('common.absent')}</Cell>
        ) : (
          <IdentifierCell>{row.caseId}</IdentifierCell>
        ),
    },
    {
      id: 'externalReportId',
      header: t('audit.column.externalReportId'),
      flex: 2,
      render: (row) =>
        row.externalReportId === null ? (
          <Cell muted>{t('common.absent')}</Cell>
        ) : (
          <IdentifierCell>{row.externalReportId}</IdentifierCell>
        ),
    },
    {
      id: 'reason',
      header: t('audit.column.reason'),
      flex: 2,
      render: (row) => <Cell muted={row.reason === null}>{formatOptionalText(row.reason)}</Cell>,
    },
  ];

  return (
    <Screen
      title={t('audit.title')}
      subtitle={
        <Text className="text-xs text-muted-foreground">
          {application.data?.name ?? t('audit.subtitle')}
        </Text>
      }
    >
      <Panel title={t('audit.filter.title')} description={t('audit.filter.description')}>
        <View className="gap-1">
          <TextFieldLabel>{t('audit.filter.caseLabel')}</TextFieldLabel>
          <TextField>
            <TextFieldInput
              label={t('audit.filter.caseLabel')}
              value={caseFilter}
              onChangeText={setCaseFilter}
              autoCapitalize="none"
            />
          </TextField>
        </View>
      </Panel>

      {events.isPending ? <LoadingPanel count={1} /> : null}
      {events.error ? <ApiStateNotice error={events.error} /> : null}
      {events.data ? (
        <DataTable
          columns={columns}
          rows={events.data}
          keyOf={(row) => row.auditId}
          emptyTitle={t('audit.empty.title')}
          emptyDescription={
            trimmedCaseFilter === '' ? t('audit.empty.body') : t('audit.empty.filtered')
          }
        />
      ) : null}
    </Screen>
  );
}

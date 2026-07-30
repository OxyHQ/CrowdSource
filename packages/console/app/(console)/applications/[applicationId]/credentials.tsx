/**
 * Service credentials: issue, revoke, and show a token exactly once.
 *
 * A credential is what makes `applicationId` a property of the CALLER rather than a
 * field in a request — the key an integrator configures is
 * `applicationId:credentialId:secret`, so the client knows its own application
 * without being told and cannot claim another. That is why this screen never asks
 * for an application id and why the scope list is the whole of the form: the scopes
 * are the only decision to make.
 *
 * The token appears in the issuing response and nowhere else, ever. Only its
 * SHA-256 is stored, so nothing — including the service — can recover it. The
 * screen therefore holds it in component state, presents it as a one-time secret,
 * and drops it on dismissal; it is never written to the query cache, to storage or
 * to a log. There is no "reveal" control and there cannot be one.
 *
 * The eight grantable scopes are the whole list the API accepts. Privileged scopes
 * (`crowdsource:decisions:emit`, `reputation:moderation:apply`,
 * `crowdsource:trust-safety:operate`) are not among them and are not self-grantable
 * at any role — the enum in the request schema rejects them before the domain does.
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
import { OneTimeSecret } from '@/components/data/OneTimeSecret';
import { StatusPill } from '@/components/data/StatusPill';
import { Panel, Screen } from '@/components/Screen';
import { useRouteParam } from '@/hooks/useRouteParam';
import { credentialStatusTone } from '@/lib/console-api/presentation';
import { canAdminister } from '@/lib/console-api/roles';
import {
  useApplication,
  useCredentials,
  useIssueCredential,
  useRevokeCredential,
} from '@/lib/console-api/queries';
import {
  APPLICATION_SCOPES,
  type ApplicationScope,
  type IssuedCredential,
  type ServiceCredential,
} from '@/lib/console-api/types';
import { cn } from '@/lib/utils';

export default function CredentialsScreen() {
  const { t } = useTranslation();
  const applicationId = useRouteParam('applicationId');
  const application = useApplication(applicationId);
  const credentials = useCredentials(applicationId);
  const mayAdminister = application.data !== undefined && canAdminister(application.data.role);

  const [isIssuing, setIsIssuing] = useState(false);
  // The one-time token, held for this sitting only. Component state and not the
  // query cache: a cached one-time secret is a secret that reappears on remount.
  const [issued, setIssued] = useState<IssuedCredential | null>(null);

  return (
    <Screen
      title={t('credentials.title')}
      subtitle={
        <Text className="text-xs text-muted-foreground">
          {application.data?.name ?? t('credentials.subtitle')}
        </Text>
      }
      actions={
        mayAdminister ? (
          <Button variant="primary" size="small" onPress={() => setIsIssuing((open) => !open)}>
            {t('credentials.issue.action')}
          </Button>
        ) : null
      }
    >
      {issued ? (
        <OneTimeSecret
          title={t('credentials.issued.title')}
          value={issued.token}
          valueLabel={t('credentials.issued.tokenLabel')}
          onDismiss={() => setIssued(null)}
          details={
            <KeyValueList
              rows={[
                { label: t('credentials.column.id'), value: issued.credentialId },
                { label: t('credentials.column.scopes'), value: issued.scopes.join('\n') },
              ]}
            />
          }
        />
      ) : null}

      {isIssuing && applicationId ? (
        <IssueCredentialForm
          applicationId={applicationId}
          onIssued={(credential) => {
            setIssued(credential);
            setIsIssuing(false);
          }}
          onCancel={() => setIsIssuing(false)}
        />
      ) : null}

      {credentials.isPending ? <LoadingPanel count={1} /> : null}
      {credentials.error ? <ApiStateNotice error={credentials.error} /> : null}
      {credentials.data && applicationId ? (
        <CredentialsTable
          applicationId={applicationId}
          credentials={credentials.data}
          mayAdminister={mayAdminister}
        />
      ) : null}

      <Panel title={t('credentials.privileged.title')} description={t('credentials.privileged.body')} />
    </Screen>
  );
}

function CredentialsTable({
  applicationId,
  credentials,
  mayAdminister,
}: {
  applicationId: string;
  credentials: ServiceCredential[];
  mayAdminister: boolean;
}) {
  const { t } = useTranslation();
  const revoke = useRevokeCredential(applicationId);

  const columns: Column<ServiceCredential>[] = [
    {
      id: 'credentialId',
      header: t('credentials.column.id'),
      flex: 2,
      render: (row) => <IdentifierCell>{row.credentialId}</IdentifierCell>,
    },
    {
      id: 'scopes',
      header: t('credentials.column.scopes'),
      flex: 3,
      // The full list, not a count: which scopes a key carries is the only thing
      // that distinguishes two keys, and "4 scopes" tells an operator nothing.
      render: (row) => <Cell>{row.scopes.join(', ')}</Cell>,
    },
    {
      id: 'status',
      header: t('credentials.column.status'),
      width: 110,
      render: (row) => (
        <StatusPill
          label={t(`credentialStatus.${row.status}`)}
          tone={credentialStatusTone(row.status)}
        />
      ),
    },
    {
      id: 'expiresAt',
      header: t('credentials.column.expires'),
      width: 180,
      render: (row) =>
        row.expiresAt === null ? (
          <Cell muted>{t('credentials.neverExpires')}</Cell>
        ) : (
          <Cell>{row.expiresAt}</Cell>
        ),
    },
    {
      id: 'createdAt',
      header: t('credentials.column.created'),
      width: 180,
      render: (row) => <Cell muted>{row.createdAt}</Cell>,
    },
    {
      id: 'revoke',
      header: t('credentials.column.revoke'),
      width: 110,
      align: 'right',
      render: (row) =>
        mayAdminister && row.status === 'active' ? (
          <Button
            variant="destructive"
            size="small"
            loading={revoke.isPending}
            onPress={() =>
              revoke.mutate(
                { credentialId: row.credentialId },
                { onSuccess: () => toast.success(t('credentials.revoke.done')) },
              )
            }
          >
            {t('credentials.revoke.action')}
          </Button>
        ) : null,
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={credentials}
      keyOf={(row) => row.credentialId}
      emptyTitle={t('credentials.empty.title')}
      emptyDescription={t('credentials.empty.body')}
    />
  );
}

/**
 * Lifetimes the form offers, in days.
 *
 * A closed set rather than a free-text field. The API accepts 1..3650, but the
 * decision an integrator is actually making is "does this key rotate", and a text
 * box invites a typo that produces a credential expiring tomorrow or in nine years.
 * `null` is the API's own default: no expiry.
 */
const CREDENTIAL_LIFETIMES: readonly (number | null)[] = [null, 30, 90, 365];

function IssueCredentialForm({
  applicationId,
  onIssued,
  onCancel,
}: {
  applicationId: string;
  onIssued: (credential: IssuedCredential) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const issue = useIssueCredential(applicationId);
  const [scopes, setScopes] = useState<ApplicationScope[]>([]);
  const [expiresInDays, setExpiresInDays] = useState<number | null>(null);

  const toggleScope = useCallback((scope: ApplicationScope) => {
    setScopes((current) =>
      current.includes(scope) ? current.filter((held) => held !== scope) : [...current, scope],
    );
  }, []);

  const handleSubmit = useCallback(() => {
    // The field is OMITTED rather than sent as null when there is no expiry: the
    // request schema is strict, and an explicit null is not the same as absent.
    issue.mutate(
      expiresInDays === null ? { scopes } : { scopes, expiresInDays },
      { onSuccess: onIssued },
    );
  }, [expiresInDays, issue, onIssued, scopes]);

  return (
    <Panel title={t('credentials.issue.title')} description={t('credentials.issue.description')}>
      <View className="gap-3">
        <Text className="text-xs uppercase tracking-wide text-muted-foreground">
          {t('credentials.issue.scopesLabel')}
        </Text>
        {/* Multi-select, unlike every other chip row in the app, because the API
            takes an array here and a credential with one scope is the exception
            rather than the rule. */}
        <View className="flex-row flex-wrap gap-2">
          {APPLICATION_SCOPES.map((scope) => {
            const isSelected = scopes.includes(scope);
            return (
              <Button
                key={scope}
                variant={isSelected ? 'primary' : 'secondary'}
                size="small"
                onPress={() => toggleScope(scope)}
                accessibilityLabel={scope}
              >
                {scope}
              </Button>
            );
          })}
        </View>
        <Text className={cn('text-xs leading-4', scopes.length === 0 ? 'text-muted-foreground' : 'text-foreground')}>
          {t('credentials.issue.scopesHint')}
        </Text>

        <FilterChips
          label={t('credentials.issue.lifetimeLabel')}
          selected={expiresInDays === null ? null : String(expiresInDays)}
          onSelect={(value) => setExpiresInDays(value === null ? null : Number(value))}
          options={CREDENTIAL_LIFETIMES.map((days) => ({
            value: days === null ? null : String(days),
            label: days === null ? t('credentials.neverExpires') : t('credentials.days', { days }),
          }))}
        />

        {issue.error ? <ApiStateNotice error={issue.error} /> : null}

        <View className="flex-row justify-end gap-2">
          <Button variant="secondary" size="small" onPress={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            size="small"
            // The API requires at least one scope; a request with none is a 400,
            // so the control says so rather than sending it.
            disabled={scopes.length === 0 || issue.isPending}
            loading={issue.isPending}
            onPress={handleSubmit}
          >
            {t('credentials.issue.submit')}
          </Button>
        </View>
      </View>
    </Panel>
  );
}

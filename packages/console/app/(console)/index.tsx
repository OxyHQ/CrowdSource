/**
 * Organizations and their applications — the console's front door.
 *
 * Everything else in the app is reached from a row on this screen, because an
 * application id is the handle for every other route and this is the only place one
 * is discovered. There is deliberately no way to reach an application by typing an
 * id you were not already shown: `GET /v1/console/organizations` returns the
 * organizations this session holds a seat in and nothing else, and there is no
 * "list all organizations" route to add one to.
 *
 * The create forms are inline panels rather than dialogs. Creating an organization
 * and creating an application are the two things a new integrator does first, in
 * order, and a modal that has to be dismissed between them puts a click between two
 * halves of one task.
 */

import { Button } from '@oxyhq/bloom/button';
import { TextField, TextFieldInput, TextFieldLabel } from '@oxyhq/bloom/text-field';
import { toast } from '@oxyhq/bloom/toast';
import { useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { ApiStateNotice, LoadingPanel } from '@/components/ApiStateNotice';
import { Cell, DataTable, IdentifierCell, type Column } from '@/components/data/DataTable';
import { StatusPill } from '@/components/data/StatusPill';
import { Panel, Screen } from '@/components/Screen';
import { standingTone } from '@/lib/console-api/presentation';
import { canAdminister } from '@/lib/console-api/roles';
import {
  useApplications,
  useCreateApplication,
  useCreateOrganization,
  useOrganizations,
} from '@/lib/console-api/queries';
import {
  ORGANIZATION_SLUG_PATTERN,
  type ApplicationSummary,
  type OrganizationSummary,
} from '@/lib/console-api/types';

export default function OrganizationsScreen() {
  const { t } = useTranslation();
  const organizations = useOrganizations();
  const [isCreating, setIsCreating] = useState(false);

  return (
    <Screen
      title={t('organizations.title')}
      subtitle={
        <Text className="text-xs text-muted-foreground">{t('organizations.subtitle')}</Text>
      }
      actions={
        <Button variant="primary" size="small" onPress={() => setIsCreating((open) => !open)}>
          {t('organizations.create.action')}
        </Button>
      }
    >
      {isCreating ? <CreateOrganizationForm onDone={() => setIsCreating(false)} /> : null}

      {organizations.isPending ? <LoadingPanel count={2} /> : null}
      {organizations.error ? <ApiStateNotice error={organizations.error} /> : null}

      {organizations.data?.length === 0 ? (
        <Panel title={t('organizations.empty.title')} description={t('organizations.empty.body')} />
      ) : null}

      {organizations.data?.map((organization) => (
        <OrganizationPanel key={organization.organizationId} organization={organization} />
      ))}
    </Screen>
  );
}

function CreateOrganizationForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const create = useCreateOrganization();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');

  // Normalized the way the server normalizes it before validating, or a perfectly
  // acceptable "My Org" would be rejected here and accepted there.
  const normalizedSlug = slug.trim().toLowerCase();
  const isSlugValid = ORGANIZATION_SLUG_PATTERN.test(normalizedSlug);
  const canSubmit = name.trim() !== '' && isSlugValid && !create.isPending;

  const handleSubmit = useCallback(() => {
    create.mutate(
      { name: name.trim(), slug: normalizedSlug },
      {
        onSuccess: (organization) => {
          toast.success(t('organizations.create.created', { name: organization.name }));
          onDone();
        },
      },
    );
  }, [create, name, normalizedSlug, onDone, t]);

  return (
    <Panel
      title={t('organizations.create.title')}
      description={t('organizations.create.description')}
    >
      <View className="gap-3">
        <View className="gap-1">
          <TextFieldLabel>{t('organizations.create.nameLabel')}</TextFieldLabel>
          <TextField>
            <TextFieldInput
              label={t('organizations.create.nameLabel')}
              value={name}
              onChangeText={setName}
            />
          </TextField>
        </View>

        <View className="gap-1">
          <TextFieldLabel>{t('organizations.create.slugLabel')}</TextFieldLabel>
          <TextField isInvalid={slug !== '' && !isSlugValid}>
            <TextFieldInput
              label={t('organizations.create.slugLabel')}
              value={slug}
              onChangeText={setSlug}
              autoCapitalize="none"
            />
          </TextField>
          <Text
            className={
              slug !== '' && !isSlugValid
                ? 'text-xs text-destructive'
                : 'text-xs text-muted-foreground'
            }
          >
            {t('organizations.create.slugHint')}
          </Text>
        </View>

        {create.error ? <ApiStateNotice error={create.error} /> : null}

        <View className="flex-row justify-end gap-2">
          <Button variant="secondary" size="small" onPress={onDone}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            size="small"
            disabled={!canSubmit}
            loading={create.isPending}
            onPress={handleSubmit}
          >
            {t('organizations.create.submit')}
          </Button>
        </View>
      </View>
    </Panel>
  );
}

function OrganizationPanel({ organization }: { organization: OrganizationSummary }) {
  const { t } = useTranslation();
  const router = useRouter();
  const applications = useApplications(organization.organizationId);
  const [isCreating, setIsCreating] = useState(false);
  const mayAdminister = canAdminister(organization.role);

  const columns: Column<ApplicationSummary>[] = [
    {
      id: 'name',
      header: t('applications.column.name'),
      flex: 2,
      render: (row) => <Cell>{row.name}</Cell>,
    },
    {
      id: 'applicationId',
      header: t('applications.column.id'),
      flex: 2,
      render: (row) => <IdentifierCell>{row.applicationId}</IdentifierCell>,
    },
    {
      id: 'standing',
      header: t('applications.column.standing'),
      width: 120,
      render: (row) => (
        <StatusPill label={t(`standing.${row.standing}`)} tone={standingTone(row.standing)} />
      ),
    },
    {
      id: 'effects',
      header: t('applications.column.globalEffects'),
      width: 130,
      render: (row) => (
        <Cell muted={!row.globalReputationEffectsAllowed}>
          {row.globalReputationEffectsAllowed ? t('common.yes') : t('common.no')}
        </Cell>
      ),
    },
    {
      id: 'open',
      header: t('applications.column.open'),
      width: 100,
      align: 'right',
      render: (row) => (
        <Button
          variant="secondary"
          size="small"
          onPress={() => router.navigate(`/applications/${encodeURIComponent(row.applicationId)}`)}
        >
          {t('common.open')}
        </Button>
      ),
    },
  ];

  return (
    <Panel
      title={organization.name}
      description={t('organizations.meta', {
        slug: organization.slug,
        applicationCount: organization.applicationCount,
      })}
      actions={
        <>
          <StatusPill
            label={t(`role.${organization.role}`)}
            tone={mayAdminister ? 'info' : 'neutral'}
          />
          {organization.status === 'suspended' ? (
            <StatusPill label={t('organizations.suspended')} tone="danger" />
          ) : null}
          <Button
            variant="secondary"
            size="small"
            onPress={() =>
              router.navigate(
                `/organizations/${encodeURIComponent(organization.organizationId)}/members`,
              )
            }
          >
            {t('organizations.members')}
          </Button>
          {/* Absent rather than disabled for a viewer or developer seat: the API
              answers 403, and a control that only ever fails is worse than one that
              is not offered. */}
          {mayAdminister ? (
            <Button variant="primary" size="small" onPress={() => setIsCreating((open) => !open)}>
              {t('applications.create.action')}
            </Button>
          ) : null}
        </>
      }
    >
      {isCreating ? (
        <CreateApplicationForm
          organizationId={organization.organizationId}
          onDone={() => setIsCreating(false)}
        />
      ) : null}

      {applications.isPending ? <LoadingPanel count={1} /> : null}
      {applications.error ? <ApiStateNotice error={applications.error} /> : null}
      {applications.data ? (
        <DataTable
          columns={columns}
          rows={applications.data}
          keyOf={(row) => row.applicationId}
          emptyTitle={t('applications.empty.title')}
          emptyDescription={t('applications.empty.body')}
        />
      ) : null}
    </Panel>
  );
}

function CreateApplicationForm({
  organizationId,
  onDone,
}: {
  organizationId: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const create = useCreateApplication(organizationId);
  const [name, setName] = useState('');

  const handleSubmit = useCallback(() => {
    create.mutate(
      { name: name.trim() },
      {
        onSuccess: (application) => {
          // The standing is stated on creation rather than left to be discovered
          // from a 403 later: every application starts in sandbox (§11.13).
          toast.success(
            t('applications.create.created', {
              name: application.name,
              standing: t(`standing.${application.standing}`),
            }),
          );
          onDone();
        },
      },
    );
  }, [create, name, onDone, t]);

  return (
    <View className="gap-3 rounded-md bg-muted p-3">
      <Text className="text-sm font-semibold text-foreground">
        {t('applications.create.title')}
      </Text>
      <Text className="text-xs leading-4 text-muted-foreground">
        {t('applications.create.description')}
      </Text>
      <TextField>
        <TextFieldInput
          label={t('applications.create.nameLabel')}
          value={name}
          onChangeText={setName}
        />
      </TextField>

      {create.error ? <ApiStateNotice error={create.error} /> : null}

      <View className="flex-row justify-end gap-2">
        <Button variant="secondary" size="small" onPress={onDone}>
          {t('common.cancel')}
        </Button>
        <Button
          variant="primary"
          size="small"
          disabled={name.trim() === '' || create.isPending}
          loading={create.isPending}
          onPress={handleSubmit}
        >
          {t('applications.create.submit')}
        </Button>
      </View>
    </View>
  );
}

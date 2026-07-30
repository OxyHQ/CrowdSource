/**
 * Who holds a seat in this organization, and at what role.
 *
 * The one screen in the console that shows an identity, and the identity it shows is
 * an Oxy user id — the same value an admin typed to grant the seat. There is no
 * lookup, no display name and no avatar: the API takes `oxyUserId` as an opaque
 * string and deliberately does not resolve it against Oxy, because a console that
 * could resolve an id would be a console that can enumerate Oxy accounts by probing
 * which ones an invitation accepts.
 *
 * Two behaviours of the API shape this screen and are stated in its copy rather than
 * left to be discovered:
 *
 *  - re-granting an existing member CHANGES their role, and revives a revoked seat,
 *    so there is one form for both and no separate "edit role" control;
 *  - revoking the LAST owner is a 409, because an organization with no owner is
 *    unreachable through every other route.
 */

import { Button } from '@oxyhq/bloom/button';
import { TextField, TextFieldInput, TextFieldLabel } from '@oxyhq/bloom/text-field';
import { toast } from '@oxyhq/bloom/toast';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { ApiStateNotice, LoadingPanel } from '@/components/ApiStateNotice';
import { Cell, DataTable, IdentifierCell, type Column } from '@/components/data/DataTable';
import { FilterChips } from '@/components/data/FilterChips';
import { StatusPill } from '@/components/data/StatusPill';
import { Panel, Screen } from '@/components/Screen';
import { useRouteParam } from '@/hooks/useRouteParam';
import { canAdminister } from '@/lib/console-api/roles';
import {
  useGrantMember,
  useOrganizationMembers,
  useOrganizations,
  useRevokeMember,
} from '@/lib/console-api/queries';
import { CONSOLE_ROLES, type ConsoleRole, type OrganizationMember } from '@/lib/console-api/types';

export default function MembersScreen() {
  const { t } = useTranslation();
  const organizationId = useRouteParam('organizationId');
  const members = useOrganizationMembers(organizationId);
  const organizations = useOrganizations();
  const [isGranting, setIsGranting] = useState(false);

  // The viewer's own seat in THIS organization, from the list they can already see.
  // Not a second request: the organizations query is the boot-adjacent one every
  // screen shares.
  const seat = organizations.data?.find(
    (organization) => organization.organizationId === organizationId,
  );
  const mayAdminister = seat !== undefined && canAdminister(seat.role);

  return (
    <Screen
      title={t('members.title')}
      subtitle={
        <Text className="text-xs text-muted-foreground">
          {seat ? seat.name : t('members.subtitle')}
        </Text>
      }
      actions={
        mayAdminister ? (
          <Button variant="primary" size="small" onPress={() => setIsGranting((open) => !open)}>
            {t('members.grant.action')}
          </Button>
        ) : null
      }
    >
      {isGranting && organizationId ? (
        <GrantMemberForm organizationId={organizationId} onDone={() => setIsGranting(false)} />
      ) : null}

      {members.isPending ? <LoadingPanel count={1} /> : null}
      {members.error ? <ApiStateNotice error={members.error} /> : null}

      {members.data && organizationId ? (
        <MembersTable
          organizationId={organizationId}
          members={members.data}
          mayAdminister={mayAdminister}
        />
      ) : null}

      <Panel title={t('members.roles.title')} description={t('members.roles.body')} />
    </Screen>
  );
}

function MembersTable({
  organizationId,
  members,
  mayAdminister,
}: {
  organizationId: string;
  members: OrganizationMember[];
  mayAdminister: boolean;
}) {
  const { t } = useTranslation();
  const revoke = useRevokeMember(organizationId);
  const [statusFilter, setStatusFilter] = useState<string | null>('active');

  // Filtered client-side, and it is the one filter in the app that is: the members
  // endpoint returns every seat including revoked ones in a single response, so
  // there is no server-side filter to defer to and no page after this one.
  const rows = members.filter(
    (member) => statusFilter === null || member.status === statusFilter,
  );

  const columns: Column<OrganizationMember>[] = [
    {
      id: 'oxyUserId',
      header: t('members.column.account'),
      flex: 2,
      render: (row) => <IdentifierCell>{row.oxyUserId}</IdentifierCell>,
    },
    {
      id: 'role',
      header: t('members.column.role'),
      width: 110,
      render: (row) => <StatusPill label={t(`role.${row.role}`)} tone="info" />,
    },
    {
      id: 'status',
      header: t('members.column.status'),
      width: 110,
      render: (row) => (
        <StatusPill
          label={t(`memberStatus.${row.status}`)}
          tone={row.status === 'active' ? 'positive' : 'neutral'}
        />
      ),
    },
    {
      id: 'invitedBy',
      header: t('members.column.invitedBy'),
      flex: 2,
      render: (row) =>
        row.invitedByOxyUserId === null ? (
          <Cell muted>{t('common.absent')}</Cell>
        ) : (
          <IdentifierCell>{row.invitedByOxyUserId}</IdentifierCell>
        ),
    },
    {
      id: 'createdAt',
      header: t('members.column.since'),
      width: 180,
      render: (row) => <Cell muted>{row.createdAt}</Cell>,
    },
    {
      id: 'revoke',
      header: t('members.column.revoke'),
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
                { oxyUserId: row.oxyUserId },
                {
                  onSuccess: () => toast.success(t('members.revoke.done')),
                  // A 409 here means exactly one thing, and saying which is the
                  // difference between a message an admin can act on and one that
                  // sends them to support.
                  onError: () => toast.error(t('members.revoke.lastOwner')),
                },
              )
            }
          >
            {t('members.revoke.action')}
          </Button>
        ) : null,
    },
  ];

  return (
    <View className="gap-3">
      <FilterChips
        label={t('members.column.status')}
        selected={statusFilter}
        onSelect={setStatusFilter}
        options={[
          { value: 'active', label: t('memberStatus.active') },
          { value: 'revoked', label: t('memberStatus.revoked') },
          { value: null, label: t('common.all') },
        ]}
      />
      <DataTable
        columns={columns}
        rows={rows}
        keyOf={(row) => row.oxyUserId}
        emptyTitle={t('members.empty.title')}
        emptyDescription={t('members.empty.body')}
      />
    </View>
  );
}

function GrantMemberForm({
  organizationId,
  onDone,
}: {
  organizationId: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const grant = useGrantMember(organizationId);
  const [oxyUserId, setOxyUserId] = useState('');
  const [role, setRole] = useState<ConsoleRole>('developer');

  const handleSubmit = useCallback(() => {
    grant.mutate(
      { oxyUserId: oxyUserId.trim(), role },
      {
        onSuccess: () => {
          toast.success(t('members.grant.done'));
          onDone();
        },
      },
    );
  }, [grant, onDone, oxyUserId, role, t]);

  return (
    <Panel title={t('members.grant.title')} description={t('members.grant.description')}>
      <View className="gap-3">
        <View className="gap-1">
          <TextFieldLabel>{t('members.grant.accountLabel')}</TextFieldLabel>
          <TextField>
            <TextFieldInput
              label={t('members.grant.accountLabel')}
              value={oxyUserId}
              onChangeText={setOxyUserId}
              autoCapitalize="none"
            />
          </TextField>
          <Text className="text-xs text-muted-foreground">{t('members.grant.accountHint')}</Text>
        </View>

        <FilterChips
          label={t('members.column.role')}
          selected={role}
          onSelect={(value) => {
            // Narrowed by looking the value up in the vocabulary rather than cast to
            // it. The chips are built from that same array, so the lookup always
            // succeeds — but a `null` selection has no meaning for a role, and a cast
            // would let a future option that is not a role through silently.
            const next = CONSOLE_ROLES.find((candidate) => candidate === value);
            if (next !== undefined) {
              setRole(next);
            }
          }}
          options={CONSOLE_ROLES.map((candidate) => ({
            value: candidate,
            label: t(`role.${candidate}`),
          }))}
        />
        <Text className="text-xs leading-4 text-muted-foreground">{t('members.roles.body')}</Text>

        {grant.error ? <ApiStateNotice error={grant.error} /> : null}

        <View className="flex-row justify-end gap-2">
          <Button variant="secondary" size="small" onPress={onDone}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            size="small"
            disabled={oxyUserId.trim() === '' || grant.isPending}
            loading={grant.isPending}
            onPress={handleSubmit}
          >
            {t('members.grant.submit')}
          </Button>
        </View>
      </View>
    </Panel>
  );
}

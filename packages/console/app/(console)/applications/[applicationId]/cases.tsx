/**
 * The case explorer: this tenant's own cases, newest first.
 *
 * "This tenant's own" is the whole security story and it is not enforced here. The
 * path names an application; the server reads `organizationId` off the STORED
 * application row, requires an active membership for the authenticated Oxy account,
 * and only then builds a tenant context. A 404 means "not yours or not there" and
 * the two are deliberately indistinguishable — a console that resolved which would
 * be a tenant-enumeration oracle.
 *
 * ## Paging is a cursor, and an unknown cursor is an error
 *
 * The API pages by keyset and REFUSES a cursor it did not issue rather than silently
 * restarting from the top, because a silently-restarting cursor makes a paging client
 * loop over the first page forever. So the cursor is held as a stack of pages
 * visited: "next" pushes the cursor the server returned, "back" pops to a cursor that
 * is already in the cache. Nothing here composes a cursor.
 *
 * ## What a row shows, and what it cannot
 *
 * A row carries the subject, the policy version it was decided under, the allegation
 * codes, a report COUNT and the outcome in force. It cannot carry a reporter, a
 * reviewer, a juror or the reported content: none of those has a field in the
 * projected type, and `reportCount` is what the tenant gets instead of the
 * fingerprints it was counted from.
 */

import { Button } from '@oxyhq/bloom/button';
import { useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { ApiStateNotice, LoadingPanel } from '@/components/ApiStateNotice';
import { Cell, DataTable, IdentifierCell, type Column } from '@/components/data/DataTable';
import { FilterChips } from '@/components/data/FilterChips';
import { StatusPill } from '@/components/data/StatusPill';
import { Screen } from '@/components/Screen';
import { useRouteParam } from '@/hooks/useRouteParam';
import { caseStatusTone, formatOptionalText, outcomeTone } from '@/lib/console-api/presentation';
import { useApplication, useCases } from '@/lib/console-api/queries';
import { CASE_STATUSES, type CaseListEntry } from '@/lib/console-api/types';

export default function CasesScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const applicationId = useRouteParam('applicationId');
  const application = useApplication(applicationId);

  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  /**
   * Cursors of the pages BEFORE the current one, oldest first. Empty means the
   * first page; the current page's cursor is the last element.
   *
   * A stack rather than a single "current cursor" because the API issues a cursor
   * for the NEXT page only — there is no previous-page cursor to ask for, and going
   * back has to be a value this client already held.
   */
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const cursor = cursorStack.length === 0 ? undefined : cursorStack[cursorStack.length - 1];

  const page = useCases(applicationId, {
    ...(statusFilter === null ? {} : { status: statusFilter }),
    ...(cursor === undefined ? {} : { cursor }),
  });

  // Changing the filter changes the collection, so a cursor from the previous
  // filter is meaningless against it — and the API would refuse it. Reset.
  const handleFilter = useCallback((value: string | null) => {
    setStatusFilter(value);
    setCursorStack([]);
  }, []);

  const columns: Column<CaseListEntry>[] = [
    {
      id: 'caseId',
      header: t('cases.column.caseId'),
      flex: 2,
      render: (row) => <IdentifierCell>{row.caseId}</IdentifierCell>,
    },
    {
      id: 'status',
      header: t('cases.column.status'),
      width: 150,
      render: (row) => (
        <StatusPill label={t(`caseStatus.${row.status}`)} tone={caseStatusTone(row.status)} />
      ),
    },
    {
      id: 'outcome',
      header: t('cases.column.outcome'),
      width: 160,
      render: (row) =>
        row.outcome === null ? (
          // Not "no violation", and not blank. No decision has been published.
          <Cell muted>{t('cases.notDecided')}</Cell>
        ) : (
          <StatusPill label={t(`outcome.${row.outcome}`)} tone={outcomeTone(row.outcome)} />
        ),
    },
    {
      id: 'subject',
      header: t('cases.column.subject'),
      flex: 2,
      render: (row) => <IdentifierCell>{row.subject.externalId}</IdentifierCell>,
    },
    {
      id: 'allegations',
      header: t('cases.column.allegations'),
      flex: 2,
      render: (row) => <Cell>{row.allegationCodes.join(', ')}</Cell>,
    },
    {
      id: 'reportCount',
      header: t('cases.column.reports'),
      width: 90,
      align: 'right',
      render: (row) => <Cell>{String(row.reportCount)}</Cell>,
    },
    {
      id: 'revision',
      header: t('cases.column.revision'),
      width: 110,
      align: 'right',
      // Current and decided revisions differ while an appeal is open, and the pair
      // is what says so.
      render: (row) => <Cell>{`${row.decidedRevision} / ${row.currentRevision}`}</Cell>,
    },
    {
      id: 'sensitivity',
      header: t('cases.column.sensitivity'),
      width: 120,
      render: (row) => <Cell muted>{formatOptionalText(row.sensitivityClass)}</Cell>,
    },
    {
      id: 'updatedAt',
      header: t('cases.column.updated'),
      width: 180,
      render: (row) => <Cell muted>{row.updatedAt}</Cell>,
    },
    {
      id: 'open',
      header: t('cases.column.open'),
      width: 100,
      align: 'right',
      render: (row) => (
        <Button
          variant="secondary"
          size="small"
          onPress={() =>
            router.navigate(
              `/applications/${encodeURIComponent(applicationId ?? '')}/cases/${encodeURIComponent(row.caseId)}`,
            )
          }
        >
          {t('common.open')}
        </Button>
      ),
    },
  ];

  return (
    <Screen
      title={t('cases.title')}
      subtitle={
        <Text className="text-xs text-muted-foreground">
          {application.data?.name ?? t('cases.subtitle')}
        </Text>
      }
      toolbar={
        <FilterChips
          label={t('cases.column.status')}
          selected={statusFilter}
          onSelect={handleFilter}
          options={[
            { value: null, label: t('common.all') },
            ...CASE_STATUSES.map((status) => ({
              value: status,
              label: t(`caseStatus.${status}`),
            })),
          ]}
        />
      }
    >
      {page.isPending ? <LoadingPanel count={2} /> : null}
      {page.error ? <ApiStateNotice error={page.error} /> : null}

      {page.data ? (
        <>
          <DataTable
            columns={columns}
            rows={page.data.cases}
            keyOf={(row) => row.caseId}
            emptyTitle={t('cases.empty.title')}
            emptyDescription={
              statusFilter === null ? t('cases.empty.body') : t('cases.empty.filtered')
            }
          />

          <View className="flex-row items-center justify-between gap-3">
            <Text className="text-xs text-muted-foreground">
              {t('cases.paging.page', { page: cursorStack.length + 1 })}
            </Text>
            <View className="flex-row gap-2">
              <Button
                variant="secondary"
                size="small"
                disabled={cursorStack.length === 0}
                onPress={() => setCursorStack((stack) => stack.slice(0, -1))}
              >
                {t('cases.paging.previous')}
              </Button>
              <Button
                variant="secondary"
                size="small"
                // `nextCursor` is null when the collection is exhausted, which the
                // API answers as a fact rather than leaving to be inferred from a
                // full page.
                disabled={page.data.nextCursor === null}
                onPress={() =>
                  setCursorStack((stack) =>
                    page.data.nextCursor === null ? stack : [...stack, page.data.nextCursor],
                  )
                }
              >
                {t('cases.paging.next')}
              </Button>
            </View>
          </View>
        </>
      ) : null}
    </Screen>
  );
}

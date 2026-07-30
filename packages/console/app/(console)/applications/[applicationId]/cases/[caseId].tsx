/**
 * One case, and the full history of decisions published about it.
 *
 * ## The revision history is the point
 *
 * A published decision is never edited, only superseded: an appeal produces a NEW
 * revision that names the one it replaces, and the earlier revision keeps its
 * outcome, its findings and the policy versions it was decided under, forever. So
 * this screen renders every revision, oldest first, each with its own outcome and
 * jury figures — not a "current outcome" with an edit history. Showing only the
 * latest would misrepresent an immutable record as a mutable one.
 *
 * ## What is on this screen, and what cannot be
 *
 * Resource METADATA and digests: id, type, role, language, sha256. Not the payload —
 * the application already holds its own material, and a console that rendered
 * reported content would become a second, longer-lived copy of the most sensitive
 * data in the system with its own screenshot risk and no retention story of its own.
 *
 * Aggregate jury figures: size, decisive votes, winning votes, agreement, whether a
 * specialist sat. Not who sat, not how any of them voted. The projected type has no
 * field for either, `agreeingReviewerIds` is dropped before the row leaves the
 * server, and reviews are never read by the service that serves this.
 *
 * A report COUNT and the external report ids the tenant itself supplied. Not
 * `reporterFingerprints`: the salt is the application's own id and the input is the
 * application's own external principal id, so an application handed the fingerprints
 * could recompute them against its user table and de-anonymise its own reporters.
 *
 * ## `inconclusive` is not `no_violation`
 *
 * A jury that reviewed the case and did not reach the threshold has said something
 * different from a jury that agreed nothing was wrong. The two outcomes get different
 * labels and different tones, from `outcomeTone`, and the mapping is asserted in a
 * test so a palette tidy-up cannot merge them.
 */

import { Button } from '@oxyhq/bloom/button';
import { useRouter } from 'expo-router';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { ApiStateNotice, LoadingPanel } from '@/components/ApiStateNotice';
import { Cell, DataTable, IdentifierCell, type Column } from '@/components/data/DataTable';
import { KeyValueList } from '@/components/data/KeyValueList';
import { StatusPill } from '@/components/data/StatusPill';
import { Identifier, Panel, Screen } from '@/components/Screen';
import { useRouteParam } from '@/hooks/useRouteParam';
import {
  caseStatusTone,
  formatOptionalText,
  formatRatio,
  outcomeTone,
} from '@/lib/console-api/presentation';
import { useCaseDetail } from '@/lib/console-api/queries';
import type {
  CaseDecision,
  CaseReportLink,
  CaseResourceMetadata,
} from '@/lib/console-api/types';

export default function CaseDetailScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const applicationId = useRouteParam('applicationId');
  const caseId = useRouteParam('caseId');
  const detail = useCaseDetail(applicationId, caseId);

  const resourceColumns: Column<CaseResourceMetadata>[] = [
    {
      id: 'id',
      header: t('caseDetail.resources.column.id'),
      flex: 2,
      render: (row) => <IdentifierCell>{row.id}</IdentifierCell>,
    },
    {
      id: 'type',
      header: t('caseDetail.resources.column.type'),
      width: 120,
      render: (row) => <Cell>{row.type}</Cell>,
    },
    {
      id: 'role',
      header: t('caseDetail.resources.column.role'),
      width: 120,
      render: (row) => <Cell>{row.role}</Cell>,
    },
    {
      id: 'language',
      header: t('caseDetail.resources.column.language'),
      width: 110,
      render: (row) => <Cell muted>{formatOptionalText(row.language)}</Cell>,
    },
    {
      id: 'sha256',
      header: t('caseDetail.resources.column.digest'),
      flex: 3,
      // The digest is what an integrator reconciles a case against their own
      // record with — it is the whole substitute for the payload.
      render: (row) =>
        row.sha256 === null ? (
          <Cell muted>{t('common.absent')}</Cell>
        ) : (
          <IdentifierCell>{row.sha256}</IdentifierCell>
        ),
    },
  ];

  const reportColumns: Column<CaseReportLink>[] = [
    {
      id: 'externalReportId',
      header: t('caseDetail.reports.column.externalId'),
      flex: 2,
      render: (row) => <IdentifierCell>{row.externalReportId}</IdentifierCell>,
    },
    {
      id: 'reportId',
      header: t('caseDetail.reports.column.reportId'),
      flex: 2,
      render: (row) => <IdentifierCell>{row.reportId}</IdentifierCell>,
    },
    {
      id: 'allegations',
      header: t('caseDetail.reports.column.allegations'),
      flex: 2,
      render: (row) => <Cell>{row.allegationCodes.join(', ')}</Cell>,
    },
    {
      id: 'merged',
      header: t('caseDetail.reports.column.merged'),
      width: 110,
      // A hundred reports about the same material produce one case. `merged` says
      // which of them joined an existing case rather than creating this one.
      render: (row) => <Cell muted={!row.merged}>{row.merged ? t('common.yes') : t('common.no')}</Cell>,
    },
    {
      id: 'linkedAt',
      header: t('caseDetail.reports.column.linkedAt'),
      width: 180,
      render: (row) => <Cell muted>{row.linkedAt}</Cell>,
    },
  ];

  return (
    <Screen
      title={t('caseDetail.title')}
      subtitle={
        detail.data ? (
          <View className="flex-row items-center gap-2">
            <StatusPill
              label={t(`caseStatus.${detail.data.status}`)}
              tone={caseStatusTone(detail.data.status)}
            />
            <Identifier>{detail.data.caseId}</Identifier>
          </View>
        ) : null
      }
      actions={
        <Button
          variant="secondary"
          size="small"
          onPress={() =>
            router.navigate(`/applications/${encodeURIComponent(applicationId ?? '')}/cases`)
          }
        >
          {t('caseDetail.backToCases')}
        </Button>
      }
    >
      {detail.isPending ? <LoadingPanel count={3} /> : null}
      {detail.error ? <ApiStateNotice error={detail.error} /> : null}

      {detail.data ? (
        <>
          <Panel title={t('caseDetail.summary.title')}>
            <KeyValueList
              rows={[
                {
                  label: t('caseDetail.summary.subject'),
                  value: <Identifier>{detail.data.subject.externalId}</Identifier>,
                  hint: t('caseDetail.summary.subjectHint', { type: detail.data.subject.type }),
                },
                {
                  label: t('caseDetail.summary.primaryResource'),
                  value: <Identifier>{detail.data.subject.primaryResourceId}</Identifier>,
                },
                {
                  label: t('caseDetail.summary.policy'),
                  value: `${detail.data.policy.policySetId} @ ${detail.data.policy.version}`,
                  hint: t('caseDetail.summary.policyHint'),
                },
                { label: t('caseDetail.summary.taxonomy'), value: detail.data.taxonomyVersion },
                {
                  label: t('caseDetail.summary.allegations'),
                  value: detail.data.allegationCodes.join('\n'),
                  hint: t('caseDetail.summary.allegationsHint'),
                },
                {
                  label: t('caseDetail.summary.reportCount'),
                  value: String(detail.data.reportCount),
                  hint: t('caseDetail.summary.reportCountHint'),
                },
                {
                  label: t('caseDetail.summary.sensitivity'),
                  value: detail.data.sensitivityClass,
                },
                {
                  label: t('caseDetail.summary.currentRevision'),
                  value: String(detail.data.currentRevision),
                },
                { label: t('caseDetail.summary.createdAt'), value: detail.data.createdAt },
                { label: t('caseDetail.summary.updatedAt'), value: detail.data.updatedAt },
              ]}
            />
          </Panel>

          <Panel
            title={t('caseDetail.resources.title')}
            description={t('caseDetail.resources.description')}
          >
            <DataTable
              columns={resourceColumns}
              rows={detail.data.resources}
              keyOf={(row) => row.id}
              emptyTitle={t('caseDetail.resources.empty')}
            />
          </Panel>

          <Panel
            title={t('caseDetail.reports.title')}
            description={t('caseDetail.reports.description')}
          >
            <DataTable
              columns={reportColumns}
              rows={detail.data.reports}
              keyOf={(row) => row.reportId}
              emptyTitle={t('caseDetail.reports.empty')}
            />
          </Panel>

          <Panel
            title={t('caseDetail.decisions.title')}
            description={t('caseDetail.decisions.description')}
          >
            {detail.data.decisions.length === 0 ? (
              <Text className="text-sm text-muted-foreground">
                {t('caseDetail.decisions.empty')}
              </Text>
            ) : (
              // Oldest first, as served: the history reads downwards in the order
              // it happened, and a superseded revision keeps its own outcome.
              detail.data.decisions.map((decision) => (
                <DecisionRevision key={decision.id} decision={decision} />
              ))
            )}
          </Panel>
        </>
      ) : null}
    </Screen>
  );
}

function DecisionRevision({ decision }: { decision: CaseDecision }) {
  const { t } = useTranslation();

  return (
    <View className="gap-3 rounded-md border border-border p-3">
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="text-sm font-semibold text-foreground">
          {t('caseDetail.decisions.revision', { revision: decision.revision })}
        </Text>
        <StatusPill label={t(`outcome.${decision.outcome}`)} tone={outcomeTone(decision.outcome)} />
        <StatusPill label={t(`decisionStatus.${decision.status}`)} tone="neutral" />
      </View>

      <KeyValueList
        rows={[
          { label: t('caseDetail.decisions.publishedAt'), value: decision.publishedAt },
          {
            label: t('caseDetail.decisions.contextSufficiency'),
            value: t(`contextSufficiency.${decision.contextSufficiency}`),
          },
          {
            label: t('caseDetail.decisions.confidence'),
            value: formatRatio(decision.confidence),
          },
          {
            label: t('caseDetail.decisions.jury'),
            // Aggregate only. There is no field here for a juror, and adding one
            // would require editing the projection — which is the reviewable
            // change that shape exists to force.
            value: t('caseDetail.decisions.juryValue', {
              size: decision.jury.size,
              decisive: decision.jury.decisiveVotes,
              winning: decision.jury.winningVotes,
              agreement: formatRatio(decision.jury.agreement),
            }),
            hint: decision.jury.specialistPresent
              ? t('caseDetail.decisions.specialistPresent')
              : undefined,
          },
          {
            label: t('caseDetail.decisions.policyVersions'),
            value: t('caseDetail.decisions.policyVersionsValue', {
              taxonomy: decision.policyVersions.taxonomy,
              application: decision.policyVersions.application,
              oxyConduct: decision.policyVersions.oxyConduct,
            }),
            hint: t('caseDetail.decisions.policyVersionsHint'),
          },
          {
            label: t('caseDetail.decisions.supersedes'),
            value: decision.supersedesDecisionId,
            hint:
              decision.supersedesDecisionId === null
                ? t('caseDetail.decisions.supersedesNothing')
                : undefined,
          },
        ]}
      />

      {decision.findings.length > 0 ? (
        <View className="gap-2">
          <Text className="text-xs uppercase tracking-wide text-muted-foreground">
            {t('caseDetail.decisions.findings')}
          </Text>
          {decision.findings.map((finding, index) => (
            <View key={`${finding.code}-${index}`} className="gap-0.5 rounded-md bg-muted p-2">
              <Text className="font-bloom-mono text-xs text-foreground" selectable>
                {finding.code}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {t('caseDetail.decisions.findingMeta', {
                  severity: finding.severity,
                  scope: finding.scope,
                  resources: finding.resourceIds.length,
                })}
              </Text>
              {finding.context === null ? null : (
                <Text className="text-xs text-muted-foreground">
                  {t('caseDetail.decisions.findingContext', { context: finding.context })}
                </Text>
              )}
              {finding.attribution === null ? null : (
                <Text className="text-xs text-muted-foreground">
                  {t('caseDetail.decisions.findingAttribution', {
                    attribution: finding.attribution,
                  })}
                </Text>
              )}
            </View>
          ))}
        </View>
      ) : null}

      {decision.recommendedActions.length > 0 ? (
        <View className="gap-1">
          <Text className="text-xs uppercase tracking-wide text-muted-foreground">
            {t('caseDetail.decisions.recommendedActions')}
          </Text>
          {decision.recommendedActions.map((action, index) => (
            <Text
              key={`${action.action}-${index}`}
              className="font-bloom-mono text-xs text-foreground"
              selectable
            >
              {action.targetResourceIds.length === 0
                ? action.action
                : `${action.action} → ${action.targetResourceIds.join(', ')}`}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

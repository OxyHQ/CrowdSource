import { createHash } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type { CaseEnvelope, TaxonomyCode } from '@oxyhq/crowdsource-contracts';

import type { TenantContext } from '../../db/tenantScope';
import { newPublicId } from '../../utils/identifiers';
import { contentHashOf, contentSnapshotOf } from '../evidence/contentSnapshot';
import type { ResolvedPolicy } from '../policy/policy.registry';
import { caseDedupKey } from './caseDedupKey';
import { caseReports, cases, type CaseDocument } from './case.collection';

/**
 * The case orchestrator's write path (§7.3, §7.4) — deduplication and merge.
 *
 * One function does the work, and it runs inside the ingress transaction rather
 * than behind the outbox. That is a deliberate exception to "cross-module
 * communication goes through the outbox", and the reason is §10.4: the `202` for
 * a report carries `caseId` and `merged`, so the case has to exist before the
 * response does. Everything AFTER this — triage, sortition, consensus, webhooks
 * — goes through the outbox, which is where the rule earns its keep. Creating
 * the expedient the report belongs to is part of receiving the report, not a
 * downstream reaction to it.
 */

/** What attaching a report to a case produced. */
export interface AttachedCase {
  readonly caseId: string;
  /** True when the report joined a case that already existed (§10.4). */
  readonly merged: boolean;
  readonly contentHash: string;
  readonly caseDedupKey: string;
}

/**
 * A stable, per-application, non-reversible stand-in for a reporter.
 *
 * §7.4 needs to count DISTINCT reporters — one person filing forty reports is
 * one opinion, and treating it as forty is precisely the manipulation §11.11
 * describes. §9.1 forbids a reviewer seeing anything about the reporters. Both
 * hold if the case stores a fingerprint instead of an id: it counts, it does not
 * reverse, and salting with the application id means the same person under two
 * tenants produces two unrelated values, so the case collection cannot become a
 * cross-tenant correlation table.
 */
export function reporterFingerprint(applicationId: string, reporterKey: string): string {
  return createHash('sha256').update(`${applicationId}:${reporterKey}`, 'utf8').digest('hex');
}

/**
 * The reporter key for somebody the application can name.
 *
 * Exported alongside the hash because sortition has to ask the opposite
 * question — "is this candidate one of the reporters?" — and a fingerprint is
 * not reversible, so the only way to answer is to compute the candidate's
 * fingerprint the same way. Two copies of this string format would drift, and
 * the symptom of drift is an exclusion that silently matches nothing: the
 * reporter of a case sitting on its jury, with every test still green.
 */
export function principalReporterKey(externalPrincipalId: string): string {
  return `principal:${externalPrincipalId}`;
}

/**
 * Who reported, as comparable keys.
 *
 * A `principalRef` is local to ONE envelope — `author_1` in two reports is two
 * different people — so it is resolved through `principalBindings` to the
 * application's own id, which is comparable within the application. A reporter
 * that cannot be resolved counts as one distinct reporter for THIS report,
 * keyed by the report id: assuming two anonymous reports came from the same
 * person would understate the signal, and assuming they came from different
 * people is what actually happened, so far as this service can tell.
 */
function reporterKeys(envelope: CaseEnvelope, reportId: string): string[] {
  const externalIdByRef = new Map(
    envelope.principalBindings
      .filter((binding) => binding.externalPrincipalId !== undefined)
      .map((binding) => [
        binding.principalRef,
        principalReporterKey(binding.externalPrincipalId ?? ''),
      ]),
  );

  const keys = new Set<string>();
  for (const allegation of envelope.allegations) {
    const ref = allegation.reporterPrincipalRef;
    keys.add(ref === undefined ? `report:${reportId}` : (externalIdByRef.get(ref) ?? `report:${reportId}`));
  }
  // An envelope always carries at least one allegation, so this is never empty;
  // the fallback keeps the invariant local rather than relying on that.
  if (keys.size === 0) keys.add(`report:${reportId}`);
  return [...keys];
}

export interface AttachReportInput {
  readonly reportId: string;
  readonly envelope: CaseEnvelope;
  readonly policy: ResolvedPolicy;
  readonly receivedAt: Date;
}

/**
 * Attaches a report to its case, creating the case when it is the first.
 *
 * The upsert IS the deduplication. A "look for a case, then create one if
 * absent" sequence races: two people reporting the same post in the same instant
 * both find nothing and both create a case — two juries, two decisions and two
 * consequences for one incident. Here the unique compound index of §12.7 decides,
 * and the loser of the race merges.
 *
 * A duplicate-key error can still surface from the upsert under that exact
 * concurrency, and it is deliberately NOT caught here: it aborts the ingress
 * transaction, `report.service.ts` retries the whole delivery, and the retry
 * finds the case the winner created. Catching it here would mean retrying one
 * write inside a transaction the failure has already doomed.
 */
export async function attachReportToCase(
  context: TenantContext,
  session: ClientSession,
  input: AttachReportInput,
): Promise<AttachedCase> {
  const { envelope, policy, receivedAt } = input;

  const snapshot = contentSnapshotOf(envelope);
  const contentHash = contentHashOf(snapshot);
  const dedupKey = caseDedupKey({
    applicationId: context.applicationId,
    subjectExternalId: envelope.subject.externalId,
    contentEnvelopeHash: contentHash,
    applicationPolicyVersion: policy.token,
  });

  const candidateCaseId = newPublicId('case');
  const allegationCodes: TaxonomyCode[] = [
    ...new Set(envelope.allegations.map((allegation) => allegation.code)),
  ];
  const fingerprints = reporterKeys(envelope, input.reportId).map((key) =>
    reporterFingerprint(context.applicationId, key),
  );

  const allowCommunityReview = envelope.privacy.allowCommunityReview;
  const activeDistribution = envelope.urgency?.activeDistribution === true;

  const stored: CaseDocument = await cases.upsertOne(
    context,
    {
      externalSubjectId: envelope.subject.externalId,
      contentHash,
      policyVersion: policy.token,
    },
    {
      setOnInsert: {
        caseId: candidateCaseId,
        caseDedupKey: dedupKey,
        subjectType: envelope.subject.type,
        primaryResourceId: envelope.subject.primaryResourceId,
        policySetId: policy.policySetId,
        taxonomyVersion: policy.taxonomyVersion,
        contentSnapshot: snapshot,
        status: 'received',
        priorityScore: 0,
        sensitivityClass: null,
        reviewPool: null,
        requiresRedaction: false,
        escalated: false,
        triagedAt: null,
        currentRevision: 1,
        incidentId: null,
        firstReportedAt: receivedAt,
        createdAt: receivedAt,
        /**
         * Sticky in one direction only. A report that withholds community review
         * binds the case; one that permits it must never re-open a case an
         * earlier reporter closed, so the permissive value is only ever written
         * at creation and the restrictive one is written on every merge below.
         */
        ...(allowCommunityReview ? { allowCommunityReview: true } : {}),
        ...(activeDistribution ? {} : { activeDistribution: false }),
        ...(envelope.privacy.containsPersonalData === true ? {} : { containsPersonalData: false }),
      },
      set: {
        lastReportedAt: receivedAt,
        updatedAt: receivedAt,
        ...(allowCommunityReview ? {} : { allowCommunityReview: false }),
        ...(activeDistribution ? { activeDistribution: true } : {}),
        ...(envelope.privacy.containsPersonalData === true ? { containsPersonalData: true } : {}),
      },
      inc: { reportCount: 1 },
      addToSet: {
        allegationCodes: allegationCodes,
        reporterFingerprints: fingerprints,
      },
      /**
       * Retention is the LONGEST any reporter asked for. §13.6 measures it from
       * the final decision, so a shorter value would delete the evidence of a
       * case that is still open — and a case cannot be re-reviewed from evidence
       * that has been erased. `$max` also creates the field on insert, which is
       * why it is not repeated in `setOnInsert`.
       */
      max: {
        retentionDays: envelope.privacy.retentionDays,
        reach: envelope.urgency?.reach ?? 0,
      },
    },
    session,
  );

  const merged = stored.caseId !== candidateCaseId;

  await caseReports.insertOne(
    context,
    {
      caseId: stored.caseId,
      reportId: input.reportId,
      externalReportId: envelope.externalReportId,
      allegationCodes,
      merged,
      linkedAt: receivedAt,
      createdAt: receivedAt,
      updatedAt: receivedAt,
    },
    session,
  );

  return { caseId: stored.caseId, merged, contentHash, caseDedupKey: dedupKey };
}

/** What an application may read back about one of its cases (§10.2). */
export interface CaseView {
  readonly caseId: string;
  readonly status: CaseDocument['status'];
  readonly subject: { readonly externalId: string; readonly type: string };
  readonly policy: { readonly policySetId: string; readonly version: string };
  readonly taxonomyVersion: string;
  readonly allegationCodes: readonly TaxonomyCode[];
  readonly reportCount: number;
  readonly sensitivityClass: CaseDocument['sensitivityClass'];
  readonly currentRevision: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Reads one case for the application that owns it.
 *
 * A deliberate projection, and the omissions are the design. `priorityScore`,
 * `reviewPool` and `reporterFingerprints` never leave: priority is an internal
 * queue position an application could otherwise game by learning which signals
 * move it, the pool would tell a tenant which of its cases went to specialists,
 * and the fingerprints exist to be counted and nothing else. `contentSnapshot`
 * never leaves either — the application already has the material; this API is
 * not a route back to another tenant's copy of it, nor a store the application
 * should be reading its own evidence from.
 */
export async function findCaseView(
  context: TenantContext,
  caseId: string,
): Promise<CaseView | null> {
  const stored = await cases.findOne(context, { caseId });
  if (!stored) return null;

  return {
    caseId: stored.caseId,
    status: stored.status,
    subject: { externalId: stored.externalSubjectId, type: stored.subjectType },
    policy: { policySetId: stored.policySetId, version: stored.policyVersion },
    taxonomyVersion: stored.taxonomyVersion,
    allegationCodes: stored.allegationCodes,
    reportCount: stored.reportCount,
    sensitivityClass: stored.sensitivityClass,
    currentRevision: stored.currentRevision,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

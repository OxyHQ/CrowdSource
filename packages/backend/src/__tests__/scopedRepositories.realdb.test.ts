import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as decisionRepository from '../db/postgres/repositories/scoped/decisions';
import * as governanceRepository from '../db/postgres/repositories/scoped/governance';
import * as reportRepository from '../db/postgres/repositories/scoped/reports';
import * as webhookRepository from '../db/postgres/repositories/scoped/webhooks';
import { createTenantContext, type TenantContext } from '../db/tenantScope';
import { withTenant } from '../db/postgres/withTenant';
import {
  createPostgresTestDatabase,
  type PostgresTestDatabase,
} from './support/postgresTestDatabase';

/**
 * The remaining ten tenant-owned tables, against a real server as the APPLICATION
 * role.
 *
 * Same shape as `scopedCaseRepository.realdb.test.ts` and the reasoning is not
 * repeated: every function runs through `withTenant` as the app role, and the
 * reads have a SIBLING-TENANT row present so a `null` is filtering rather than
 * absence. `beta` is a different organization; `alphaSibling` is the same
 * organization with a different application, and it is the one that stays visible
 * under an organization-only policy — mutation-tested on `cases` in #91.
 */

let database: PostgresTestDatabase;

const alpha: TenantContext = createTenantContext('org_alpha', 'app_alpha_one');
const alphaSibling: TenantContext = createTenantContext('org_alpha', 'app_alpha_two');
const beta: TenantContext = createTenantContext('org_beta', 'app_beta_one');

const AT = new Date('2026-08-10T00:00:00.000Z');

/** Seeds one row per table for each sibling tenant, AS THE MIGRATOR. */
async function seedSiblings(): Promise<void> {
  for (const [context, suffix] of [
    [alphaSibling, 'sibling'],
    [beta, 'beta'],
  ] as const) {
    const { organizationId, applicationId } = context;

    await database.asMigrator`
      INSERT INTO reports (report_id, organization_id, application_id, external_report_id,
                           idempotency_key, payload_hash, envelope, case_id, content_hash,
                           status, received_at)
      VALUES (${`rep_${suffix}`}, ${organizationId}, ${applicationId}, ${`ext_${suffix}`},
              ${`idem_${suffix}`}, 'hash', '{}'::jsonb, ${`case_${suffix}`}, 'content',
              'received', ${AT})
    `;
    await database.asMigrator`
      INSERT INTO case_reports (organization_id, application_id, case_id, report_id,
                                external_report_id, linked_at)
      VALUES (${organizationId}, ${applicationId}, ${`case_${suffix}`}, ${`rep_${suffix}`},
              ${`ext_${suffix}`}, ${AT})
    `;
    await database.asMigrator`
      INSERT INTO webhook_endpoints (webhook_endpoint_id, organization_id, application_id, url,
                                     event_types, status)
      VALUES (${`whe_${suffix}`}, ${organizationId}, ${applicationId},
              ${`https://example.test/${suffix}`}, ARRAY['case.decided'], 'active')
    `;
  }

  const [seeded] = await database.asMigrator<{ n: number }[]>`SELECT count(*)::int AS n FROM reports`;
  expect(seeded.n).toBe(2);
}

beforeAll(async () => {
  database = await createPostgresTestDatabase();
  await seedSiblings();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

describe('reports and case reports', () => {
  it('inserts, reads back, and cannot see a sibling tenant’s report', async () => {
    await withTenant(database.db, alpha, async (tx) => {
      await reportRepository.insertReport(tx, {
        reportId: 'rep_alpha',
        organizationId: alpha.organizationId,
        applicationId: alpha.applicationId,
        externalReportId: 'ext_alpha',
        idempotencyKey: 'idem_alpha',
        payloadHash: 'hash_alpha',
        envelope: { kind: 'test' },
        caseId: 'case_alpha',
        contentHash: 'content_alpha',
        status: 'received',
        receivedAt: AT,
      });
    });

    const readings = await withTenant(database.db, alpha, async (tx) => ({
      own: await reportRepository.findReportById(tx, 'rep_alpha'),
      sibling: await reportRepository.findReportById(tx, 'rep_sibling'),
      other: await reportRepository.findReportById(tx, 'rep_beta'),
    }));

    expect(readings.own?.contentHash).toBe('content_alpha');
    expect(readings.sibling).toBeNull();
    expect(readings.other).toBeNull();
  });

  /**
   * The idempotency read returns the ROW rather than a boolean, so the caller can
   * tell a true replay from a key reused with different content — 200 versus 409.
   * A sibling holding the same key must not answer either question.
   */
  it('resolves an idempotency key within the tenant only', async () => {
    const found = await withTenant(database.db, alpha, async (tx) =>
      reportRepository.findReportByIdempotencyKey(tx, 'idem_alpha'),
    );
    expect(found?.payloadHash).toBe('hash_alpha');

    const crossed = await withTenant(database.db, alpha, async (tx) =>
      reportRepository.findReportByIdempotencyKey(tx, 'idem_sibling'),
    );
    expect(crossed).toBeNull();
  });

  it('links reports to a case, counts and merges them', async () => {
    await withTenant(database.db, alpha, async (tx) => {
      await reportRepository.insertCaseReport(tx, {
        organizationId: alpha.organizationId,
        applicationId: alpha.applicationId,
        caseId: 'case_alpha',
        reportId: 'rep_alpha',
        externalReportId: 'ext_alpha',
        allegationCodes: ['harassment'],
        merged: false,
        linkedAt: AT,
      });
    });

    const linked = await withTenant(database.db, alpha, async (tx) =>
      reportRepository.listCaseReports(tx, 'case_alpha'),
    );
    expect(linked.map((row) => row.reportId)).toEqual(['rep_alpha']);
    expect(linked[0].allegationCodes).toEqual(['harassment']);

    const total = await withTenant(database.db, alpha, async (tx) =>
      reportRepository.countCaseReports(tx, 'case_alpha'),
    );
    expect(total).toBe(1);
    expect(typeof total).toBe('number');

    expect(
      await withTenant(database.db, alpha, async (tx) =>
        reportRepository.markCaseReportMerged(tx, 'case_alpha', 'rep_alpha'),
      ),
    ).toBe(1);

    // A sibling's link is untouchable even by exact id.
    expect(
      await withTenant(database.db, alpha, async (tx) =>
        reportRepository.markCaseReportMerged(tx, 'case_sibling', 'rep_sibling'),
      ),
    ).toBe(0);
  });

  it('updates a report status and lists recent reports', async () => {
    expect(
      await withTenant(database.db, alpha, async (tx) =>
        reportRepository.updateReportStatus(tx, 'rep_alpha', 'accepted'),
      ),
    ).toBe(1);

    expect(
      await withTenant(database.db, alpha, async (tx) =>
        reportRepository.updateReportStatus(tx, 'rep_beta', 'accepted'),
      ),
    ).toBe(0);

    const recent = await withTenant(database.db, alpha, async (tx) =>
      reportRepository.listRecentReports(tx),
    );
    expect(recent.map((row) => row.reportId)).toEqual(['rep_alpha']);
  });
});

describe('decisions and appeals', () => {
  const decision = {
    decisionId: 'dec_alpha',
    organizationId: alpha.organizationId,
    applicationId: alpha.applicationId,
    caseId: 'case_alpha',
    revision: 1,
    status: 'published',
    outcome: 'violation',
    contextSufficiency: 'sufficient',
    confidence: 0.9,
    findings: [],
    recommendedActions: [],
    jurySize: 5,
    juryDecisiveVotes: 5,
    juryWinningVotes: 4,
    juryAgreement: 0.8,
    jurySpecialistPresent: true,
    policyVersionTaxonomy: 'v1',
    policyVersionApplication: 'v1',
    policyVersionOxyConduct: 'v1',
    supersedesDecisionId: null,
    agreeingReviewerIds: ['rev_one', 'rev_two'],
    publishedAt: AT,
  };

  it('publishes a decision and finds it by id and by revision', async () => {
    await withTenant(database.db, alpha, async (tx) =>
      decisionRepository.insertDecision(tx, decision),
    );

    const byId = await withTenant(database.db, alpha, async (tx) =>
      decisionRepository.findDecisionById(tx, 'dec_alpha'),
    );
    expect(byId?.outcome).toBe('violation');
    expect(byId?.agreeingReviewerIds).toEqual(['rev_one', 'rev_two']);

    const byRevision = await withTenant(database.db, alpha, async (tx) =>
      decisionRepository.findDecisionForRevision(tx, 'case_alpha', 1),
    );
    expect(byRevision?.decisionId).toBe('dec_alpha');

    // A revision that exists for nobody, and one that exists for nobody here.
    expect(
      await withTenant(database.db, alpha, async (tx) =>
        decisionRepository.findDecisionForRevision(tx, 'case_beta', 1),
      ),
    ).toBeNull();
  });

  it('lists a case’s decisions newest revision first', async () => {
    await withTenant(database.db, alpha, async (tx) =>
      decisionRepository.insertDecision(tx, {
        ...decision,
        decisionId: 'dec_alpha_two',
        revision: 2,
        supersedesDecisionId: 'dec_alpha',
      }),
    );

    const listed = await withTenant(database.db, alpha, async (tx) =>
      decisionRepository.listDecisionsForCase(tx, 'case_alpha'),
    );
    expect(listed.map((row) => row.revision)).toEqual([2, 1]);
  });

  it('updates a decision status', async () => {
    expect(
      await withTenant(database.db, alpha, async (tx) =>
        decisionRepository.updateDecisionStatus(tx, 'dec_alpha', 'superseded'),
      ),
    ).toBe(1);
    expect(
      await withTenant(database.db, alpha, async (tx) =>
        decisionRepository.updateDecisionStatus(tx, 'dec_absent', 'superseded'),
      ),
    ).toBe(0);
  });

  it('files an appeal and resolves it three ways', async () => {
    await withTenant(database.db, alpha, async (tx) =>
      decisionRepository.insertAppeal(tx, {
        appealId: 'app_alpha',
        organizationId: alpha.organizationId,
        applicationId: alpha.applicationId,
        caseId: 'case_alpha',
        supersededRevision: 1,
        supersededDecisionId: 'dec_alpha',
        openedRevision: 2,
        reason: 'new evidence',
        appellantExternalPrincipalId: 'principal_one',
        authorContext: null,
        previousRequiredVotes: 3,
        severeAction: false,
        requiredAgreeingVotes: 4,
        idempotencyKey: 'idem_appeal_alpha',
        payloadHash: 'hash',
        filedAt: AT,
        filedByCredentialId: 'cred_alpha',
      }),
    );

    const readings = await withTenant(database.db, alpha, async (tx) => ({
      byId: await decisionRepository.findAppealById(tx, 'app_alpha'),
      byRevision: await decisionRepository.findAppealForRevision(tx, 'case_alpha', 2),
      byKey: await decisionRepository.findAppealByIdempotencyKey(tx, 'idem_appeal_alpha'),
    }));

    expect(readings.byId?.reason).toBe('new evidence');
    expect(readings.byRevision?.appealId).toBe('app_alpha');
    expect(readings.byKey?.appealId).toBe('app_alpha');
  });
});

describe('governance: policy sets, the tenant audit trail and the usage meter', () => {
  it('publishes a policy set version and lists its history', async () => {
    await withTenant(database.db, alpha, async (tx) =>
      governanceRepository.insertPolicySet(tx, {
        organizationId: alpha.organizationId,
        applicationId: alpha.applicationId,
        policySetId: 'pol_alpha',
        version: '1',
        status: 'draft',
        title: 'Community rules',
        // Explicitly null rather than omitted — the parameter is required for
        // exactly the absent-versus-null reason the repository documents.
        locale: null,
        rules: { clauses: [] },
        publishedAt: null,
      }),
    );

    const found = await withTenant(database.db, alpha, async (tx) =>
      governanceRepository.findPolicySetVersion(tx, 'pol_alpha', '1'),
    );
    expect(found?.title).toBe('Community rules');
    expect(found?.locale).toBeNull();

    expect(
      await withTenant(database.db, alpha, async (tx) =>
        governanceRepository.updatePolicySetStatus(tx, 'pol_alpha', '1', {
          status: 'published',
          publishedAt: AT,
        }),
      ),
    ).toBe(1);

    const versions = await withTenant(database.db, alpha, async (tx) =>
      governanceRepository.listPolicySetVersions(tx, 'pol_alpha'),
    );
    expect(versions).toHaveLength(1);
    expect(versions[0].status).toBe('published');
  });

  it('appends a tenant audit event and reads a case’s trail', async () => {
    await withTenant(database.db, alpha, async (tx) =>
      governanceRepository.appendAuditEvent(tx, {
        auditId: 'aud_alpha',
        organizationId: alpha.organizationId,
        applicationId: alpha.applicationId,
        action: 'report.accepted',
        actorCredentialId: 'cred_alpha',
        actorOxyUserId: null,
        reportId: 'rep_alpha',
        caseId: 'case_alpha',
        externalReportId: 'ext_alpha',
        reason: null,
        subjectId: null,
        occurredAt: AT,
      }),
    );

    const trail = await withTenant(database.db, alpha, async (tx) =>
      governanceRepository.listAuditEventsForCase(tx, 'case_alpha'),
    );
    expect(trail.map((row) => row.auditId)).toEqual(['aud_alpha']);
    expect(trail[0].actorOxyUserId).toBeNull();
  });

  /**
   * The upsert, called TWICE.
   *
   * One call cannot tell an increment from an insert-that-overwrote: both leave 1.
   * The second call is what proves the conflict branch adds to the STORED value
   * rather than replacing it, and it is the whole reason this is an upsert instead
   * of a read-then-write.
   */
  it('increments the usage meter in place rather than overwriting it', async () => {
    await withTenant(database.db, alpha, async (tx) =>
      governanceRepository.incrementUsageCounter(tx, alpha, '2026-08-10'),
    );
    await withTenant(database.db, alpha, async (tx) =>
      governanceRepository.incrementUsageCounter(tx, alpha, '2026-08-10'),
    );

    const counter = await withTenant(database.db, alpha, async (tx) =>
      governanceRepository.findUsageCounter(tx, '2026-08-10'),
    );
    expect(counter?.reportsReceived).toBe(2);
  });
});

describe('webhooks: endpoints, secrets and attempts', () => {
  it('registers an endpoint and fans out by event type', async () => {
    await withTenant(database.db, alpha, async (tx) =>
      webhookRepository.insertWebhookEndpoint(tx, {
        webhookEndpointId: 'whe_alpha',
        organizationId: alpha.organizationId,
        applicationId: alpha.applicationId,
        url: 'https://example.test/alpha',
        eventTypes: ['case.decided', 'report.received'],
        status: 'active',
      }),
    );

    const byId = await withTenant(database.db, alpha, async (tx) =>
      webhookRepository.findWebhookEndpointById(tx, 'whe_alpha'),
    );
    expect(byId?.url).toBe('https://example.test/alpha');

    /**
     * Both siblings ALSO subscribe to `case.decided` — seeded that way on
     * purpose. A fan-out that leaked would return three endpoints and send one
     * tenant's decision to two others' servers, which is the worst failure this
     * whole layer can have.
     */
    const subscribed = await withTenant(database.db, alpha, async (tx) =>
      webhookRepository.listEndpointsForEvent(tx, 'case.decided'),
    );
    expect(subscribed.map((row) => row.webhookEndpointId)).toEqual(['whe_alpha']);

    const listed = await withTenant(database.db, alpha, async (tx) =>
      webhookRepository.listWebhookEndpoints(tx),
    );
    expect(listed).toHaveLength(1);
  });

  it('disables an endpoint once and refuses the second attempt', async () => {
    const disabledAt = new Date('2026-08-10T03:00:00.000Z');
    expect(
      await withTenant(database.db, alpha, async (tx) =>
        webhookRepository.disableWebhookEndpoint(tx, 'whe_alpha', 'gone', disabledAt),
      ),
    ).toBe(1);

    // The `status = 'active'` predicate: a second 410 must not overwrite the
    // original reason and instant.
    expect(
      await withTenant(database.db, alpha, async (tx) =>
        webhookRepository.disableWebhookEndpoint(tx, 'whe_alpha', 'later', new Date()),
      ),
    ).toBe(0);

    const stored = await withTenant(database.db, alpha, async (tx) =>
      webhookRepository.findWebhookEndpointById(tx, 'whe_alpha'),
    );
    expect(stored?.disabledReason).toBe('gone');
    expect(stored?.disabledAt?.getTime()).toBe(disabledAt.getTime());
  });

  it('stores a secret, and the summary read carries no key material', async () => {
    await withTenant(database.db, alpha, async (tx) =>
      webhookRepository.insertWebhookSecret(tx, {
        organizationId: alpha.organizationId,
        applicationId: alpha.applicationId,
        webhookEndpointId: 'whe_alpha',
        version: 1,
        algorithm: 'aes-256-gcm',
        keyFingerprint: 'fingerprint',
        ciphertext: 'CIPHERTEXT',
        iv: 'IV',
        authTag: 'TAG',
        activatesAt: AT,
        expiresAt: null,
      }),
    );

    const signing = await withTenant(database.db, alpha, async (tx) =>
      webhookRepository.listWebhookSecretsForSigning(tx, 'whe_alpha'),
    );
    // The signer genuinely needs the material, so this read must carry it.
    expect(signing[0].ciphertext).toBe('CIPHERTEXT');

    const summaries = await withTenant(database.db, alpha, async (tx) =>
      webhookRepository.listWebhookSecretSummaries(tx, 'whe_alpha'),
    );
    expect(summaries[0].version).toBe(1);
    // A claim about the BYTES, not only about the type.
    for (const key of ['ciphertext', 'iv', 'authTag', 'keyFingerprint']) {
      expect(Object.keys(summaries[0])).not.toContain(key);
    }
  });

  it('appends attempts and reads them in order', async () => {
    for (const attemptNumber of [1, 2]) {
      await withTenant(database.db, alpha, async (tx) =>
        webhookRepository.appendWebhookAttempt(tx, {
          attemptId: `att_${attemptNumber}`,
          organizationId: alpha.organizationId,
          applicationId: alpha.applicationId,
          deliveryId: 'whd_alpha',
          webhookEndpointId: 'whe_alpha',
          eventId: 'evt_alpha',
          attemptNumber,
          outcome: attemptNumber === 1 ? 'failed' : 'succeeded',
          responseStatus: attemptNumber === 1 ? 500 : 200,
          failureKind: attemptNumber === 1 ? 'server_error' : null,
          latencyMs: 12,
          // The empty string, not null — "succeeded, no body" must stay
          // distinguishable from "we failed to record one".
          responseBodyPreview: '',
          nextAttemptAt: null,
          secretVersion: 1,
          attemptedAt: AT,
        }),
      );
    }

    const attempts = await withTenant(database.db, alpha, async (tx) =>
      webhookRepository.listWebhookAttempts(tx, 'whd_alpha'),
    );
    expect(attempts.map((row) => row.attemptNumber)).toEqual([1, 2]);
    expect(attempts[1].responseBodyPreview).toBe('');
  });
});

describe('the suite exercises every module', () => {
  /**
   * One gate per module, reading this file's own source. A repository function
   * added later fails the build until it is exercised — the claim "the suite
   * covers every export" is otherwise unchecked and decays on the first addition.
   */
  const source = readFileSync(path.join(__dirname, 'scopedRepositories.realdb.test.ts'), 'utf8');

  const modules = [
    ['reportRepository', reportRepository],
    ['decisionRepository', decisionRepository],
    ['governanceRepository', governanceRepository],
    ['webhookRepository', webhookRepository],
  ] as const;

  it('found all four modules with functions in them', () => {
    // Vacuity floor: an empty module would satisfy the per-module check below.
    for (const [name, module] of modules) {
      const count = Object.values(module).filter((value) => typeof value === 'function').length;
      expect(count, `${name} should export functions`).toBeGreaterThanOrEqual(5);
    }
  });

  it('names every exported function somewhere in this file', () => {
    const unexercised = modules.flatMap(([alias, module]) =>
      Object.entries(module)
        .filter(([, value]) => typeof value === 'function')
        .map(([name]) => `${alias}.${name}`)
        .filter((call) => !source.includes(`${call}(`)),
    );

    expect(unexercised).toEqual([]);
  });
});

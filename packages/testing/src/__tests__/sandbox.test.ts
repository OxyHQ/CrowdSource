/**
 * The path an integrator actually has to get right, end to end.
 *
 * The real `@oxyhq/crowdsource` client is pointed at the sandbox, so what is
 * exercised is the client's own envelope composition, its idempotency key, its
 * error mapping and its transport — not a mock of any of them. The only thing
 * standing in for the service is the service.
 */

import { CrowdSource, CrowdSourceApiError, type ReportInput } from '@oxyhq/crowdsource';
import { describe, expect, it } from 'vitest';

import { caseDecidedEventFixture, caseEnvelopeFixture, decisionFixture } from '../fixtures';
import { createCrowdSourceSandbox, type CrowdSourceSandbox } from '../sandbox';

function connect(sandbox: CrowdSourceSandbox): CrowdSource {
  return new CrowdSource({
    serviceKey: sandbox.serviceKey,
    baseUrl: sandbox.baseUrl,
    fetch: sandbox.fetch,
  });
}

function report(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    externalReportId: 'report_1',
    subject: { externalId: 'post_987', type: 'social.post', author: { oxyUserId: 'oxy_author' } },
    content: 'Texto exacto reportado',
    allegations: ['harassment.targeted_abuse'],
    reportedBy: { oxyUserId: 'oxy_reporter_1' },
    ...overrides,
  };
}

describe('the sandbox, driven by the real client', () => {
  it('accepts a report and answers with a case', async () => {
    const sandbox = createCrowdSourceSandbox();

    const accepted = await connect(sandbox).reports.create(report());

    expect(accepted).toMatchObject({ status: 'received', merged: false });
    expect(accepted.reportId).toMatch(/^rpt_/);
    expect(accepted.caseId).toMatch(/^case_/);
  });

  /**
   * §15.3's definition of the ingestion phase being done, and the shape of
   * "one penalty per incident": two people, two reports, ONE case.
   */
  it('merges two reporters of the same post into one case', async () => {
    const sandbox = createCrowdSourceSandbox();
    const client = connect(sandbox);

    const alice = await client.reports.create(
      report({ externalReportId: 'report_alice', reportedBy: { oxyUserId: 'oxy_alice' } }),
    );
    const bob = await client.reports.create(
      report({
        externalReportId: 'report_bob',
        reportedBy: { oxyUserId: 'oxy_bob' },
        allegations: ['hate.slur'],
      }),
    );

    expect(bob.caseId).toBe(alice.caseId);
    expect(bob.merged).toBe(true);
    expect(alice.reportId).not.toBe(bob.reportId);

    const view = await client.cases.get(alice.caseId);
    expect(view.reportCount).toBe(2);
    expect([...view.allegationCodes].sort()).toEqual(['harassment.targeted_abuse', 'hate.slur']);
  });

  it('opens a new case when the reported content itself changed', async () => {
    const sandbox = createCrowdSourceSandbox();
    const client = connect(sandbox);

    const original = await client.reports.create(report({ externalReportId: 'report_before' }));
    const edited = await client.reports.create(
      report({ externalReportId: 'report_after', content: 'Texto editado despues del reporte' }),
    );

    expect(edited.caseId).not.toBe(original.caseId);
  });

  it('returns the same reportId when a delivery is retried', async () => {
    const sandbox = createCrowdSourceSandbox();
    const client = connect(sandbox);

    const first = await client.reports.create(report());
    const retried = await client.reports.create(report());

    expect(retried.reportId).toBe(first.reportId);
    expect(sandbox.reports).toHaveLength(1);
  });

  it('refuses the same externalReportId with a different body, and says not to retry', async () => {
    const sandbox = createCrowdSourceSandbox();
    const client = connect(sandbox);

    await client.reports.create(report());
    const failure = await client.reports
      .create(report({ content: 'a completely different post' }))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CrowdSourceApiError);
    expect((failure as CrowdSourceApiError).status).toBe(409);
    expect((failure as CrowdSourceApiError).retryable).toBe(false);
  });

  it('refuses a credential that is not the sandbox’s own', async () => {
    const sandbox = createCrowdSourceSandbox();
    const other = createCrowdSourceSandbox();
    const client = new CrowdSource({
      serviceKey: other.serviceKey,
      baseUrl: sandbox.baseUrl,
      fetch: sandbox.fetch,
      maxAttempts: 1,
    });

    const failure = await client.reports.create(report()).catch((error: unknown) => error);

    expect((failure as CrowdSourceApiError).status).toBe(401);
  });

  it('answers 404 for the upload routes the service does not serve yet', async () => {
    const sandbox = createCrowdSourceSandbox();

    const failure = await connect(sandbox)
      .uploads.upload({ bytes: new TextEncoder().encode('x'), mimeType: 'image/png' })
      .catch((error: unknown) => error);

    expect((failure as CrowdSourceApiError).status).toBe(404);
  });

  it('publishes a decision and reads it back', async () => {
    const sandbox = createCrowdSourceSandbox();
    const client = connect(sandbox);
    const { caseId } = await client.reports.create(report());

    const decision = sandbox.decide(caseId, { outcome: 'violation' });
    const readBack = await client.decisions.get(decision.id);

    expect(readBack).toEqual(decision);
    expect(readBack.revision).toBe(1);
    expect(readBack.supersedesDecisionId).toBeUndefined();
  });

  /**
   * Appendix F: a published decision is never edited, only superseded. Deciding
   * a case twice must produce a second revision that names the first.
   */
  it('supersedes rather than edits when a case is decided again', async () => {
    const sandbox = createCrowdSourceSandbox();
    const { caseId } = await connect(sandbox).reports.create(report());

    const first = sandbox.decide(caseId, { outcome: 'violation' });
    const corrected = sandbox.decide(caseId, { outcome: 'no_violation' });

    expect(corrected.revision).toBe(2);
    expect(corrected.supersedesDecisionId).toBe(first.id);
    expect(sandbox.eventFor(corrected).type).toBe('decision.corrected');
  });

  it('never collapses inconclusive into no_violation', async () => {
    const sandbox = createCrowdSourceSandbox();
    const { caseId } = await connect(sandbox).reports.create(report());

    expect(sandbox.decide(caseId, { outcome: 'inconclusive' }).outcome).toBe('inconclusive');
  });
});

describe('fixtures', () => {
  it('produce documents the published contracts accept', () => {
    expect(caseEnvelopeFixture().schemaVersion).toBe('crowdsource.case.v1');
    expect(decisionFixture().outcome).toBe('violation');
    expect(caseDecidedEventFixture().type).toBe('case.decided');
  });

  it('carry a binding proof on every oxy_user, as §11.14 requires', () => {
    const envelope = caseEnvelopeFixture();

    expect(envelope.principalBindings[0]).toMatchObject({
      type: 'oxy_user',
      bindingProofId: expect.any(String) as unknown as string,
    });
  });

  it('keep §7.5 material away from a community jury when asked to allege it', () => {
    const envelope = caseEnvelopeFixture({
      allegations: ['child_safety.exploitation'],
      allowCommunityReview: false,
    });

    expect(envelope.privacy.allowCommunityReview).toBe(false);
  });

  it('produce a decision whose jury arithmetic actually adds up', () => {
    const decision = decisionFixture();

    expect(decision.jury.agreement).toBe(decision.jury.winningVotes / decision.jury.decisiveVotes);
  });
});

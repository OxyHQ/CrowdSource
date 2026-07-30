/**
 * A report goes out and a decision comes back — every piece the real one.
 *
 * A user reports a widget → intake stores it with its delivery event in one
 * transaction → the real dispatcher delivers it with the real client → the
 * sandbox applies the real ingestion rules and opens a case → a decision is
 * published → a genuinely signed webhook reaches the receiver over a real socket
 * → the same dispatcher applies the decision → enforcement changes the widget.
 *
 * Nothing between those steps is stubbed. The one substitution is the SERVICE:
 * `@oxyhq/crowdsource-testing`'s sandbox stands in for CrowdSource itself, and
 * it applies the real rules. This is the test an adopter should copy.
 */

import { CrowdSource } from '@oxyhq/crowdsource';
import {
  createCrowdSourceSandbox,
  WebhookSimulator,
  type CrowdSourceSandbox,
} from '@oxyhq/crowdsource-testing';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './support/harness.js';
import { startWebhookApp, type RunningWebhookApp } from './support/webhookApp.js';

const WEBHOOK_SECRET = 'whsec_test_0123456789abcdef0123456789abcdef';

let harness: Harness | null = null;
let app: RunningWebhookApp | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
  await harness?.close();
  harness = null;
});

async function wire(
  options: { enforcementMode?: 'observe' | 'manual' | 'automatic' } = {},
): Promise<{ sandbox: CrowdSourceSandbox; harness: Harness; app: RunningWebhookApp }> {
  const sandbox = createCrowdSourceSandbox({ webhookSecret: WEBHOOK_SECRET });
  const built = await createHarness({
    serviceKey: sandbox.serviceKey,
    baseUrl: sandbox.baseUrl,
    webhookSecret: WEBHOOK_SECRET,
    ...(options.enforcementMode === undefined
      ? {}
      : { enforcementMode: options.enforcementMode }),
  });
  harness = built;

  /**
   * The one seam: the sandbox is reached through its own `fetch` rather than a
   * socket, so the client the delivery worker uses has to be built with it. The
   * provider is otherwise the real one, built from the real service key.
   */
  const client = new CrowdSource({
    serviceKey: sandbox.serviceKey,
    baseUrl: sandbox.baseUrl,
    fetch: sandbox.fetch,
  });
  built.moderation.client.get = () => client;

  app = await startWebhookApp(built.moderation);
  return { sandbox, harness: built, app };
}

async function eventually(assertion: () => Promise<void>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error: unknown) {
      lastError = error;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

describe('report in, decision out', () => {
  it('carries a report to a case, a decision back, and a restricted widget', async () => {
    const wired = await wire();
    const widget = await wired.harness.widgets.create({
      body: 'buy cheap watches',
      ownerId: 'oxy-owner',
    });

    // --- The user reports it. One transaction, two rows.
    const { report, outboxEventId } = await wired.harness.moderation.createReport({
      reporter: 'oxy-reporter',
      reportedType: 'widget',
      reportedId: String(widget._id),
      categories: ['spam'],
    });
    expect(report.localStatus).toBe('queued');
    expect(outboxEventId).toBeDefined();

    // --- Delivery.
    wired.harness.moderation.dispatcher.start();
    await eventually(async () => {
      const row = await wired.harness.reports.findById(report._id).lean();
      expect(row?.localStatus).toBe('submitted');
    });

    const submitted = await wired.harness.reports.findById(report._id).lean();
    expect(submitted?.crowdSourceCaseId).toBeDefined();
    expect(submitted?.contentSnapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const caseId = submitted?.crowdSourceCaseId;
    if (caseId === undefined) throw new Error('the report was never given a case id');

    // --- CrowdSource decides and signs the delivery.
    const decision = wired.sandbox.decide(caseId, { outcome: 'violation' });
    const simulator = new WebhookSimulator({ secret: WEBHOOK_SECRET, url: wired.app.url });
    const delivered = await simulator.deliver(wired.sandbox.eventFor(decision));
    expect(delivered.status).toBeLessThan(300);

    // --- The decision reaches the widget.
    await eventually(async () => {
      expect(await wired.harness.widgets.findById(widget._id).lean()).toMatchObject({
        status: 'restricted',
      });
    });
    await wired.harness.moderation.dispatcher.stop();

    const decided = await wired.harness.reports.findById(report._id).lean();
    expect(decided?.localStatus).toBe('closed');
    expect(decided?.decisionOutcome).toBe('violation');
    expect(decided?.decisionRevision).toBe(decision.revision);
    expect(decided?.enforcedAction).toBe('restrict');
    // The legacy verdict field, derived from the decision and nowhere else.
    expect(decided?.legacyStatus).toBe('resolved');
  });

  it('leaves the widget alone in observe mode, and still records the plan', async () => {
    const wired = await wire({ enforcementMode: 'observe' });
    const widget = await wired.harness.widgets.create({
      body: 'buy cheap watches',
      ownerId: 'oxy-owner',
    });
    const { report } = await wired.harness.moderation.createReport({
      reporter: 'oxy-reporter',
      reportedType: 'widget',
      reportedId: String(widget._id),
      categories: ['spam'],
    });

    wired.harness.moderation.dispatcher.start();
    await eventually(async () => {
      const row = await wired.harness.reports.findById(report._id).lean();
      expect(row?.localStatus).toBe('submitted');
    });

    const stored = await wired.harness.reports.findById(report._id).lean();
    const caseId = stored?.crowdSourceCaseId;
    if (caseId === undefined) throw new Error('the report was never given a case id');

    const simulator = new WebhookSimulator({ secret: WEBHOOK_SECRET, url: wired.app.url });
    await simulator.deliver(
      wired.sandbox.eventFor(wired.sandbox.decide(caseId, { outcome: 'violation' })),
    );

    await eventually(async () => {
      expect(
        await wired.harness.moderation.models.enforcement.countDocuments({}),
      ).toBeGreaterThan(0);
    });
    await wired.harness.moderation.dispatcher.stop();

    /**
     * The plan, the claim and the audit row are identical to production. Only
     * the effect is gated — which is what makes observe mode a real rehearsal
     * rather than a log line saying a decision was seen.
     */
    const enforcement = await wired.harness.moderation.models.enforcement
      .findOne({})
      .lean();
    expect(enforcement?.applied).toBe(false);
    expect(enforcement?.mode).toBe('observe');
    expect(enforcement?.skippedReason).toContain('observe mode');
    expect(await wired.harness.widgets.findById(widget._id).lean()).toMatchObject({
      status: 'published',
    });
  });

  it('restores the widget when a correction supersedes the removal', async () => {
    const wired = await wire();
    const widget = await wired.harness.widgets.create({
      body: 'buy cheap watches',
      ownerId: 'oxy-owner',
    });
    const { report } = await wired.harness.moderation.createReport({
      reporter: 'oxy-reporter',
      reportedType: 'widget',
      reportedId: String(widget._id),
      categories: ['spam'],
    });

    wired.harness.moderation.dispatcher.start();
    await eventually(async () => {
      const row = await wired.harness.reports.findById(report._id).lean();
      expect(row?.localStatus).toBe('submitted');
    });
    const caseId = (await wired.harness.reports.findById(report._id).lean())
      ?.crowdSourceCaseId;
    if (caseId === undefined) throw new Error('the report was never given a case id');

    const simulator = new WebhookSimulator({ secret: WEBHOOK_SECRET, url: wired.app.url });
    await simulator.deliver(
      wired.sandbox.eventFor(wired.sandbox.decide(caseId, { outcome: 'violation' })),
    );
    await eventually(async () => {
      expect(await wired.harness.widgets.findById(widget._id).lean()).toMatchObject({
        status: 'restricted',
      });
    });

    /**
     * The correction. Its recommendation is `no_action` — "take no NEW action",
     * not "leave the removal in place" — so the restore has to come from the
     * planner rather than from the wire, or the widget stays removed forever.
     */
    const correction = wired.sandbox.decide(caseId, {
      outcome: 'no_violation',
      status: 'corrected',
    });
    expect(correction.recommendedActions.map((entry) => entry.action)).toEqual([
      'no_action',
    ]);
    await simulator.deliver(wired.sandbox.eventFor(correction));

    await eventually(async () => {
      expect(await wired.harness.widgets.findById(widget._id).lean()).toMatchObject({
        status: 'published',
      });
    });
    await wired.harness.moderation.dispatcher.stop();

    const corrected = await wired.harness.reports.findById(report._id).lean();
    expect(corrected?.decisionRevision).toBe(correction.revision);
    expect(corrected?.decisionOutcome).toBe('no_violation');
    expect(corrected?.legacyStatus).toBe('dismissed');
  });
});

describe('the report records what was effectively done', () => {
  it('uses the effective action for a subject no lever can act on', async () => {
    /**
     * End to end, because the claim being tested is about the REPORT: a `doodad`
     * is deliverable — a jury reviews it — but no action in the table can act on
     * it. The plan is subject-blind and names `restrict`; `apply` says it
     * amounted to nothing; the report must read the latter.
     *
     * Without this the report would say "decided: restrict" about an object
     * nothing restricted, which is the imprecision `noted-moovo` measured across
     * the majority of Moovo's `no_violation` outcomes.
     */
    const wired = await wire();
    const { report } = await wired.harness.moderation.createReport({
      reporter: 'oxy-reporter',
      reportedType: 'doodad',
      reportedId: 'doodad-1',
      categories: ['spam'],
    });

    wired.harness.moderation.dispatcher.start();
    await eventually(async () => {
      const row = await wired.harness.reports.findById(report._id).lean();
      expect(row?.localStatus).toBe('submitted');
    });
    const caseId = (await wired.harness.reports.findById(report._id).lean())
      ?.crowdSourceCaseId;
    if (caseId === undefined) throw new Error('the report was never given a case id');

    const simulator = new WebhookSimulator({ secret: WEBHOOK_SECRET, url: wired.app.url });
    await simulator.deliver(
      wired.sandbox.eventFor(wired.sandbox.decide(caseId, { outcome: 'violation' })),
    );

    await eventually(async () => {
      const row = await wired.harness.reports.findById(report._id).lean();
      expect(row?.decisionOutcome).toBe('violation');
    });
    await wired.harness.moderation.dispatcher.stop();

    const decided = await wired.harness.reports.findById(report._id).lean();
    expect(decided?.enforcedAction).toBe('none');
    expect(decided?.enforcedAt).toBeUndefined();
  });
});

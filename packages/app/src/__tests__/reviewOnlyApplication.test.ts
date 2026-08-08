/**
 * An application that can REVIEW but cannot ENFORCE.
 *
 * Not a stub and not an unfinished integration: some applications have no
 * platform-level sanction primitive at all. An end-to-end encrypted messenger is
 * the clearest case — the server cannot read the material, so it cannot label
 * it, and its block/restrict relations are written by one user about their own
 * inbox rather than by the platform about an account. There is nothing for a
 * decision worker to carry out, and writing those relations on a user's behalf
 * because a field said `violation` would be a product decision made by a queue.
 *
 * So the supported shape is: plan, claim, record — and apply nothing. What must
 * NOT happen is the record quietly claiming otherwise, which is what these tests
 * pin. `enforcedAction` says what the application decided; `enforcedAt` says an
 * effect landed. An application with no primitive must never get the second.
 *
 * Credit: `allo` raised this as a possible wrong assumption in the extension
 * points, and it was.
 */

import { WebhookSimulator } from '@oxyhq/crowdsource-testing';
import { afterEach, describe, expect, it } from 'vitest';
import { planEnforcement } from '../enforcement/planner.js';
import { decision } from './support/decisions.js';
import { BACKENDS } from './support/backends.js';
import {
  REVIEW_ONLY,
  REVIEW_ONLY_WEBHOOK_SECRET,
  type ReviewOnlyHarness,
} from './support/reviewOnlyApplication.js';
import { startWebhookApp, type RunningWebhookApp } from './support/webhookApp.js';

/**
 * Both backends, one suite. The leaf test names are unchanged: vitest prints
 * `mongoose > <name>` and `postgres > <name>`, and the mutation script matches on
 * the leaf.
 */
describe.each(BACKENDS)('$name', (backend) => {

  let wired: ReviewOnlyHarness | null = null;
  let app: RunningWebhookApp | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
    await wired?.close();
    wired = null;
  });

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

  describe('an application with no enforcement primitive', () => {
    it('needs three fields and no apply', () => {
      // The compiler is the assertion here: this object satisfies the interface.
      expect(REVIEW_ONLY.apply).toBeUndefined();
      expect(REVIEW_ONLY.severityFallback).toBeUndefined();
      expect(REVIEW_ONLY.precedence).toBeUndefined();
      expect(REVIEW_ONLY.restoreAction).toBeNull();
    });

    it('still plans exactly one real action for every outcome', () => {
      // The plan is never empty, so there is always something to record.
      for (const outcome of ['violation', 'no_violation', 'inconclusive', 'duplicate'] as const) {
        const plan = planEnforcement(
          decision({ outcome, findings: outcome === 'violation' ? undefined : [] }),
          REVIEW_ONLY,
        );
        expect(plan).toHaveLength(1);
        expect(plan[0].reason).not.toHaveLength(0);
      }
    });

    it('plans an explicit nothing for no_violation rather than a restore it cannot do', () => {
      const plan = planEnforcement(
        decision({ outcome: 'no_violation', findings: [], recommendedActions: [] }),
        REVIEW_ONLY,
      );
      expect(plan[0].action).toBe('none');
      expect(plan[0].reason).toContain('nothing to restore');
    });

    it('does not wake a human for a recommendation that asks for no effect', () => {
      /**
       * With no `recommendationToAction` at all, `no_action` must still mean
       * nothing rather than falling through to review — otherwise every cleared
       * case queues a human and buries the ones that need looking at.
       */
      const plan = planEnforcement(
        decision({
          outcome: 'no_violation',
          findings: [],
          recommendedActions: [{ action: 'no_action' }],
        }),
        REVIEW_ONLY,
      );
      expect(plan.map((entry) => entry.action)).toEqual(['none']);
    });

    it('sends a recommendation it cannot carry out to review, recorded with its origin', () => {
      const plan = planEnforcement(
        decision({ recommendedActions: [{ action: 'remove' }] }),
        REVIEW_ONLY,
      );
      expect(plan.map((entry) => entry.action)).toEqual(['review']);
      expect(plan[0].recommendedAction).toBe('remove');
    });

    it('falls back to review for a violation with no recommendation and no severity table', () => {
      expect(
        planEnforcement(decision({ recommendedActions: [] }), REVIEW_ONLY).map(
          (entry) => entry.action,
        ),
      ).toEqual(['review']);
    });

    it('records the decision, and never claims an effect it did not have', async () => {
      const built = await backend.createReviewOnlyHarness();
      wired = built;
      app = await startWebhookApp(built.moderation);

      const { report } = await built.moderation.createReport({
        reporter: 'oxy-reporter',
        reportedType: 'account',
        reportedId: 'oxy-reported-account',
        categories: ['harassment'],
      });

      built.moderation.dispatcher.start();
      await eventually(async () => {
        const row = await built.readReport(report.id);
        expect(row?.localStatus).toBe('submitted');
      });

      const caseId = (await built.readReport(report.id))?.crowdSourceCaseId;
      if (caseId === undefined) throw new Error('the report was never given a case id');

      const simulator = new WebhookSimulator({ secret: REVIEW_ONLY_WEBHOOK_SECRET, url: app.url });
      await simulator.deliver(
        built.sandbox.eventFor(built.sandbox.decide(caseId, { outcome: 'violation' })),
      );

      await eventually(async () => {
        const row = await built.readReport(report.id);
        expect(row?.decisionOutcome).toBe('violation');
      });
      await built.moderation.dispatcher.stop();

      const decided = await built.readReport(report.id);
      // What the application DECIDED is recorded…
      expect(decided?.enforcedAction).toBe('review');
      // …and what it did is not claimed, because it did nothing.
      expect(decided?.enforcedAt).toBeUndefined();
      expect(decided?.localStatus).toBe('closed');

      // The audit row exists and is honest about why nothing happened.
      const [enforcement] = await built.enforcement.rows();
      expect(enforcement.action).toBe('review');
      expect(enforcement.applied).toBe(false);
      expect(enforcement.mode).toBe('automatic');
      expect(enforcement.skippedReason).toContain('no enforcement primitive');
    });

    it('keeps the idempotency claim, so a redelivered decision is still recorded once', async () => {
      const built = await backend.createReviewOnlyHarness();
      wired = built;
      app = await startWebhookApp(built.moderation);

      const { report } = await built.moderation.createReport({
        reporter: 'oxy-reporter',
        reportedType: 'account',
        reportedId: 'oxy-reported-account',
        categories: ['harassment'],
      });

      built.moderation.dispatcher.start();
      await eventually(async () => {
        const row = await built.readReport(report.id);
        expect(row?.localStatus).toBe('submitted');
      });
      const caseId = (await built.readReport(report.id))?.crowdSourceCaseId;
      if (caseId === undefined) throw new Error('the report was never given a case id');

      const simulator = new WebhookSimulator({ secret: REVIEW_ONLY_WEBHOOK_SECRET, url: app.url });
      const event = built.sandbox.eventFor(
        built.sandbox.decide(caseId, { outcome: 'violation' }),
      );
      await simulator.deliver(event);
      await simulator.deliver(event);

      await eventually(async () => {
        expect((await built.enforcement.rows()).length).toBeGreaterThan(0);
      });
      await built.moderation.dispatcher.stop();

      /**
       * One row, because the claim is keyed on `decisionId + revision + action`
       * and that machinery is the package's regardless of whether the application
       * can act. An application with no primitive still gets exactly-once
       * bookkeeping.
       */
      expect(await built.enforcement.rows()).toHaveLength(1);
      expect(await built.events.count()).toBe(1);
    });
  });

});

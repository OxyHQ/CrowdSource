import { CrowdSource } from '@oxyhq/crowdsource';
import { createCrowdSourceSandbox, type CrowdSourceSandbox } from '@oxyhq/crowdsource-testing';
import { createModerationIntegration, type ModerationIntegration } from '../../integration.js';
import type { ModerationStore } from '../../store/types.js';
import type { ModerationEnforcementConfig, ModerationReportFields } from '../../types.js';
import type { HarnessEnforcement, HarnessEvents } from './backend.js';

/**
 * A SECOND fictional application: one with nothing to enforce with.
 *
 * The main harness's application has levers — it restricts, flags and restores —
 * and most of this package's behaviour is only visible on one that does not. An
 * application with no `apply` at all still plans, still claims, still records and
 * still closes its reports, and every one of those is a property somebody would
 * otherwise discover by adopting the package and finding nothing happens.
 *
 * This module is the part of it that has NO driver in it: the enforcement table,
 * the subject provider, the taxonomy, the sandbox and the integration. Each
 * backend supplies the store and the row reads, in its own factory.
 */

export type ReviewOnlyAction = 'none' | 'review';
export type ReviewOnlyReport = ModerationReportFields;

/**
 * The whole enforcement config for an application with nothing to enforce with.
 *
 * Three fields. No `apply`, no `severityFallback`, no `precedence`, no `absorb`,
 * no `reversibleActions`, no `reverses` — and `restoreAction: null`, which the
 * type REQUIRES so that "there is nothing to restore" is a written decision
 * rather than a key somebody forgot.
 */
export const REVIEW_ONLY: ModerationEnforcementConfig<ReviewOnlyAction> = {
  actions: ['review', 'none'],
  noneAction: 'none',
  reviewAction: 'review',
  restoreAction: null,
};

/**
 * The signing secret this application's webhook receiver is configured with.
 *
 * Shared with the test file's simulator: a receiver and a simulator that disagree
 * about the secret produce `400 malformed_event`, which reads as a delivery
 * problem rather than a fixture one.
 */
export const REVIEW_ONLY_WEBHOOK_SECRET = 'whsec_test_0123456789abcdef0123456789abcdef';

/**
 * Its own small façade rather than the shared `Harness`, because it is a different
 * application: no widgets, no enforcement lever, its own report table. It reads
 * rows through the SAME façade sub-objects, which is what keeps the assertions in
 * the test file free of a driver.
 */
export interface ReviewOnlyHarness {
  sandbox: CrowdSourceSandbox;
  moderation: ModerationIntegration<ReviewOnlyReport, ReviewOnlyAction>;
  readReport(id: string): Promise<ReviewOnlyReport | null>;
  events: HarnessEvents;
  enforcement: HarnessEnforcement;
  close(): Promise<void>;
}

/** Everything above the store, wired the way an adopter with no levers wires it. */
export function reviewOnlyIntegration(input: {
  store: ModerationStore<ReviewOnlyReport, unknown>;
}): {
  sandbox: CrowdSourceSandbox;
  moderation: ModerationIntegration<ReviewOnlyReport, ReviewOnlyAction>;
} {
  const sandbox = createCrowdSourceSandbox({ webhookSecret: REVIEW_ONLY_WEBHOOK_SECRET });

  const moderation = createModerationIntegration({
    store: input.store,
    crowdSource: {
      enabled: true,
      serviceKey: sandbox.serviceKey,
      baseUrl: sandbox.baseUrl,
      webhookSecret: REVIEW_ONLY_WEBHOOK_SECRET,
      // `automatic` deliberately: the point is that an application with no
      // primitive applies nothing even when the mode permits everything.
      enforcementMode: 'automatic',
      outboxPollIntervalMs: 50,
    },
    subjects: [
      {
        reportedType: 'account',
        subjectType: 'identity.profile',
        async snapshot(reportedId) {
          return {
            subject: { externalId: reportedId, type: 'identity.profile' },
            content: { type: 'profile', data: { displayName: 'a reported account' } },
          };
        },
      },
    ],
    taxonomy: {
      version: '2026.07',
      allegationsFor: () => ['harassment.targeted_abuse'],
    },
    enforcement: REVIEW_ONLY,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });

  moderation.client.get = () =>
    new CrowdSource({
      serviceKey: sandbox.serviceKey,
      baseUrl: sandbox.baseUrl,
      fetch: sandbox.fetch,
    });

  return { sandbox, moderation };
}

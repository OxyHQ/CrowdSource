/**
 * `@oxyhq/crowdsource-testing` — integrate against CrowdSource before a jury
 * exists.
 *
 * ```ts
 * import { createCrowdSourceSandbox } from '@oxyhq/crowdsource-testing';
 * import { CrowdSource } from '@oxyhq/crowdsource';
 *
 * const sandbox = createCrowdSourceSandbox();
 * const crowdsource = new CrowdSource({
 *   serviceKey: sandbox.serviceKey,
 *   baseUrl: sandbox.baseUrl,
 *   fetch: sandbox.fetch,
 * });
 *
 * const { caseId } = await crowdsource.reports.create({ ... });
 * const decision = sandbox.decide(caseId, { outcome: 'violation' });
 * await sandbox.deliver('http://localhost:3000/webhooks/crowdsource', sandbox.eventFor(decision));
 * ```
 *
 * The report goes through the real client, the sandbox applies the real rules
 * (tenant from the credential, idempotency, 409 on a changed body, one case per
 * reported version), and the webhook that comes back is genuinely signed — so
 * the receiver being tested is the receiver that will run in production.
 *
 * The simulator can also deliver a stale, forged or tampered event on purpose.
 * Asserting that a receiver REFUSES those is the half of a webhook test that
 * actually proves something.
 */

export {
  caseDecidedEventFixture,
  caseEnvelopeFixture,
  decisionFixture,
} from './fixtures.js';
export type {
  CaseEnvelopeFixtureOptions,
  DecisionFixtureOptions,
  WebhookEventFixtureOptions,
} from './fixtures.js';

export { CrowdSourceSandbox, createCrowdSourceSandbox } from './sandbox.js';
export type {
  CrowdSourceSandboxOptions,
  SandboxCase,
  SandboxDecisionInput,
  SandboxReport,
} from './sandbox.js';

export { WebhookSimulator, signWebhookDelivery } from './webhook-simulator.js';
export type {
  SignWebhookInput,
  SignedWebhookDelivery,
  WebhookDeliveryOverrides,
  WebhookDeliveryResult,
  WebhookSimulatorOptions,
} from './webhook-simulator.js';

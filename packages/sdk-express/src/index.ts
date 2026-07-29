/**
 * `@oxyhq/crowdsource-express` — receiving CrowdSource webhooks safely.
 *
 * The whole integration:
 *
 * ```ts
 * import { crowdsourceWebhooks } from '@oxyhq/crowdsource-express';
 *
 * app.post('/webhooks/crowdsource', crowdsourceWebhooks({
 *   on: {
 *     'case.decided': async (event) => {
 *       await moderationQueue.add(event.id, event.data);
 *     },
 *   },
 * }));
 * ```
 *
 * The secret comes from `CROWDSOURCE_WEBHOOK_SECRET`, the raw body is read by
 * the handler itself, the signature is verified in constant time over the bytes
 * that arrived, a stale or replayed delivery is refused, and an event type this
 * integration does not handle is acknowledged and ignored. None of that is
 * optional and none of it can be got wrong by mounting things in the wrong
 * order — see `middleware.ts` for what happens when a body parser gets there
 * first.
 */

export {
  crowdsourceWebhooks,
  CrowdSourceWebhookConfigurationError,
  WEBHOOK_PREVIOUS_SECRET_ENV_VAR,
  WEBHOOK_SECRET_ENV_VAR,
} from './middleware';
export type { CrowdSourceWebhooksOptions, WebhookEventHandlers } from './middleware';

export { memoryProcessedEventStore } from './store';
export type { MemoryProcessedEventStoreOptions, ProcessedEventStore } from './store';

export {
  signedPayloadBytes,
  verifyWebhookDelivery,
  WEBHOOK_REJECTIONS,
} from './verify';
export type { WebhookRejection, WebhookVerification, WebhookVerificationInput } from './verify';

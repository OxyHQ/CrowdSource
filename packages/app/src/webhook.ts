import { Router } from 'express';
import { crowdsourceWebhooks, type ProcessedEventStore } from '@oxyhq/crowdsource-express';
import type { InboundService } from './inbound';
import type { ModerationLogger, ModerationMetrics } from './types';

/**
 * `POST /crowdsource` — where decisions come back.
 *
 * ## The mount is part of the correctness
 *
 * This router MUST be mounted BEFORE `express.json()`. The signature covers
 * `timestamp + "." + rawBody` — the bytes that arrived — and once a JSON parser
 * has run, those bytes are gone. `@oxyhq/crowdsource-express` looks for a raw
 * Buffer; handed a parsed `req.body` it refuses and raises a configuration error
 * rather than verifying a signature over a re-serialisation. That refusal is the
 * correct behaviour and it is also why the mount order cannot be got wrong
 * silently.
 *
 * The property to TEST is not the mount order — that only proves the order. It
 * is that no parser ran: assert `typeof req.body === 'undefined'` from inside
 * the route.
 *
 * ## What this handler does and does not do
 *
 * It records and returns. A receiver should answer 2xx quickly and queue the
 * processing, and the reason is not latency: applying a decision means reading
 * objects, planning enforcement and writing several collections, and a receiver
 * that did all that inline would time out under a burst and be retried while the
 * first attempt was still running. So the event and a durable `decision.apply`
 * outbox row commit in ONE transaction, and the dispatcher does the work.
 *
 * Nothing here is authenticated by Oxy. The HMAC IS the authentication, and an
 * Oxy session must never satisfy this route — it is not a user endpoint.
 */

/**
 * One string field out of an event payload this version does not know.
 *
 * A webhook envelope's `data` is deliberately OPAQUE in the contract: an
 * unrecognised event's payload is whatever a newer CrowdSource decided to send,
 * and the exported type says so — property access on it does not compile. That
 * is the contract being honest rather than an obstacle, so this reads the key
 * defensively instead of asserting a shape nobody has verified. Anything that is
 * not a string is treated as absent, which is the only safe reading of a field
 * this deployment has never seen.
 */
function stringField(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const value: unknown = Reflect.get(source, key);
  return typeof value === 'string' ? value : undefined;
}

export function createWebhookRouter(input: {
  inbound: InboundService;
  store: ProcessedEventStore;
  secret?: string;
  previousSecret?: string;
  logger: ModerationLogger;
  metrics?: ModerationMetrics;
  /** Defaults to `/crowdsource`. */
  path?: string;
}): Router {
  const router = Router();

  if (!input.secret) {
    /**
     * Not mounted, rather than mounted and permissive.
     *
     * A route that answers anything at all without a secret is a route that will
     * one day be reasoned about as if it verified something. An unconfigured
     * deployment 404s here, which is indistinguishable from not having the
     * feature — which is exactly what it is.
     */
    input.logger.info(
      '[CrowdSource] webhook route not mounted: no webhook secret is configured',
    );
    return router;
  }

  router.post(
    input.path ?? '/crowdsource',
    crowdsourceWebhooks({
      secret: input.secret,
      ...(input.previousSecret === undefined
        ? {}
        : { previousSecret: input.previousSecret }),
      // Shared across tasks: the in-process default would dedupe only the
      // instance that happened to receive both copies of a redelivery.
      store: input.store,
      on: {
        /**
         * A decision, provisional or final. Both are queued: a provisional
         * decision is real and is recorded; what may be ACTED on is decided by
         * the enforcement mode, not by discarding the event here.
         */
        'case.decided': async (event) => {
          await input.inbound.recordDecisionEvent({
            eventId: event.id,
            type: event.type,
            caseId: event.data.caseId,
            decision: event.data.decision,
          });
        },
        /**
         * A later revision replacing an earlier one. The SAME path: the decision
         * worker compares revisions and the enforcement executor reverses what
         * the superseded revision did. A correction is not a special case with
         * its own code — it is an ordinary decision that supersedes another, and
         * giving it a separate path is how a restore ends up not being
         * idempotent.
         */
        'decision.corrected': async (event) => {
          await input.inbound.recordDecisionEvent({
            eventId: event.id,
            type: event.type,
            caseId: event.data.caseId,
            decision: event.data.decision,
          });
        },
        /**
         * An appeal's outcome carries a decision too, and it is the current
         * answer for the case, so it takes the same path.
         */
        'appeal.decided': async (event) => {
          await input.inbound.recordDecisionEvent({
            eventId: event.id,
            type: event.type,
            caseId: event.data.caseId,
            decision: event.data.decision,
          });
        },
      },
      /**
       * Every other event type — including one this version of the contracts
       * package has never heard of.
       *
       * Recorded rather than dropped. `case.created`, `case.escalated` and
       * `case.closed` carry no decision and nothing to enforce, but "did
       * CrowdSource tell us about this case, and when" is the first question
       * asked when a report appears stuck, and the answer has to exist
       * somewhere.
       */
      onUnhandled: async (event) => {
        const caseId = stringField(event.data, 'caseId');
        await input.inbound.recordIgnoredEvent({
          eventId: event.id,
          type: event.type,
          ...(caseId === undefined ? {} : { caseId }),
        });
      },
      /**
       * A refusal reason and nothing else — never a body, a header or a
       * signature. It is a bounded label, so it can be a metric.
       */
      onRejected: (rejection) => {
        input.metrics?.incrementCounter('crowdsource_webhook_rejected_total', 1, {
          rejection,
        });
        input.logger.warn('[CrowdSource] webhook delivery refused', { rejection });
      },
    }),
  );

  return router;
}

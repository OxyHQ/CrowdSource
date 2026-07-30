import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express, { type Express, type Request } from 'express';
import type { ModerationIntegration } from '../../integration';
import type { ModerationReportFields } from '../../types';

/**
 * An application's HTTP wiring, with the mount order in ONE place.
 *
 * It lives in its own module for two reasons. It is what an adopter copies, so
 * it should be readable as an example; and it is the single line the mutation
 * test flips to prove the raw-body assertion can fail — see
 * `scripts/test-invariants.mjs`.
 */

export interface WebhookAppOptions {
  /**
   * Where `express.json()` goes relative to the webhook router.
   *
   * `'after'` is correct: the signature covers the bytes that arrived, and a
   * parser consumes them. `'before'` is the mistake this package is built to
   * make impossible to ship silently, and it is exercised on purpose.
   */
  jsonParser?: 'after' | 'before';
  path?: string;
}

export interface RunningWebhookApp {
  url: string;
  /**
   * What `req.body` was, per request, at the point in the middleware chain
   * IMMEDIATELY BEFORE the moderation router.
   *
   * This is the assertion that proves the property rather than the arrangement.
   * Checking the mount order would only prove the order; checking that the
   * handler is reached with `req.body` still `undefined` proves that no parser
   * ran on the bytes it is about to verify.
   */
  bodyTypeAtRouter: string[];
  close(): Promise<void>;
}

export async function startWebhookApp<
  TReport extends ModerationReportFields,
  TAction extends string,
>(
  moderation: ModerationIntegration<TReport, TAction>,
  options: WebhookAppOptions = {},
): Promise<RunningWebhookApp> {
  const path = options.path ?? '/webhooks';
  const bodyTypeAtRouter: string[] = [];
  const app: Express = express();

  if (options.jsonParser === 'before') app.use(express.json());

  // The probe sits at the last position before the router, so it observes
  // exactly what the router's handler will observe.
  app.use(path, (req: Request, _response, next) => {
    bodyTypeAtRouter.push(typeof req.body);
    next();
  });

  app.use(path, moderation.webhookRouter());

  if (options.jsonParser !== 'before') app.use(express.json());

  const server = app.listen(0);
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The test webhook app did not bind a port.');
  }
  const { port } = address satisfies AddressInfo;

  return {
    url: `http://127.0.0.1:${port}${path}/crowdsource`,
    bodyTypeAtRouter,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

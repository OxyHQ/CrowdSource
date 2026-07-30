import { createOxyCors } from '@oxyhq/core/server';
import compression from 'compression';
import express, { type Express, Router } from 'express';
import helmet from 'helmet';

import { errorHandler, notFoundHandler } from './http/errorHandler';
import { appealsRouter } from './modules/appeals/appeals.routes';
import { casesRouter } from './modules/cases/cases.routes';
import { consoleRouter } from './modules/console/console.routes';
import { trustSafetyRouter } from './modules/console/trustSafety.routes';
import { decisionsRouter } from './modules/decision/decisions.routes';
import { reportsRouter } from './modules/ingestion/reports.routes';
import { reviewerRouter } from './modules/reviewer/reviewer.routes';
import { assignmentsRouter } from './modules/sortition/assignments.routes';
import { webhookEndpointsRouter } from './modules/webhooks/webhookEndpoints.routes';
import { healthRouter } from './routes/health.routes';

/**
 * Builds the HTTP application.
 *
 * This function opens no connections, starts no timers and registers no
 * process-level handlers — `server.ts` owns all of that — so tests can exercise
 * the application without a runtime around it.
 *
 * The moderation modules of the plan mount here as they are built. Two caller
 * classes now have a surface, and neither may satisfy the other's routes:
 * SERVICE CREDENTIALS reach ingestion, case and decision read-back and webhook
 * endpoint management; an OXY SESSION reaches the reviewer and assignment routes
 * and the console. Evidence, the policy registry, triage, sortition's draw,
 * CONSENSUS and webhook DELIVERY have no HTTP surface of their own — the first is
 * reached through ingestion and the rest through the outbox and their workers,
 * which is what keeps "nobody chooses the case they review" and "no reviewer sees
 * a partial result" true by there being nothing to ask. The reputation bridge is
 * not written.
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  // One proxy hop: the shared ALB terminates TLS and sets X-Forwarded-*.
  // A permissive value would let a client forge its own client address.
  app.set('trust proxy', 1);

  app.use(helmet());
  /**
   * Deny-by-default CORS from `@oxyhq/core/server`, never a hand-rolled
   * allowlist: the shared helper echoes the exact matched origin, refuses to
   * reflect an arbitrary one, and never pairs a wildcard with credentials.
   *
   * The reviewer app at `crowdsource.oxy.so` needs no entry — the helper
   * already allows the HTTPS `oxy.so` apex family. A console on its own
   * hostname outside that family would go in `appOrigins`.
   */
  app.use(createOxyCors());
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));

  app.use('/health', healthRouter);

  /**
   * The application API (§10.2). Every route below authenticates a SERVICE
   * CREDENTIAL and derives its tenant from it. Reviewer and Trust & Safety
   * routes are a different caller class — an Oxy session — and will mount on
   * their own paths; neither may ever satisfy the other's middleware.
   */
  const v1: Router = Router();
  v1.use(reportsRouter);
  v1.use(casesRouter);
  v1.use(appealsRouter);
  v1.use(decisionsRouter);
  v1.use(webhookEndpointsRouter);

  /**
   * The reviewer API (§10.3). A different caller class entirely: an Oxy session,
   * verified through `@oxyhq/core/server`, carrying no tenant — a reviewer is
   * drawn across every application. A service credential never satisfies these
   * routes and an Oxy session never satisfies the ones above.
   *
   * Note there is no case id anywhere below. Every reviewer route is addressed
   * by ASSIGNMENT, which is what makes "nobody chooses the case they review" a
   * property of the routing table rather than a rule somebody enforces.
   */
  v1.use(reviewerRouter);
  v1.use(assignmentsRouter);

  /**
   * The console (§4.2, §4.3). A THIRD authorization on the second caller class: the
   * same Oxy session as the reviewer surface, and then either an organization
   * membership or a Trust & Safety role.
   *
   * The two routers are separate because the audiences are a security boundary, not a
   * navigation choice. `consoleRouter` is scoped to one tenant on every route, derived
   * from the stored application row after a membership check; `trustSafetyRouter` sees
   * across tenants and every route on it requires a staff role. A developer cannot
   * reach the second, and neither can a service credential reach either — the shared
   * SDK does not recognise a service token as a session, so it never reaches a
   * handler.
   */
  v1.use(consoleRouter);
  v1.use(trustSafetyRouter);

  app.use('/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

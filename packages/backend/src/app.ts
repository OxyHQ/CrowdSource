import compression from 'compression';
import express, { type Express, Router } from 'express';
import helmet from 'helmet';

import { errorHandler, notFoundHandler } from './http/errorHandler';
import { casesRouter } from './modules/cases/cases.routes';
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
 * SERVICE CREDENTIALS reach ingestion, case read-back and webhook endpoint
 * management; an OXY SESSION reaches the reviewer and assignment routes.
 * Evidence, the policy registry, triage, sortition's draw and webhook DELIVERY
 * have no HTTP surface of their own — the first is reached through ingestion and
 * the rest through the outbox and their workers. Consensus, decision and the
 * reputation bridge are not written.
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  // One proxy hop: the shared ALB terminates TLS and sets X-Forwarded-*.
  // A permissive value would let a client forge its own client address.
  app.set('trust proxy', 1);

  app.use(helmet());
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

  app.use('/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

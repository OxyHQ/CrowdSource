import compression from 'compression';
import express, { type Express, Router } from 'express';
import helmet from 'helmet';

import { errorHandler, notFoundHandler } from './http/errorHandler';
import { casesRouter } from './modules/cases/cases.routes';
import { reportsRouter } from './modules/ingestion/reports.routes';
import { healthRouter } from './routes/health.routes';

/**
 * Builds the HTTP application.
 *
 * This function opens no connections, starts no timers and registers no
 * process-level handlers — `server.ts` owns all of that — so tests can exercise
 * the application without a runtime around it.
 *
 * The moderation modules of the plan mount here as they are built. Today that is
 * ingestion and case read-back, both behind the tenancy module's
 * service-credential middleware. Evidence, the policy registry and triage exist
 * but have no HTTP surface of their own — the first is reached through ingestion
 * and the other two through the outbox. Sortition, review, consensus, decision,
 * webhook delivery and the reputation bridge are not written.
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
  app.use('/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

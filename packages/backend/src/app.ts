import compression from 'compression';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';

import { healthRouter } from './routes/health.routes';
import { logger } from './utils/logger';

/**
 * Builds the HTTP application.
 *
 * This function opens no connections, starts no timers and registers no
 * process-level handlers — `server.ts` owns all of that — so tests can exercise
 * the application without a runtime around it.
 *
 * The moderation modules of the plan (tenancy, ingestion, evidence, cases,
 * sortition, review, consensus, decision, webhook delivery, reputation bridge)
 * mount here as they are built. Nothing but health is served today.
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

  app.use((_request: Request, response: Response) => {
    response.status(404).json({
      error: { code: 'not_found', message: 'No route matches this request.' },
    });
  });

  app.use((error: Error, _request: Request, response: Response, _next: NextFunction) => {
    logger.error({ err: error }, 'Unhandled request error');
    response.status(500).json({
      error: { code: 'internal_error', message: 'The request could not be completed.' },
    });
  });

  return app;
}

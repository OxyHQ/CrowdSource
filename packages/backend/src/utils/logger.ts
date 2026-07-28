import pino from 'pino';

import { config } from '../config';

/**
 * Process-wide structured logger.
 *
 * Reviewer-facing material (report contents, evidence, reviewer identities) must
 * never reach logs, so nothing in this service logs a request body by default
 * and no transport is configured to capture one.
 */
export const logger = pino({
  level: config.logLevel,
  base: { service: 'crowdsource-backend' },
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie'],
    remove: true,
  },
});

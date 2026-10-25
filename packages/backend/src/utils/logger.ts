import pino from 'pino';

import { config } from '../config';

export const REDACTED_LOG_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  ...[
    'x-oxy-requester-token',
    'x-oxy-task-id',
    'x-oxy-requester-context',
    'x-oxy-capability-ticket',
    'x-oxy-presented-service-token',
    'x-oxy-presented-requester-context',
    'x-oxy-mcp-media-token',
  ].map((header) => `req.headers["${header}"]`),
  'req.serviceActingAs.requesterContext',
  'req.accessToken',
  'requesterContext',
  '*.requesterContext',
];

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
    paths: REDACTED_LOG_PATHS,
    remove: true,
  },
});

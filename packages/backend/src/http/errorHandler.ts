import type { ErrorRequestHandler, RequestHandler } from 'express';

import { logger } from '../utils/logger';
import { ApiError, isApiError } from './apiError';

/**
 * The single place a failure becomes a response.
 *
 * Routes throw; nothing formats an error itself. That is what keeps §10.5 a
 * contract rather than a convention — an integrator's retry logic branches on
 * these codes, so a handler that invents its own shape silently changes what a
 * caller does with a failure.
 */

/**
 * Translates the body parser's own failures.
 *
 * `express.json` rejects an oversized or malformed body before any route runs,
 * with an error carrying a `type`. Left unclassified it would surface as a 500,
 * telling an integrator that CrowdSource broke when in fact their payload did —
 * and a 500 invites the retry that §10.5 reserves for 503.
 */
function bodyParserFailure(error: unknown): ApiError | null {
  if (typeof error !== 'object' || error === null || !('type' in error)) return null;

  switch (error.type) {
    case 'entity.too.large':
      return new ApiError('payload_too_large', 'The request body exceeds the size limit.');
    case 'entity.parse.failed':
      return new ApiError('invalid_request', 'The request body is not valid JSON.');
    case 'encoding.unsupported':
      return new ApiError('invalid_request', 'The request body uses an unsupported encoding.');
    default:
      return null;
  }
}

/** Answers any request that matched no route. */
export const notFoundHandler: RequestHandler = (_request, response) => {
  response
    .status(404)
    .json(new ApiError('not_found', 'No route matches this request.').toResponseBody());
};

export const errorHandler: ErrorRequestHandler = (error: unknown, request, response, next) => {
  // Express requires the four-argument shape to recognise an error handler, and
  // delegates to its default if a response has already begun.
  if (response.headersSent) {
    next(error);
    return;
  }

  const apiError = isApiError(error) ? error : bodyParserFailure(error);

  if (apiError) {
    if (apiError.status === 401) {
      response.setHeader('WWW-Authenticate', 'Bearer realm="crowdsource"');
    }
    if (apiError.status >= 500) {
      // A 503 is the service telling a caller to retry; it has to be visible to
      // an operator, unlike an ordinary 4xx which is the caller's own doing.
      logger.error(
        {
          classification: 'api_error',
          code: apiError.code,
          method: request.method,
          path: request.path,
        },
        'Request failed with a server-side condition',
      );
    }
    response.status(apiError.status).json(apiError.toResponseBody());
    return;
  }

  // Anything else is a defect. Its message, stack and own properties may contain
  // reported material, so the logger receives only fixed classification fields.
  logger.error(
    {
      classification: 'unexpected_error',
      code: 'internal_error',
      method: request.method,
      path: request.path,
    },
    'Unhandled request error',
  );
  const internalError = new ApiError('internal_error', 'The request could not be completed.');
  response.status(internalError.status).json(internalError.toResponseBody());
};

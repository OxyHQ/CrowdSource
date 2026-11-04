import { OxyApiError } from '@oxy.so/core';
import {
  OxyAccessError,
  OxyAppPermissionError,
  OxyServer,
  accessErrorStatus,
  appPermissionErrorStatus,
} from '@oxy.so/core/server';
import type { RequestHandler } from 'express';

import { config } from '../../config';
import { ApiError } from '../../http/apiError';
import { workloadCredentials } from './workload';

/** CrowdSource's own Oxy application. */
export const CROWDSOURCE_OXY_APPLICATION_ID = '6a6947b30fe72510b411252f';

/** Canonical receiver identity; never an authority decision about the caller. */
export const CROWDSOURCE_SERVICE_AUDIENCE = `oxy-service:${CROWDSOURCE_OXY_APPLICATION_ID}`;

/**
 * The process's ONE Oxy client: session verification, service-token
 * verification, application permissions, calls as the person, account events
 * and files all go through it, authenticated as this workload.
 *
 * Built on first use rather than at import: `OXY_API_URL` has no default and the
 * application still boots without it (the application API with CrowdSource keys
 * does not need Oxy). A deployment that has not configured it answers `503` on
 * every surface that does — the capability is genuinely unavailable — rather than
 * pointing at a host nobody chose.
 */
let server: OxyServer | null = null;

export function oxyServiceServer(): OxyServer {
  if (server) return server;
  const apiUrl = config.oxy.apiUrl;
  if (!apiUrl) {
    throw new ApiError(
      'service_unavailable',
      'This surface is unavailable: this deployment has no Oxy API configured.',
    );
  }
  server = new OxyServer({
    baseURL: apiUrl,
    applicationId: CROWDSOURCE_OXY_APPLICATION_ID,
    serviceIdentity: 'when-anonymous',
    expectedAudience: CROWDSOURCE_SERVICE_AUDIENCE,
    workloadCredentials,
  });
  return server;
}

/**
 * Something built once FROM the server — a middleware, a limiter — and rebuilt
 * only if the server is: keyed by the server itself, so a reset can never leave
 * a middleware bound to a disposed client.
 */
export function perOxyServer<T>(build: (oxy: OxyServer) => T): () => T {
  const built = new WeakMap<OxyServer, T>();
  return () => {
    const oxy = oxyServiceServer();
    let value = built.get(oxy);
    if (value === undefined) {
      value = build(oxy);
      built.set(oxy, value);
    }
    return value;
  };
}

/**
 * A middleware built from the server on its first request. Built lazily so a
 * deployment without `OXY_API_URL` still boots; a request that needs Oxy there
 * is answered by the `503` building it throws.
 *
 * Deferred to directly rather than wrapped: Express middleware signals "stop
 * here" by NOT calling `next`, so wrapping the SDK's handler in a promise that
 * settles on `next` would deadlock the request the first time it refuses.
 */
export function oxyMiddleware(build: (oxy: OxyServer) => RequestHandler): RequestHandler {
  const middleware = perOxyServer(build);
  return (request, response, next) => {
    let handler: RequestHandler;
    try {
      handler = middleware();
    } catch (error: unknown) {
      next(error);
      return;
    }
    void Promise.resolve(handler(request, response, next)).catch(next);
  };
}

/** Test seam: forget the built client so a reconfigured environment is picked up. */
export function resetOxyServiceServer(): void {
  server?.dispose();
  server = null;
}

/** What to say for each outcome of an Oxy authority read. */
export interface OxyRefusalMessages {
  readonly denied: string;
  readonly unavailable: string;
}

/**
 * One mapping from an Oxy answer to this service's error convention.
 *
 * 401 means the session is gone; 403/404 is Oxy's definitive "no"; anything else
 * — a 5xx, a timeout, a malformed answer, a deployment with no application id —
 * is UNAVAILABLE (503), never a refusal. The SDK caches only positive answers, so
 * an outage answered here is asked again on the next request.
 */
export function oxyRefusal(error: unknown, messages: OxyRefusalMessages): ApiError {
  if (error instanceof ApiError) return error;
  const status =
    error instanceof OxyAccessError
      ? accessErrorStatus(error)
      : error instanceof OxyAppPermissionError
        ? appPermissionErrorStatus(error, 403)
        : error instanceof OxyApiError
          ? error.status === 401
            ? 401
            : error.status === 403 || error.status === 404
              ? 403
              : 503
          : 503;
  if (status === 401) return new ApiError('unauthorized', 'Your Oxy session is no longer valid.');
  if (status === 403 || status === 404) return new ApiError('forbidden', messages.denied);
  return new ApiError('service_unavailable', messages.unavailable);
}

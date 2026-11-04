import { CrowdSource, BASE_URL_ENV_VAR } from './client.js';
import { CROWDSOURCE_SERVICE_AUDIENCE, DEFAULT_BASE_URL } from './defaults.js';

/**
 * The first-party path: an Oxy service reaching CrowdSource as itself.
 *
 * The caller hands over the `OxyServer` its process already runs. That server
 * owns the workload identity, the token cache and the requester-proof transport;
 * this package owns none of them, imports nothing from `@oxy.so/core`, and never
 * builds a second server — a process has exactly one, and a client that made its
 * own would be a second token cache and a second identity that can disagree with
 * the first. The shapes below are structural, so any `@oxy.so/core` 7 server
 * satisfies them.
 */

export type OxyRequester = { accountId: string } & (
  | { token: string; taskId?: never; requesterContext?: never }
  | { taskId: string; token?: never; requesterContext?: never }
  | { requesterContext: string; token?: never; taskId?: never }
);

/** What this package needs of the caller's `OxyServer`: `createServiceClient`. */
export interface OxyServiceHost {
  createServiceClient(options: { baseURL: string; audience: string; requester?: OxyRequester }): {
    fetch: typeof globalThis.fetch;
    dispose(): void;
  };
}

export interface OxyServiceClientLogger {
  info(message: string, context: Record<string, unknown>): void;
  error(message: string, context: Record<string, unknown>): void;
}

export interface OxyServiceClientOptions {
  /** The process's one `OxyServer`. Required: this package never builds one. */
  readonly oxy: OxyServiceHost;
  readonly baseUrl?: string;
  readonly logger?: OxyServiceClientLogger;
  /** Optional originating account proof; never a naked account header. */
  readonly requester?: OxyRequester;
}

/**
 * A CrowdSource client that presents the caller's Oxy service token for
 * CrowdSource's registered audience, without application scopes.
 *
 * One client per call: the caller holds it (a module-level `const`, or the
 * outbox's provider) and `dispose()`s it. A requester-bound client belongs to
 * one account and must never be shared across accounts or requests.
 */
export function crowdSourceForOxyService(options: OxyServiceClientOptions): CrowdSource {
  const baseURL = options.baseUrl ?? process.env[BASE_URL_ENV_VAR] ?? DEFAULT_BASE_URL;
  const transport = options.oxy.createServiceClient({
    baseURL,
    audience: CROWDSOURCE_SERVICE_AUDIENCE,
    ...(options.requester ? { requester: { ...options.requester } } : {}),
  });
  const built = new CrowdSource({ baseUrl: baseURL, oxyTransport: transport });
  if (options.logger) {
    const logger = options.logger;
    void Promise.resolve(built.applicationId).then(
      (applicationId) => logger.info('[CrowdSource] client ready', { applicationId }),
      () => logger.error('[CrowdSource] tenant unavailable', { reason: 'binding lookup failed' }),
    );
  }
  return built;
}

import { CrowdSource, BASE_URL_ENV_VAR } from './client.js';
import { CROWDSOURCE_SERVICE_AUDIENCE, DEFAULT_BASE_URL } from './defaults.js';
import {
  hasOxyServiceSdk,
  oxySdkResolutionError,
  oxyServiceHost,
  type OxyServiceHost,
  type OxyRequester,
} from './oxySdk.js';

export interface OxyServiceClientLogger {
  info(message: string, context: Record<string, unknown>): void;
  error(message: string, context: Record<string, unknown>): void;
}
export interface OxyServiceClientOptions {
  /** Existing shared workload client, including a configured local identity. */
  readonly oxy?: OxyServiceHost;
  readonly baseUrl?: string;
  readonly logger?: OxyServiceClientLogger;
  /** Optional originating account proof; never a naked account header. */
  readonly requester?: OxyRequester;
}
let client: CrowdSource | null = null;
let dispose: (() => void) | undefined;
let unavailable = false;

/** Own workloads use the registered service audience, without application scopes. */
export function crowdSourceForOxyService(
  options: OxyServiceClientOptions = {},
): CrowdSource | undefined {
  // Requester-bound clients must never be cached across accounts or requests.
  const sharedDefault = !options.oxy && !options.requester && !options.baseUrl;
  if (sharedDefault && client) return client;
  if (sharedDefault && unavailable) return undefined;
  if (!options.oxy && !hasOxyServiceSdk()) {
    if (sharedDefault) unavailable = true;
    options.logger?.info('[CrowdSource] client not built', {
      reason: 'the optional Oxy workload SDK is unavailable',
      ...(oxySdkResolutionError() ? { oxySdk: oxySdkResolutionError() } : {}),
    });
    return undefined;
  }
  const baseURL = options.baseUrl ?? process.env[BASE_URL_ENV_VAR] ?? DEFAULT_BASE_URL;
  const transport = (options.oxy ?? oxyServiceHost()).createServiceClient({
    baseURL,
    audience: CROWDSOURCE_SERVICE_AUDIENCE,
    ...(options.requester ? { requester: { ...options.requester } } : {}),
  });
  const built = new CrowdSource({ baseUrl: baseURL, oxyTransport: transport });
  if (sharedDefault) {
    client = built;
    dispose = transport.dispose;
  }
  if (options.logger) {
    const logger = options.logger;
    void Promise.resolve(built.applicationId).then(
      (applicationId) => logger.info('[CrowdSource] client ready', { applicationId }),
      () => logger.error('[CrowdSource] tenant unavailable', { reason: 'binding lookup failed' }),
    );
  }
  return built;
}

export function resetCrowdSourceForOxyService(): void {
  dispose?.();
  dispose = undefined;
  client = null;
  unavailable = false;
}

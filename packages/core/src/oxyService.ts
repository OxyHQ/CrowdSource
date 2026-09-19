/**
 * The client a first-party Oxy service gets, with nothing to configure.
 *
 * Three Oxy applications each carried their own copy of this file — Mention at
 * 110 lines, Homiio at 70, Allo at 69, the second being the first with the name
 * swapped. All three answered the same two questions, in the same order, with
 * the same doc comments: build the client once, and hand back `undefined`
 * where it cannot be used. None of that is an application's decision, so none of
 * it belongs in an application.
 *
 * What this deliberately does NOT do is re-answer anything the client already
 * answers. The base URL, the per-attempt deadline, the bounded retries, the
 * idempotency key, the envelope and the error classification are the client's,
 * and a factory that re-exposed them would be a second answer to a question that
 * has one. `baseUrl` is here because a developer pointing at a local backend has
 * nowhere else to say so; everything else is reached by constructing
 * {@link CrowdSource} yourself.
 *
 * A third party does not use this. It holds a CrowdSource service key — it runs
 * where Oxy cannot vouch for it — and `new CrowdSource()` reads that key from
 * the environment.
 */

import { CrowdSource } from './client.js';
import {
  canAttestWorkloadIdentity,
  oxySdkResolutionError,
  oxyServiceCredentials,
  oxyServiceToken,
} from './oxySdk.js';

/**
 * Where this factory reports what it did.
 *
 * Structurally what every Oxy backend's logger already is, so an application
 * passes the one it has. There is no default and no fallback to `console`: a
 * library that writes to stdout on its own is a library that appears in
 * somebody's logs without ever being asked.
 */
export interface OxyServiceClientLogger {
  info(message: string, context: Record<string, unknown>): void;
  error(message: string, context: Record<string, unknown>): void;
}

export interface OxyServiceClientOptions {
  /**
   * A current Oxy service token, asked for once per request attempt.
   *
   * Defaults to `@oxy.so/core`'s `getServiceToken()`, which is what an Oxy
   * service would pass anyway. Set it when the token comes from somewhere else —
   * an SDK instance configured against a non-default Oxy host, say — and it is
   * used in place of the default, never alongside it.
   */
  readonly oxyToken?: () => string | Promise<string>;
  /** Defaults to the client's own. Set it only to point at a local backend. */
  readonly baseUrl?: string;
  /** Defaults to none, which is silence rather than `console`. */
  readonly logger?: OxyServiceClientLogger;
}

let client: CrowdSource | null = null;
let unavailable: string | null = null;

/**
 * Whether this process can act as its Oxy application at all.
 *
 * Two ways, and a deployment has one of them without anybody configuring it: in
 * ECS the task role attests (there is no secret), and elsewhere a service api
 * key pair does. A local checkout has neither, which is the honest answer to "is
 * the integration on here" — and the reason this is not a `CROWDSOURCE_ENABLED`
 * flag. A flag says what somebody typed; this says what the process can do.
 *
 * Asked up front rather than discovered on the first report, and asked even when
 * the caller brought its own `oxyToken`: that provider mints from the same two
 * identities, so a process with neither would hand out a client whose every
 * request fails at the token call.
 */
function canAuthenticateAsOxyService(): boolean {
  return canAttestWorkloadIdentity() || oxyServiceCredentials() !== null;
}

/**
 * The client, or `undefined` where this process cannot authenticate as its Oxy
 * application.
 *
 * `undefined` rather than a throw, and this is the property the three copies
 * were written for: a local checkout has no workload identity and no credential
 * pair, and a report filed there must still be STORED. What to do about a
 * missing client is the caller's decision — the outbox row is durable either
 * way, and the delivery worker is what notices there is nowhere to send it.
 *
 * Built once per process, and every later call returns that same instance
 * whatever options it passes. A second client would ask CrowdSource which tenant
 * this token names all over again and be told the same thing.
 *
 * The reason for `undefined` is logged once, not per call, because the
 * alternative is a line per delivery attempt per report — which buries the cause
 * it is meant to reveal.
 */
export function crowdSourceForOxyService(
  options: OxyServiceClientOptions = {},
): CrowdSource | undefined {
  if (client) return client;
  if (unavailable !== null) return undefined;

  if (!canAuthenticateAsOxyService()) {
    unavailable = 'this process cannot obtain an Oxy service token';
    /**
     * Say WHY when the reason is that Oxy's SDK could not be loaded at all.
     *
     * "Cannot obtain a token" is the right answer for a local checkout and the
     * wrong-looking one for a deployment that has `@oxy.so/core` installed and
     * a task role to attest with: there the cause is a resolution that failed,
     * and without this line an application reads a switched-off integration as
     * intended behaviour.
     */
    const resolution = oxySdkResolutionError();
    options.logger?.info('[CrowdSource] client not built', {
      reason: unavailable,
      ...(resolution === null ? {} : { oxySdk: resolution }),
    });
    return undefined;
  }

  client = new CrowdSource({
    oxyToken: options.oxyToken ?? oxyServiceToken,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
  });

  if (options.logger !== undefined) reportTenant(client, options.logger);

  return client;
}

/**
 * Resolve the tenant once, in the background, so a missing BINDING is visible at
 * boot rather than on the first report.
 *
 * A token this deployment can mint for an Oxy application nobody bound to a
 * CrowdSource tenant authenticates nothing, and that failure is otherwise
 * indistinguishable from "no reports yet". Nothing waits on it: the client is
 * returned already usable, the client resolves the same promise for its own
 * calls, and a rejection here is a log line rather than a broken boot — which is
 * why the rejection handler is attached in the same expression rather than left
 * to an unhandled-rejection handler somebody else owns.
 *
 * Only with a logger. The resolution exists to be REPORTED; with nowhere to
 * report it, it would be a request at boot whose answer nobody reads, and the
 * client asks the same question on first use anyway.
 */
function reportTenant(built: CrowdSource, logger: OxyServiceClientLogger): void {
  void Promise.resolve(built.applicationId).then(
    (applicationId) => {
      logger.info('[CrowdSource] client ready', { applicationId });
    },
    (error: unknown) => {
      logger.error('[CrowdSource] client built but the tenant did not resolve', {
        reason: error instanceof Error ? error.message : String(error),
      });
    },
  );
}

/** Test hook. Production builds the client once and keeps it for the process. */
export function resetCrowdSourceForOxyService(): void {
  client = null;
  unavailable = null;
}

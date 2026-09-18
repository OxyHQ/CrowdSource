/**
 * The client.
 *
 * The whole design target is the length of the smallest integration:
 *
 *     const crowdsource = new CrowdSource();
 *     await crowdsource.reports.create({ ... });
 *
 * Everything else has a default that is correct for the overwhelming majority of
 * integrators and a way to override it for the rest. The service key comes from
 * the environment, the base URL is the one deployment CrowdSource has, and the
 * envelope, the policy version, the digests, the principal refs and the
 * idempotency key are all composed rather than configured.
 *
 * This client is SERVER-SIDE ONLY. A service credential is the tenant's identity
 * for its whole moderation stream; shipping one to a browser or a mobile bundle
 * hands every user of the application the ability to file reports as the
 * application, read its cases and exhaust its quota. The package depends on
 * `node:crypto` and does not build for a browser, which is the intended
 * outcome rather than a limitation to work around.
 */

import { Cases, Decisions } from './cases.js';
import { CommunityNotes } from './communityNotes.js';
import { parseServiceKey, type ServiceCredential } from './credential.js';
import { DEFAULT_BASE_URL } from './defaults.js';
import { CrowdSourceConfigurationError } from './errors.js';
import { Reports } from './reports.js';
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
  Transport,
  type FetchLike,
} from './transport.js';
import { WebhookEndpoints } from './webhookEndpoints.js';

/** The environment variable a zero-configuration integration reads. */
export const SERVICE_KEY_ENV_VAR = 'CROWDSOURCE_SERVICE_KEY';

/** Overrides the service host. Set only when pointing at a local backend. */
export const BASE_URL_ENV_VAR = 'CROWDSOURCE_BASE_URL';

export interface CrowdSourceOptions {
  /**
   * The service key CrowdSource issued, as one opaque string. Defaults to
   * `process.env.CROWDSOURCE_SERVICE_KEY`.
   *
   * There is no `applicationId` option here or anywhere else. The application a
   * report belongs to is read off this credential — see `credential.ts`.
   */
  readonly serviceKey?: string;
  /**
   * A first-party Oxy service authenticating with NO CrowdSource credential.
   *
   * Return a current Oxy service token; it is asked for once per request
   * attempt, so returning a cached token and refreshing it when it expires is
   * the expected shape (`oxyServices.getServiceToken()` does exactly that).
   *
   * With this set, `serviceKey` is neither needed nor read. CrowdSource resolves
   * the tenant from the Oxy application the token names, so nothing here has to
   * be issued, stored or rotated by a person. Third parties keep the service
   * key: they run where Oxy cannot vouch for them.
   */
  readonly oxyToken?: () => string | Promise<string>;
  readonly baseUrl?: string;
  /** Per-attempt deadline. Default 10s. */
  readonly timeoutMs?: number;
  /** Attempts per call including the first, for retryable failures. Default 3. */
  readonly maxAttempts?: number;
  /**
   * Marks reports as coming from the application's own pre-production (§5.1
   * `source.environment`). CrowdSource has one deployment; this is a property of
   * the report, not a different host to talk to.
   *
   * Every report from a sandbox client must carry `submittedAt`, because the
   * environment travels inside `source` and `source` cannot be composed without
   * one — see `ReportInput.submittedAt` for why inventing that timestamp would
   * turn every retry into a 409.
   */
  readonly sandbox?: boolean;
  /** Injected for tests and for the in-process sandbox. Defaults to global `fetch`. */
  readonly fetch?: FetchLike;
}

export class CrowdSource {
  /**
   * The application this client acts as.
   *
   * Read off the credential when there is one. With an Oxy token there is
   * nothing to read it off — the mapping lives in CrowdSource — so it resolves
   * on first use from `GET /v1/applications/me` and is remembered.
   */
  readonly applicationId: string | Promise<string>;

  readonly reports: Reports;
  readonly cases: Cases;
  readonly decisions: Decisions;
  /** Where decisions get delivered, and the secret that signs them (§10.2). */
  readonly webhookEndpoints: WebhookEndpoints;
  /** Community notes: write, withdraw, draw to rate, rate, and the reads. */
  readonly communityNotes: CommunityNotes;

  constructor(options: CrowdSourceOptions = {}) {
    /**
     * Two ways to be an application, and exactly one of them is configured.
     *
     * The Oxy path is checked first so that a deployment which has BOTH — during
     * the migration off shared secrets — uses the identity it can prove rather
     * than the secret it still happens to hold. Removing the key is then the
     * cleanup, not the cutover.
     */
    const credential: ServiceCredential | null = options.oxyToken
      ? null
      : parseServiceKey(options.serviceKey ?? process.env[SERVICE_KEY_ENV_VAR] ?? '');

    const baseUrl = normalisedBaseUrl(
      options.baseUrl ?? process.env[BASE_URL_ENV_VAR] ?? DEFAULT_BASE_URL,
    );
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new CrowdSourceConfigurationError(
        'This runtime has no global fetch. Pass one as the `fetch` option.',
      );
    }

    const oxyToken = options.oxyToken;
    const transport = new Transport({
      baseUrl,
      bearerToken: credential ? () => credential.bearerToken : () => oxyToken!(),
      timeoutMs,
      maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      fetch: fetchImpl,
    });

    this.applicationId = credential ? credential.applicationId : lazyApplicationId(transport);
    this.reports = new Reports({
      transport,
      applicationId: this.applicationId,
      environment: options.sandbox === true ? 'sandbox' : 'production',
    });
    this.cases = new Cases(transport);
    this.decisions = new Decisions(transport);
    this.webhookEndpoints = new WebhookEndpoints(transport);
    this.communityNotes = new CommunityNotes(transport);
  }
}


/**
 * Asks CrowdSource which application this client is, once.
 *
 * Only the Oxy-token path needs this: a service key carries the id inside it.
 * The promise is created at construction and awaited wherever the id is used,
 * so the lookup happens at most once per client and never blocks a caller that
 * does not need it (community notes never do; a report does, because its
 * envelope names the application and the server refuses one that disagrees).
 *
 * A failure is not swallowed into a placeholder id. An envelope carrying the
 * wrong application is refused by the server anyway, and a client that invented
 * one would turn a clear "we could not identify you" into a confusing 403 on
 * every report.
 */
function lazyApplicationId(transport: Transport): Promise<string> {
  let pending: Promise<string> | null = null;
  const resolve = () => (pending ??= askApplicationId(transport));
  // A thenable rather than a promise: nothing is requested until somebody
  // awaits it, so a client that only reads community notes — which never name
  // an application — makes no identity call at all. Awaiting it twice still
  // makes one.
  return { then: (onFulfilled, onRejected) => resolve().then(onFulfilled, onRejected) } as Promise<string>;
}

function askApplicationId(transport: Transport): Promise<string> {
  return transport
    .request<{ applicationId?: unknown }>({ method: 'GET', path: '/v1/applications/me' })
    .then((body) => {
      const applicationId = body?.applicationId;
      if (typeof applicationId !== 'string' || applicationId.length === 0) {
        throw new CrowdSourceConfigurationError(
          'CrowdSource did not name the application this token belongs to.',
        );
      }
      return applicationId;
    });
}

function normalisedBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CrowdSourceConfigurationError(`'${value}' is not a usable CrowdSource base URL.`);
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
    throw new CrowdSourceConfigurationError(
      'A CrowdSource base URL must be https. A service credential sent in clear is a credential you have to rotate.',
    );
  }
  // Trailing slashes are stripped so `${baseUrl}/v1/reports` never doubles up.
  return parsed.origin + parsed.pathname.replace(/\/+$/, '');
}

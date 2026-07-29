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

import { Cases, Decisions } from './cases';
import { parseServiceKey, type ServiceCredential } from './credential';
import { DEFAULT_BASE_URL } from './defaults';
import { CrowdSourceConfigurationError } from './errors';
import { Reports } from './reports';
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
  Transport,
  type FetchLike,
} from './transport';
import { Uploads } from './uploads';

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
  /** The application this client acts as, read off the credential. */
  readonly applicationId: string;

  readonly reports: Reports;
  readonly uploads: Uploads;
  readonly cases: Cases;
  readonly decisions: Decisions;

  constructor(options: CrowdSourceOptions = {}) {
    const credential: ServiceCredential = parseServiceKey(
      options.serviceKey ?? process.env[SERVICE_KEY_ENV_VAR] ?? '',
    );

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

    const transport = new Transport({
      baseUrl,
      bearerToken: credential.bearerToken,
      timeoutMs,
      maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      fetch: fetchImpl,
    });

    this.applicationId = credential.applicationId;
    this.reports = new Reports({
      transport,
      applicationId: credential.applicationId,
      environment: options.sandbox === true ? 'sandbox' : 'production',
    });
    this.uploads = new Uploads({ transport, fetch: fetchImpl, timeoutMs });
    this.cases = new Cases(transport);
    this.decisions = new Decisions(transport);
  }
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

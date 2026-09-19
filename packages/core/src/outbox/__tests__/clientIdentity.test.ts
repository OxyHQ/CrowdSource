/**
 * Which credential an outbox deployment presents, and what happens when it has
 * none.
 *
 * The gap this covers was found in the field: `createModerationIntegration()`
 * builds the client itself, so an adopter that uses the outbox half never had a
 * place to hand one in — and the only identity the provider could construct was
 * a CrowdSource service key. Syra migrated onto `@crowdsource.you/core@1.3.0`
 * and had to KEEP its key for exactly that reason, because removing it would
 * have switched delivery off in the one direction nothing fails on.
 *
 * Nothing here reaches the network. `globalThis.fetch` is replaced per test and
 * the two functions that would reach `@oxy.so/core` are stubbed by name, so an
 * assertion about the `Authorization` header is an assertion about which
 * provider was asked — not about Oxy being reachable from a test runner. The
 * credential read is NOT stubbed, so the environment-pair path runs for real.
 *
 * These guards need no mutation entry in `scripts/test-invariants.mjs`: each one
 * asserts the outcome of the branch it names, so deleting that branch fails the
 * test that names it rather than passing on a happy path.
 */

import { DATABASE_CASING } from '@oxy.so/db';
import { drizzle } from 'drizzle-orm/postgres-js';
import { pgTable } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const oxySdk = vi.hoisted(() => ({
  canAttestWorkloadIdentity: vi.fn((): boolean => false),
  oxyServiceToken: vi.fn((): Promise<string> => Promise.resolve('token-from-the-default-provider')),
}));

vi.mock('../../oxySdk.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../oxySdk.js')>()),
  ...oxySdk,
}));

import { formatServiceKey } from '../../credential.js';
import { resetCrowdSourceForOxyService } from '../../index.js';
import { createClientProvider } from '../client.js';
import { createModerationIntegration } from '../integration.js';
import {
  moderationReportColumns,
  moderationReportTableExtras,
} from '../postgres/reportColumns.js';
import { postgresModerationStore } from '../postgres/store/index.js';
import { moderationTables } from '../postgres/tables.js';
import type { CrowdSourceConnectionConfig, ModerationLogger } from '../types.js';

const BASE_URL = 'https://api.crowdsource.test';

/** The application the KEY names, read off the key with nothing asked. */
const KEYED_APPLICATION = 'app_0123456789abcdef0123456789abcdef';

/**
 * The application CrowdSource resolves from an Oxy token — deliberately a
 * different value, so "which of the two did this client use" is answerable by
 * looking at the id rather than by trusting the wiring.
 */
const BOUND_APPLICATION = 'app_fedcba9876543210fedcba9876543210';

const SERVICE_KEY = formatServiceKey({
  applicationId: KEYED_APPLICATION,
  credentialId: 'csk_fedcba9876543210fedcba9876543210',
  secret: 'secret-value',
});

type LogLine = (message: string, context?: Record<string, unknown>) => void;

interface RecordingLogger extends ModerationLogger {
  info: Mock<LogLine>;
  warn: Mock<LogLine>;
  error: Mock<LogLine>;
}

function recordingLogger(): RecordingLogger {
  return { info: vi.fn<LogLine>(), warn: vi.fn<LogLine>(), error: vi.fn<LogLine>() };
}

interface Call {
  readonly url: string;
  readonly authorization: string | null;
}

function stubFetch(responses: readonly Response[]): Call[] {
  const calls: Call[] = [];
  const queue = [...responses];

  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
    });
    const next = queue.shift();
    if (next === undefined) throw new Error('The stub was called more times than it has answers.');
    return next;
  });

  return calls;
}

/**
 * Built per call rather than shared. A `Response` body can be read once, so a
 * module-level constant passes the first test that uses it and then fails every
 * later one with a transport error that names nothing.
 */
const namesTheTenant = (): Response =>
  new Response(JSON.stringify({ applicationId: BOUND_APPLICATION }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function connection(
  overrides: Partial<CrowdSourceConnectionConfig>,
): CrowdSourceConnectionConfig {
  return { enabled: true, enforcementMode: 'observe', baseUrl: BASE_URL, ...overrides };
}

beforeEach(() => {
  resetCrowdSourceForOxyService();
  // `reset`, not `clear`: `clearAllMocks` leaves an implementation a previous
  // test installed in place, so a `mockReturnValue(true)` for the attestation
  // would silently give every later test an identity it never asked for.
  vi.resetAllMocks();
  // Stated rather than assumed. A developer's shell that happens to export
  // either credential would otherwise make the "configured nothing" tests pass
  // by building a client out of the environment.
  vi.stubEnv('OXY_SERVICE_API_KEY', undefined);
  vi.stubEnv('OXY_SERVICE_API_SECRET', undefined);
  vi.stubEnv('CROWDSOURCE_SERVICE_KEY', undefined);
});

afterEach(() => {
  resetCrowdSourceForOxyService();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('the service key, which is what every deployment did before auth existed', () => {
  it('is the default, and the client reads its application off it', () => {
    const logger = recordingLogger();

    const client = createClientProvider({
      config: connection({ serviceKey: SERVICE_KEY }),
      logger,
    }).get();

    expect(client?.applicationId).toBe(KEYED_APPLICATION);
    expect(logger.info).toHaveBeenCalledWith('[CrowdSource] client ready', {
      auth: 'service-key',
      applicationId: KEYED_APPLICATION,
    });
    // Not merely "the key won": the first-party path was never consulted, so a
    // third party's tree is never asked a question about Oxy at all.
    expect(oxySdk.canAttestWorkloadIdentity).not.toHaveBeenCalled();
  });

  it('behaves identically when the default is written out', () => {
    const logger = recordingLogger();

    const client = createClientProvider({
      config: connection({ auth: 'service-key', serviceKey: SERVICE_KEY }),
      logger,
    }).get();

    expect(client?.applicationId).toBe(KEYED_APPLICATION);
    expect(oxySdk.canAttestWorkloadIdentity).not.toHaveBeenCalled();
  });

  it('is built once, not once per delivery', () => {
    const logger = recordingLogger();
    const provider = createClientProvider({
      config: connection({ serviceKey: SERVICE_KEY }),
      logger,
    });

    const first = provider.get();

    expect(provider.get()).toBe(first);
    expect(provider.get()).toBe(first);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('is refused once at error level when it is malformed, and the secret is not echoed', () => {
    const logger = recordingLogger();
    const provider = createClientProvider({
      config: connection({ serviceKey: 'app_1:cred_1:secret:and-a-fourth-part' }),
      logger,
    });

    expect(provider.get()).toBeUndefined();
    expect(provider.get()).toBeUndefined();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toBe('[CrowdSource] service key rejected');
    expect(logger.error.mock.calls[0][1]).toMatchObject({ auth: 'service-key' });
    expect(String(logger.error.mock.calls[0][1]?.reason)).toContain('three colon-separated parts');
    expect(String(logger.error.mock.calls[0][1]?.reason)).not.toContain('and-a-fourth-part');
  });
});

describe('an Oxy service, which configures no key at all', () => {
  beforeEach(() => {
    oxySdk.canAttestWorkloadIdentity.mockReturnValue(true);
  });

  it('builds a client that presents the Oxy service token', async () => {
    const logger = recordingLogger();
    const calls = stubFetch([namesTheTenant()]);

    const client = createClientProvider({
      config: connection({ auth: 'oxy-service' }),
      logger,
    }).get();

    expect(client).toBeDefined();

    // The tenant is resolved in the background by the shared factory, so the
    // assertion waits for the line rather than for the client.
    await vi.waitFor(() =>
      expect(logger.info).toHaveBeenCalledWith('[CrowdSource] client ready', {
        auth: 'oxy-service',
        applicationId: BOUND_APPLICATION,
      }),
    );

    expect(calls[0].url).toBe(`${BASE_URL}/v1/applications/me`);
    expect(calls[0].authorization).toBe('Bearer token-from-the-default-provider');
  });

  /**
   * The property Syra could not have: the key is gone and delivery still works.
   *
   * Asserted by the ID rather than by the absence of a field. A key IS present
   * here — in the config and in the environment, the exact state a half-finished
   * migration leaves behind — and the application the client acts as is still
   * the one CrowdSource resolved from the token.
   */
  it('reads no service key, configured or in the environment', async () => {
    const logger = recordingLogger();
    vi.stubEnv('CROWDSOURCE_SERVICE_KEY', SERVICE_KEY);
    stubFetch([namesTheTenant()]);

    const client = createClientProvider({
      config: connection({ auth: 'oxy-service', serviceKey: SERVICE_KEY }),
      logger,
    }).get();

    expect(client).toBeDefined();
    await expect(Promise.resolve(client?.applicationId)).resolves.toBe(BOUND_APPLICATION);
    expect(client?.applicationId).not.toBe(KEYED_APPLICATION);
  });

  it('says once that a key left behind by a migration is not used', async () => {
    const logger = recordingLogger();
    stubFetch([namesTheTenant()]);

    const provider = createClientProvider({
      config: connection({ auth: 'oxy-service', serviceKey: SERVICE_KEY }),
      logger,
    });

    provider.get();
    provider.get();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('[CrowdSource] the configured service key is not used', {
      auth: 'oxy-service',
    });
  });

  it('is built once, not once per delivery', () => {
    const logger = recordingLogger();
    stubFetch([namesTheTenant()]);
    const provider = createClientProvider({
      config: connection({ auth: 'oxy-service' }),
      logger,
    });

    const first = provider.get();

    expect(first).toBeDefined();
    expect(provider.get()).toBe(first);
  });

  it('reaches the seam through createModerationIntegration, not only through the provider', async () => {
    const logger = recordingLogger();
    const calls = stubFetch([namesTheTenant()]);

    /**
     * The adopter's wiring, lazily connected and never used. postgres.js
     * connects on first query, `pgTable` and the store factories do no I/O, and
     * nothing below runs one — this test is about which client the factory
     * builds, not about what it stores.
     */
    const reports = pgTable(
      'clientidentity_reports',
      moderationReportColumns({ reportedTypes: ['widget'], categories: ['spam'] }),
      moderationReportTableExtras({ reportedTypes: ['widget'], categories: ['spam'] }),
    );
    const tables = moderationTables({ enforcementActions: ['review', 'none'] });
    const sql = postgres('postgres://unused:unused@127.0.0.1:1/unused', { max: 1 });

    try {
      const store = postgresModerationStore({
        db: drizzle(sql, { casing: DATABASE_CASING, schema: { reports, ...tables } }),
        reportTable: reports,
        tables,
      });

      const integration = createModerationIntegration({
        store,
        crowdSource: connection({ auth: 'oxy-service' }),
        subjects: [],
        taxonomy: { version: '2026.07', allegationsFor: () => ['other.unclassifiable'] },
        enforcement: {
          actions: ['review', 'none'],
          noneAction: 'none',
          reviewAction: 'review',
          restoreAction: null,
        },
        logger,
      });

      expect(integration.client.get()).toBeDefined();
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0].authorization).toBe('Bearer token-from-the-default-provider');
    } finally {
      await sql.end();
    }
  });
});

describe('a deployment that configured neither', () => {
  it('is a configuration error, said once at error level, naming both doors', () => {
    const logger = recordingLogger();
    const provider = createClientProvider({ config: connection({}), logger });

    expect(provider.get()).toBeUndefined();
    expect(provider.get()).toBeUndefined();
    expect(provider.get()).toBeUndefined();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('[CrowdSource] enabled but not configured', {
      auth: 'service-key',
      reason:
        "no CrowdSource service key is configured, and crowdSource.auth is not 'oxy-service'",
    });
  });

  /**
   * The same `undefined` the shared factory hands a laptop, and NOT the same
   * thing. A local checkout that cannot mint a token is unremarkable; a
   * deployment that named this identity and switched delivery on meant it, and
   * an info line is not what an operator finds three days later with a full
   * outbox.
   */
  it("is an error under 'oxy-service' too, not the factory's quiet answer", () => {
    const logger = recordingLogger();
    const provider = createClientProvider({
      config: connection({ auth: 'oxy-service' }),
      logger,
    });

    expect(provider.get()).toBeUndefined();
    expect(provider.get()).toBeUndefined();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('[CrowdSource] enabled but not configured', {
      auth: 'oxy-service',
      reason:
        "crowdSource.auth is 'oxy-service' but this process cannot obtain an Oxy service token",
    });
    // The factory's own account of what it found, carrying the mode it was
    // never told about.
    expect(logger.info).toHaveBeenCalledWith(
      '[CrowdSource] client not built',
      expect.objectContaining({
        auth: 'oxy-service',
        reason: 'this process cannot obtain an Oxy service token',
      }),
    );
  });
});

describe('a disabled integration', () => {
  it('builds nothing, logs nothing and asks no identity, whichever mode it names', () => {
    const logger = recordingLogger();

    expect(
      createClientProvider({
        config: connection({ enabled: false, auth: 'oxy-service', serviceKey: SERVICE_KEY }),
        logger,
      }).get(),
    ).toBeUndefined();

    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(oxySdk.canAttestWorkloadIdentity).not.toHaveBeenCalled();
  });
});

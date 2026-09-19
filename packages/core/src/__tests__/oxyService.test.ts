/**
 * The first-party factory: what it builds, what it refuses to build, and what it
 * says about the tenant.
 *
 * Nothing here reaches the network. `globalThis.fetch` is replaced per test and
 * the token provider is stubbed, so an assertion about the `Authorization`
 * header is an assertion about which provider was asked — not about Oxy being
 * reachable from a test runner.
 *
 * `@oxy.so/core` is an optional peer this workspace does not install, which is
 * the same tree a third party has. The two functions that would reach it are
 * stubbed by name; the credential read is NOT, so the environment-pair path runs
 * for real.
 *
 * These guards need no mutation entry in `scripts/test-invariants.mjs`. That
 * script exists for guards whose happy path passes whether or not the guard is
 * there; each test below asserts the guard's own outcome, so deleting the guard
 * fails the test that names it.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { OxyServiceClientLogger } from '../oxyService.js';

const oxySdk = vi.hoisted(() => ({
  canAttestWorkloadIdentity: vi.fn((): boolean => false),
  oxyServiceToken: vi.fn((): Promise<string> => Promise.resolve('token-from-the-default-provider')),
}));

vi.mock('../oxySdk.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../oxySdk.js')>()),
  ...oxySdk,
}));

import { crowdSourceForOxyService, resetCrowdSourceForOxyService } from '../oxyService.js';

const BASE_URL = 'https://api.crowdsource.test';

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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Built per call rather than shared. A `Response` body can be read once, so a
 * module-level constant passes the first test that uses it and then fails every
 * later one with a transport error that names nothing.
 */
const namesTheTenant = (): Response =>
  json(200, { applicationId: 'app_0123456789abcdef0123456789abcdef' });

const refusesTheToken = (): Response =>
  json(403, {
    error: {
      code: 'forbidden',
      message: 'This Oxy application is bound to no CrowdSource tenant.',
    },
  });

type LogLine = (message: string, context: Record<string, unknown>) => void;

function recordingLogger(): OxyServiceClientLogger & { info: Mock<LogLine>; error: Mock<LogLine> } {
  return { info: vi.fn<LogLine>(), error: vi.fn<LogLine>() };
}

beforeEach(() => {
  resetCrowdSourceForOxyService();
  // `reset`, not `clear`: `clearAllMocks` leaves an implementation a previous
  // test installed in place, so a `mockReturnValue(true)` for the attestation
  // would silently give every later test an identity it never asked for.
  vi.resetAllMocks();
  // Stated rather than assumed: a developer's shell that happens to export a
  // service credential would otherwise make the "no identity" tests pass by
  // building a client.
  vi.stubEnv('OXY_SERVICE_API_KEY', undefined);
  vi.stubEnv('OXY_SERVICE_API_SECRET', undefined);
});

afterEach(() => {
  resetCrowdSourceForOxyService();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('the identity the process can prove', () => {
  it('builds nothing where there is neither an attestation nor a credential pair', () => {
    const logger = recordingLogger();

    expect(crowdSourceForOxyService({ logger })).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith('[CrowdSource] client not built', {
      reason: 'this process cannot obtain an Oxy service token',
    });
  });

  it('says so once, not once per call', () => {
    const logger = recordingLogger();

    expect(crowdSourceForOxyService({ logger })).toBeUndefined();
    expect(crowdSourceForOxyService({ logger })).toBeUndefined();
    expect(crowdSourceForOxyService({ logger })).toBeUndefined();

    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('builds on an attestation alone, with no credential pair anywhere', () => {
    oxySdk.canAttestWorkloadIdentity.mockReturnValue(true);

    expect(crowdSourceForOxyService({ baseUrl: BASE_URL })).toBeDefined();
  });

  it('builds on a credential pair alone, with nothing to attest', () => {
    vi.stubEnv('OXY_SERVICE_API_KEY', 'oxy_dk_test');
    vi.stubEnv('OXY_SERVICE_API_SECRET', 'test-secret');

    expect(oxySdk.canAttestWorkloadIdentity()).toBe(false);
    expect(crowdSourceForOxyService({ baseUrl: BASE_URL })).toBeDefined();
  });

  it('reads a blank credential as no credential', () => {
    vi.stubEnv('OXY_SERVICE_API_KEY', '   ');
    vi.stubEnv('OXY_SERVICE_API_SECRET', '');

    expect(crowdSourceForOxyService({ baseUrl: BASE_URL })).toBeUndefined();
  });
});

describe('one client per process', () => {
  it('returns the instance it already built, whatever the later call asks for', () => {
    oxySdk.canAttestWorkloadIdentity.mockReturnValue(true);

    const first = crowdSourceForOxyService({ baseUrl: BASE_URL });
    const second = crowdSourceForOxyService({ baseUrl: 'https://somewhere.else.test' });

    expect(first).toBeDefined();
    expect(second).toBe(first);
  });
});

describe('the token provider', () => {
  beforeEach(() => {
    oxySdk.canAttestWorkloadIdentity.mockReturnValue(true);
  });

  it('defaults to the Oxy SDK, asked per attempt rather than captured once', async () => {
    const logger = recordingLogger();
    const calls = stubFetch([namesTheTenant()]);

    crowdSourceForOxyService({ baseUrl: BASE_URL, logger });

    await vi.waitFor(() => expect(logger.info).toHaveBeenCalled());
    expect(oxySdk.oxyServiceToken).toHaveBeenCalled();
    expect(calls[0].authorization).toBe('Bearer token-from-the-default-provider');
    expect(calls[0].url).toBe(`${BASE_URL}/v1/applications/me`);
  });

  it('uses an explicit provider in place of the default, never alongside it', async () => {
    const logger = recordingLogger();
    const calls = stubFetch([namesTheTenant()]);

    crowdSourceForOxyService({
      baseUrl: BASE_URL,
      logger,
      oxyToken: () => 'token-the-caller-brought',
    });

    await vi.waitFor(() => expect(logger.info).toHaveBeenCalled());
    expect(calls[0].authorization).toBe('Bearer token-the-caller-brought');
    expect(oxySdk.oxyServiceToken).not.toHaveBeenCalled();
  });
});

describe('the tenant', () => {
  beforeEach(() => {
    oxySdk.canAttestWorkloadIdentity.mockReturnValue(true);
  });

  it('is resolved in the background and reported, with nothing waiting on it', async () => {
    const logger = recordingLogger();
    stubFetch([namesTheTenant()]);

    const client = crowdSourceForOxyService({ baseUrl: BASE_URL, logger });

    // The client is usable before the answer arrives: that is the whole point of
    // resolving in the background.
    expect(client).toBeDefined();
    expect(logger.info).not.toHaveBeenCalled();

    await vi.waitFor(() =>
      expect(logger.info).toHaveBeenCalledWith('[CrowdSource] client ready', {
        applicationId: 'app_0123456789abcdef0123456789abcdef',
      }),
    );
  });

  /**
   * The failure this reporting exists for. A token this deployment can mint for
   * an Oxy application nobody bound to a CrowdSource tenant authenticates
   * nothing, and without this line that is indistinguishable from "no reports
   * yet" — for as long as nobody files one.
   */
  it('is reported when it does NOT resolve, and the failure stays inside the client', async () => {
    const logger = recordingLogger();
    stubFetch([refusesTheToken()]);

    expect(() => crowdSourceForOxyService({ baseUrl: BASE_URL, logger })).not.toThrow();

    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());
    expect(logger.error.mock.calls[0][0]).toBe(
      '[CrowdSource] client built but the tenant did not resolve',
    );
    expect(String(logger.error.mock.calls[0][1].reason)).toContain('bound to no CrowdSource tenant');
    expect(logger.info).not.toHaveBeenCalled();
  });

  /**
   * With no logger the resolution would be a request at boot whose answer
   * nobody reads. The client asks the same question on first use, so this is a
   * request not made rather than an answer not had.
   */
  it('is not asked for at all when there is nowhere to report it', () => {
    const calls = stubFetch([]);

    expect(crowdSourceForOxyService({ baseUrl: BASE_URL })).toBeDefined();

    expect(calls).toHaveLength(0);
  });
});

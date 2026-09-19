import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const publisher = vi.hoisted(() => ({
  observeHttp: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  installFetch: vi.fn(), observeSocket: vi.fn(), stop: vi.fn(async () => {}),
}));
const create = vi.hoisted(() => vi.fn((_options: unknown) => publisher));
// Mirrors the real implementation, which reads the ECS container credentials
// endpoint out of the environment — so a test says "this is a task" the same way
// a task does, and nothing here asserts against a hand-written boolean.
const canAttest = vi.hoisted(() => vi.fn(() => Boolean(process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI)));
vi.mock('@oxy.so/core/server', () => ({ createEcosystemTraffic: create, canAttestWorkloadIdentity: canAttest }));
import { ecosystemActivityMiddleware, observeEcosystemSocket, startEcosystemActivity, stopEcosystemActivity } from '../ecosystemActivity';

describe('ecosystem activity lifecycle', () => {
  beforeEach(() => {
    vi.stubEnv('OXY_SERVICE_API_KEY', 'test-key');
    vi.stubEnv('OXY_SERVICE_API_SECRET', 'test-secret');
    vi.stubEnv('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.clearAllMocks();
  });
  afterEach(async () => { await stopEcosystemActivity(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('does not start or publish when the API key is missing and nothing can be attested', () => {
    vi.stubEnv('OXY_SERVICE_API_KEY', undefined);
    startEcosystemActivity(() => true);
    expect(create).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
    const next = vi.fn();
    ecosystemActivityMiddleware({} as never, {} as never, next);
    observeEcosystemSocket({} as never);
    expect(next).toHaveBeenCalledTimes(1);
    expect(publisher.observeSocket).not.toHaveBeenCalled();
  });

  it('does not start or publish when the API secret is missing and nothing can be attested', () => {
    vi.stubEnv('OXY_SERVICE_API_SECRET', undefined);
    startEcosystemActivity(() => true);
    expect(create).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('treats a blank credential the same as an absent one', () => {
    vi.stubEnv('OXY_SERVICE_API_KEY', '   ');
    startEcosystemActivity(() => true);
    expect(create).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  /**
   * The point of the whole ADR 0026 migration, pinned.
   *
   * On a Fargate task the credential pair is deletable because the task can
   * prove what it IS instead. A guard that reads only the pair would return
   * here — leaving a healthy service that has quietly stopped being an
   * ecosystem-activity producer, which is the failure mode nobody notices.
   */
  it('starts on a workload identity when the credential pair is gone', () => {
    vi.stubEnv('OXY_SERVICE_API_KEY', undefined);
    vi.stubEnv('OXY_SERVICE_API_SECRET', undefined);
    vi.stubEnv('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', '/v2/credentials/abc');
    startEcosystemActivity(() => true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(publisher.installFetch).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  /**
   * No credential is handed to the collector when the pair is gone: the SDK
   * resolves the token itself and attests when there is nothing else. Passing a
   * half-credential here is what used to make this throw at boot.
   */
  it('lets the SDK resolve the credential rather than passing one', () => {
    vi.stubEnv('OXY_SERVICE_API_KEY', undefined);
    vi.stubEnv('OXY_SERVICE_API_SECRET', undefined);
    vi.stubEnv('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', '/v2/credentials/abc');
    startEcosystemActivity(() => true);
    const options = create.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(options).not.toHaveProperty('credential');
    expect(options.service).toBe('crowdsource');
  });

  it('fails boot when the shared collector rejects its configuration', () => {
    create.mockImplementationOnce(() => { throw new Error('Invalid infrastructure region'); });
    expect(() => startEcosystemActivity(() => true)).toThrow('Invalid infrastructure region');
    expect(publisher.installFetch).not.toHaveBeenCalled();
  });

  it('installs once and supplies live readiness without retaining request bodies', async () => {
    let ready = false;
    startEcosystemActivity(() => ready);
    startEcosystemActivity(() => ready);
    expect(create).toHaveBeenCalledTimes(1);
    expect(publisher.installFetch).toHaveBeenCalledTimes(1);
    const socket = {} as never;
    observeEcosystemSocket(socket);
    expect(publisher.observeSocket).toHaveBeenCalledWith(socket);
    const options = create.mock.calls[0]?.[0] as unknown as { service: string; ready(): boolean };
    expect(options.service).toBe('crowdsource');
    expect(options.ready()).toBe(false);
    ready = true;
    expect(options.ready()).toBe(true);
    const next = vi.fn();
    ecosystemActivityMiddleware({} as never, {} as never, next);
    expect(publisher.observeHttp).toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    await stopEcosystemActivity();
    await stopEcosystemActivity();
    expect(publisher.stop).toHaveBeenCalledTimes(1);
  });
});

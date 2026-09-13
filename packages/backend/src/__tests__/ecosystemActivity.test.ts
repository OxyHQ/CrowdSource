import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const publisher = vi.hoisted(() => ({
  observeHttp: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  installFetch: vi.fn(), observeSocket: vi.fn(), stop: vi.fn(async () => {}),
}));
const create = vi.hoisted(() => vi.fn((_options: unknown) => publisher));
vi.mock('@oxy.so/core/server', () => ({ createEcosystemTraffic: create }));
import { ecosystemActivityMiddleware, observeEcosystemSocket, startEcosystemActivity, stopEcosystemActivity } from '../ecosystemActivity';

describe('ecosystem activity lifecycle', () => {
  beforeEach(() => {
    vi.stubEnv('OXY_ECOSYSTEM_ACTIVITY_ENABLED', 'true');
    vi.stubEnv('OXY_SERVICE_API_KEY', 'test-key');
    vi.stubEnv('OXY_SERVICE_API_SECRET', 'test-secret');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.clearAllMocks();
  });
  afterEach(async () => { await stopEcosystemActivity(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('does not start or publish when explicitly disabled', () => {
    vi.stubEnv('OXY_ECOSYSTEM_ACTIVITY_ENABLED', 'false');
    startEcosystemActivity(() => true);
    expect(create).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
    const next = vi.fn();
    ecosystemActivityMiddleware({} as never, {} as never, next);
    observeEcosystemSocket({} as never);
    expect(next).toHaveBeenCalledTimes(1);
    expect(publisher.observeSocket).not.toHaveBeenCalled();
  });

  it('makes missing activation visible without starting a publisher', () => {
    vi.stubEnv('OXY_ECOSYSTEM_ACTIVITY_ENABLED', undefined);
    startEcosystemActivity(() => true);
    expect(create).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('rejects a misspelled activation instead of silently losing coverage', () => {
    vi.stubEnv('OXY_ECOSYSTEM_ACTIVITY_ENABLED', 'tru');
    expect(() => startEcosystemActivity(() => true)).toThrow('must be true or false');
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

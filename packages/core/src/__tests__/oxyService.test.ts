import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const sdk = vi.hoisted(() => ({
  canAttestWorkloadIdentity: vi.fn(() => false),
  oxyServiceHost: vi.fn(),
}));
vi.mock('../oxySdk.js', async (original) => ({
  ...(await original<typeof import('../oxySdk.js')>()),
  ...sdk,
}));
import { crowdSourceForOxyService, resetCrowdSourceForOxyService } from '../oxyService.js';
import { CROWDSOURCE_SERVICE_AUDIENCE } from '../defaults.js';
import type { OxyServiceHost } from '../oxySdk.js';
beforeEach(() => {
  resetCrowdSourceForOxyService();
  vi.clearAllMocks();
  sdk.canAttestWorkloadIdentity.mockReturnValue(false);
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetCrowdSourceForOxyService();
});
function host() {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ applicationId: 'bound-tenant' }),
  );
  const dispose = vi.fn();
  const createServiceClient = vi.fn<OxyServiceHost['createServiceClient']>(() => ({
    fetch,
    dispose,
  }));
  return { createServiceClient, fetch, dispose };
}
it('does not reinterpret configured API keys as own workload identity', () => {
  vi.stubEnv('OXY_SERVICE_API_KEY', 'external-key');
  vi.stubEnv('OXY_SERVICE_API_SECRET', 'external-secret');
  expect(crowdSourceForOxyService()).toBeUndefined();
  expect(sdk.oxyServiceHost).not.toHaveBeenCalled();
});
it('uses shared canonical transport with no manual bearer or scope map', async () => {
  const oxy = host();
  const client = crowdSourceForOxyService({ oxy, baseUrl: 'https://crowdsource.test' });
  expect(oxy.createServiceClient).toHaveBeenCalledWith({
    baseURL: 'https://crowdsource.test',
    audience: CROWDSOURCE_SERVICE_AUDIENCE,
  });
  expect(await client?.applicationId).toBe('bound-tenant');
  expect(new Headers(oxy.fetch.mock.calls[0]?.[1]?.headers).has('authorization')).toBe(false);
  client?.dispose();
  expect(oxy.dispose).toHaveBeenCalledTimes(1);
});
it('never reuses a requester client across accounts and snapshots proof options', async () => {
  const oxy = host();
  const requester = { accountId: 'A', requesterContext: 'context-A' };
  const a = crowdSourceForOxyService({ oxy, requester });
  requester.accountId = 'B';
  requester.requesterContext = 'context-B';
  const b = crowdSourceForOxyService({ oxy, requester });
  expect(a).not.toBe(b);
  expect(oxy.createServiceClient.mock.calls[0]?.[0].requester).toEqual({
    accountId: 'A',
    requesterContext: 'context-A',
  });
  expect(oxy.createServiceClient.mock.calls[1]?.[0].requester).toEqual(requester);
  a?.dispose();
  b?.dispose();
});
it('shares only the default application client and disposes it on reset', () => {
  const oxy = host();
  sdk.canAttestWorkloadIdentity.mockReturnValue(true);
  sdk.oxyServiceHost.mockReturnValue(oxy);
  const a = crowdSourceForOxyService();
  expect(crowdSourceForOxyService()).toBe(a);
  expect(oxy.createServiceClient).toHaveBeenCalledTimes(1);
  resetCrowdSourceForOxyService();
  expect(oxy.dispose).toHaveBeenCalledTimes(1);
});
it('logs an unavailable binding without leaking response details', async () => {
  const oxy = host();
  oxy.fetch.mockRejectedValue(new Error('secret bearer must not reach logs'));
  const logger = { info: vi.fn(), error: vi.fn() };
  const client = crowdSourceForOxyService({ oxy, logger });
  await expect(client?.applicationId).rejects.toThrow();
  expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret bearer');
  client?.dispose();
});

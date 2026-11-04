import { expect, it, vi } from 'vitest';
import { CROWDSOURCE_SERVICE_AUDIENCE } from '../defaults.js';
import { crowdSourceForOxyService, type OxyServiceHost } from '../oxyService.js';

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

it('uses the caller server transport with no manual bearer or scope map', async () => {
  const oxy = host();
  const client = crowdSourceForOxyService({ oxy, baseUrl: 'https://crowdsource.test' });
  expect(oxy.createServiceClient).toHaveBeenCalledWith({
    baseURL: 'https://crowdsource.test',
    audience: CROWDSOURCE_SERVICE_AUDIENCE,
  });
  expect(await client.applicationId).toBe('bound-tenant');
  expect(new Headers(oxy.fetch.mock.calls[0]?.[1]?.headers).has('authorization')).toBe(false);
  client.dispose();
  expect(oxy.dispose).toHaveBeenCalledTimes(1);
});

it('builds one client per call, so a caller decides what is shared', () => {
  const oxy = host();
  const a = crowdSourceForOxyService({ oxy });
  const b = crowdSourceForOxyService({ oxy });
  expect(a).not.toBe(b);
  expect(oxy.createServiceClient).toHaveBeenCalledTimes(2);
  a.dispose();
  b.dispose();
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
  a.dispose();
  b.dispose();
});

it('logs an unavailable binding without leaking response details', async () => {
  const oxy = host();
  oxy.fetch.mockRejectedValue(new Error('secret bearer must not reach logs'));
  const logger = { info: vi.fn(), error: vi.fn() };
  const client = crowdSourceForOxyService({ oxy, logger });
  await expect(client.applicationId).rejects.toThrow();
  await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());
  expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret bearer');
  client.dispose();
});

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';

const id = '111111111111111111111111';
const token = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from('{"sub":"owner","exp":4102444800}').toString('base64url')}.fixture`;
const organization = (accountId: string) => ({
  accountId,
  name: 'Canonical company',
  organizationType: 'business',
  username: null,
  avatar: null,
  legalName: null,
  websiteUrl: null,
  countryCode: null,
  aliases: [],
  verifiedDomains: [],
  claimStatus: 'claimed',
  status: 'active',
  mergedIntoAccountId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});
let role = 'owner';
let permissions = ['account:update'];
let claimed = true;
let fail = false;
let applicationOwner = id;
const requests: { path: string; authorization: string | null; ids?: string[] }[] = [];
const node = () => ({
  accountId: id,
  kind: 'organization',
  callerMembership: { status: 'active', role, permissions },
});
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const record: (typeof requests)[number] = {
      path,
      authorization: request.headers.get('authorization'),
    };
    requests.push(record);
    if (fail)
      return Response.json(
        { error: { code: 'service_unavailable', message: 'Unavailable' } },
        { status: 503 },
      );
    if (path === '/organizations/batch') {
      const { ids } = (await request.json()) as { ids: string[] };
      record.ids = ids;
      return Response.json({
        items: ids
          .filter((value) => value !== 'missing')
          .map((value) => ({
            requestedAccountId: value,
            organization: {
              ...organization(value === 'old' ? id : value),
              status: value === 'suppressed' ? 'suppressed' : 'active',
            },
          })),
        missingIds: ids.includes('missing') ? ['missing'] : [],
      });
    }
    if (path.startsWith('/organizations/'))
      return Response.json({ ...organization(id), claimStatus: claimed ? 'claimed' : 'unclaimed' });
    if (path.startsWith('/applications/'))
      return Response.json({ application: { ownerAccountId: applicationOwner } });
    if (path === '/accounts') return Response.json({ accounts: [node()] });
    if (path.startsWith('/accounts/')) return Response.json({ account: node() });
    return new Response(null, { status: 404 });
  },
});
const originalUrl = process.env.OXY_API_URL;
process.env.OXY_API_URL = `http://127.0.0.1:${server.port}`;
const { organizationDirectory, registrationOrganizations, requireRegistrationOrganization } =
  await import('../modules/tenancy/organizationDirectory');
const { authorizeFirstPartyBinding } = await import('../modules/tenancy/bootstrapFirstParty');
beforeEach(() => {
  requests.length = 0;
  applicationOwner = id;
  role = 'owner';
  permissions = ['account:update'];
  claimed = true;
  fail = false;
});
afterAll(() => {
  if (originalUrl === undefined) delete process.env.OXY_API_URL;
  else process.env.OXY_API_URL = originalUrl;
  server.stop(true);
});

describe('canonical organization transport', () => {
  it('deduplicates across bounded public batches without leaking a human token', async () => {
    const ids = Array.from({ length: 205 }, (_, index) => `company-${index}`);
    const result = await organizationDirectory([...ids, ...ids, null]);
    expect(result.size).toBe(205);
    expect(requests.map((request) => request.ids?.length)).toEqual([100, 100, 5]);
    expect(requests.every((request) => request.authorization === null)).toBe(true);
  });
  it('resolves redirects and omits missing or suppressed identities without a local name fallback', async () => {
    const result = await organizationDirectory(['old', 'missing', 'suppressed']);
    expect(result.get('old')?.accountId).toBe(id);
    expect(result.has('missing')).toBe(false);
    expect(result.has('suppressed')).toBe(false);
  });
  it('forwards only the original bearer to the live account authority check', async () => {
    expect((await requireRegistrationOrganization(token, 'old')).accountId).toBe(id);
    expect(requests).toEqual([
      { path: '/organizations/old', authorization: null },
      { path: `/accounts/${id}`, authorization: `Bearer ${token}` },
    ]);
  });
  it.each(['viewer', 'editor', 'developer', 'billing'])(
    'refuses %s even with an extra account:update grant',
    async (value) => {
      role = value;
      await expect(requireRegistrationOrganization(token, id)).rejects.toMatchObject({
        status: 403,
      });
    },
  );
  it('honors explicit permission revocation on an admin role', async () => {
    role = 'admin';
    permissions = [];
    await expect(requireRegistrationOrganization(token, id)).rejects.toMatchObject({ status: 403 });
  });
  it('refuses neutral unclaimed companies', async () => {
    claimed = false;
    await expect(requireRegistrationOrganization(token, id)).rejects.toMatchObject({ status: 403 });
  });
  it('selects only live eligible accounts and does not infer console membership', async () => {
    expect((await registrationOrganizations(token)).map((item) => item.accountId)).toEqual([id]);
    role = 'viewer';
    expect(await registrationOrganizations(token)).toEqual([]);
  });
  it('checks first-party application owner using canonical IDs before provisioning', async () => {
    const args = {
      name: 'Mention',
      organizationSlug: 'workspace',
      oxyApplicationId: 'application-id',
      oxyOrganizationId: 'old',
    };
    expect((await authorizeFirstPartyBinding(args, token)).oxyOrganizationId).toBe(id);
    expect(
      requests.find((request) => request.path === '/applications/application-id')?.authorization,
    ).toBe(`Bearer ${token}`);
    applicationOwner = 'different-owner';
    await expect(authorizeFirstPartyBinding(args, token)).rejects.toMatchObject({ status: 403 });
  });

  it('fails closed for missing sessions and unavailable directory', async () => {
    await expect(requireRegistrationOrganization(undefined, id)).rejects.toMatchObject({
      status: 401,
    });
    expect(requests).toHaveLength(0);
    fail = true;
    await expect(organizationDirectory([id])).rejects.toMatchObject({ status: 503 });
    await expect(requireRegistrationOrganization(token, id)).rejects.toMatchObject({ status: 503 });
  });
});

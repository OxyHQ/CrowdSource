import { mock } from 'bun:test';

/** Canonical directory boundary fixture; real SDK HTTP behavior has its own suite. */
export function installOrganizationDirectoryFixture() {
  const identity = (accountId: string) => ({
    accountId,
    name: accountId.startsWith('oxy-org-') ? 'Test Organization' : accountId,
    status: 'active',
    claimStatus: 'claimed',
    organizationType: 'business',
    aliases: [],
    verifiedDomains: [],
    username: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  mock.module('../../modules/tenancy/organizationDirectory', () => ({
    organizationDirectory: async (ids: (string | null)[]) =>
      new Map(ids.filter((id): id is string => Boolean(id)).map((id) => [id, identity(id)])),
    requireRegistrationOrganization: async (_token: string | undefined, id: string) => identity(id),
    registrationOrganizations: async () => [],
  }));
}

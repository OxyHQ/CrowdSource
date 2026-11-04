import type { AccountNode, Organization } from '@oxy.so/core';
import type { OxyAuthRequest, OxyUserClient } from '@oxy.so/core/server';

import { ApiError } from '../../http/apiError';
import { oxyRefusal, oxyServiceServer } from '../identity/oxyService';

/** The person a call is made as: a verified console request, or an operator's bearer. */
export type OrganizationSessionSource = OxyAuthRequest | string;

/**
 * Run `run` as the person behind `source` — the console request itself, or the
 * operator bearer the bootstrap script was handed — through the process's one
 * `OxyServer`. The client is isolated, uncached and disposed when `run` settles;
 * a request with no person (anonymous, or a service token) is a 401.
 */
export async function withOrganizationSession<T>(
  source: OrganizationSessionSource | undefined,
  run: (oxy: OxyUserClient) => Promise<T>,
): Promise<T> {
  if (!source) throw new ApiError('unauthorized', 'An Oxy session is required.');
  try {
    return await oxyServiceServer().withUser(source, run);
  } catch (error) {
    throw oxyRefusal(error, {
      denied: 'Organization administration is required.',
      unavailable: 'Organization access is temporarily unavailable.',
    });
  }
}

export function canRegisterOrganization(node: AccountNode): boolean {
  const membership = node.callerMembership;
  return (
    node.kind === 'organization' &&
    membership?.status === 'active' &&
    (membership.role === 'owner' || membership.role === 'admin') &&
    membership.permissions.includes('account:update')
  );
}

/** Public identity only, deduplicated and bounded; archived labels never serve as fallback. */
export async function organizationDirectory(
  ids: readonly (string | null)[],
): Promise<Map<string, Organization>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const result = new Map<string, Organization>();
  if (!unique.length) return result;
  try {
    // The service's own identity, never a person's: a public read charged to
    // this application rather than to the shared NAT address.
    const oxy = oxyServiceServer();
    for (let start = 0; start < unique.length; start += 100) {
      const batch = await oxy.organizations.batch({ ids: unique.slice(start, start + 100) });
      for (const item of batch.items)
        if (item.organization.status !== 'suppressed')
          result.set(item.requestedAccountId, item.organization);
    }
    return result;
  } catch {
    throw new ApiError('service_unavailable', 'Organization directory temporarily unavailable.');
  }
}

export async function requireRegistrationOrganization(
  source: OrganizationSessionSource | undefined,
  accountId: string,
): Promise<Organization> {
  if (!source) throw new ApiError('unauthorized', 'An Oxy session is required.');
  // The public company record is read as this service; only the authority
  // question below carries the person's bearer.
  let organization: Organization;
  try {
    organization = await oxyServiceServer().organizations.get(accountId);
  } catch (error) {
    throw oxyRefusal(error, {
      denied: 'An active organization you administer in Oxy is required.',
      unavailable: 'Organization access is temporarily unavailable.',
    });
  }
  return withOrganizationSession(source, async (oxy) => {
    const node = await oxy.accounts.get(organization.accountId);
    if (
      !canRegisterOrganization(node) ||
      organization.status !== 'active' ||
      organization.claimStatus !== 'claimed'
    ) {
      throw new ApiError('forbidden', 'An active organization you administer in Oxy is required.');
    }
    return organization;
  });
}

export async function registrationOrganizations(
  source: OrganizationSessionSource | undefined,
): Promise<Organization[]> {
  return withOrganizationSession(source, async (oxy) => {
    const forest = await oxy.accounts.list();
    const ids = forest.filter(canRegisterOrganization).map((node) => node.accountId);
    const directory = await organizationDirectory(ids);
    return [
      ...new Map(
        [...directory.values()]
          .filter((org) => org.status === 'active' && org.claimStatus === 'claimed')
          .map((org) => [org.accountId, org]),
      ).values(),
    ];
  });
}

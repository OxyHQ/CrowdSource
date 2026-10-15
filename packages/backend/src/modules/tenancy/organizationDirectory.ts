import { OxyApiError, OxyServices, type AccountNode, type Organization } from '@oxy.so/core';
import { config } from '../../config';
import { ApiError } from '../../http/apiError';

function client(): OxyServices {
  if (!config.oxy.apiUrl)
    throw new ApiError('service_unavailable', 'Organization directory unavailable.');
  return new OxyServices({
    baseURL: config.oxy.apiUrl,
    enableCache: false,
    enableRetry: false,
    requestTimeout: 5000,
  });
}

export async function withOrganizationSession<T>(
  token: string | undefined,
  run: (oxy: OxyServices) => Promise<T>,
): Promise<T> {
  if (!token) throw new ApiError('unauthorized', 'An Oxy session is required.');
  const oxy = client();
  oxy.session.setAccessToken(token);
  try {
    return await run(oxy);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof OxyApiError && error.status === 401)
      throw new ApiError('unauthorized', 'Your Oxy session is no longer valid.');
    if (error instanceof OxyApiError && (error.status === 403 || error.status === 404))
      throw new ApiError('forbidden', 'Organization administration is required.');
    throw new ApiError('service_unavailable', 'Organization access is temporarily unavailable.');
  } finally {
    oxy.dispose();
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
  const oxy = client();
  try {
    for (let start = 0; start < unique.length; start += 100) {
      const batch = await oxy.organizations.batch({ ids: unique.slice(start, start + 100) });
      for (const item of batch.items)
        if (item.organization.status !== 'suppressed')
          result.set(item.requestedAccountId, item.organization);
    }
    return result;
  } catch {
    throw new ApiError('service_unavailable', 'Organization directory temporarily unavailable.');
  } finally {
    oxy.dispose();
  }
}

export async function requireRegistrationOrganization(
  token: string | undefined,
  accountId: string,
): Promise<Organization> {
  return withOrganizationSession(token, async (oxy) => {
    const organization = await oxy.organizations.get(accountId);
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
  token: string | undefined,
): Promise<Organization[]> {
  return withOrganizationSession(token, async (oxy) => {
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

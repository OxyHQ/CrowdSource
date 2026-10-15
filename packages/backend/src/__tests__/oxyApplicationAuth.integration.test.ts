import { setOrganizationStatus } from '../modules/tenancy/provisioning.service';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';

/**
 * An Oxy service authenticating here with NO CrowdSource credential.
 *
 * The property under test is the same one the credential path is held to — the
 * tenant is a function of what was presented and of nothing else — plus the
 * negatives that decide whether this is a door or a hole:
 *
 *   * a token Oxy did not issue authenticates nothing;
 *   * a token Oxy DID issue, for an application nobody bound, authenticates
 *     nothing (proving what you are is not the same as being one of ours);
 *   * a bound application that has been suspended authenticates nothing;
 *   * the tenant comes from the stored row, never from the token;
 *   * privileged scopes are not reachable this way, whatever the caller is.
 *
 * Oxy's own verification is stubbed: this file is about what CrowdSource does
 * with a verified identity. That the verification is real is `@oxy.so/core`'s
 * to prove, and it is the reason this module has no parser of its own.
 */

const oxy = { appIdForToken: new Map<string, string>() };

// Registered before anything that reaches `@oxy.so/core/server` is imported,
// which is why the imports below are dynamic: `mock.module` is not hoisted.
// The rest of the module stays real: unlike vitest, Bun refuses to link a
// module that imports a name the mock does not export.
const actualOxyServer = await import('@oxy.so/core/server');
mock.module('@oxy.so/core/server', () => ({
  ...actualOxyServer,
  OxyServer: class {
    readonly middleware = {
      auth() {
        return (
          request: { headers: Record<string, string>; serviceApp?: unknown },
          _res: unknown,
          next: () => void,
        ) => {
          const token = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '')?.[1] ?? '';
          const appId = oxy.appIdForToken.get(token);
          if (appId) request.serviceApp = { appId };
          next();
        };
      },
    };
  },
}));

const { authenticateOxyServiceToken, looksLikeOxyServiceToken } = await import(
  '../modules/tenancy/oxyApplicationAuth'
);
const { APPLICATION_SCOPES, PRIVILEGED_SCOPES } = await import('../modules/tenancy/scopes');
const { applications } = await import('../modules/tenancy/tenancy.collections');
const { provisionTenant, startDatabase, stopDatabase } = await import('./support/tenants');

/** A JWT-shaped string. Its contents never matter: the stub decides. */
const tokenFor = (label: string) => `header.${label}.signature`;

/** Express only ever hands this module a request it can read headers from. */
const requestStub = { headers: {} } as never;

beforeAll(async () => {
  await startDatabase();
});

afterAll(async () => {
  await stopDatabase();
});

beforeEach(() => {
  oxy.appIdForToken.clear();
});

async function boundTenant(oxyApplicationId: string) {
  const tenant = await provisionTenant();
  await applications.updateOne({ applicationId: tenant.applicationId }, { oxyApplicationId });
  return tenant;
}

describe('authenticating an Oxy service', () => {
  it('resolves the tenant from the binding, not from the token', async () => {
    const oxyApplicationId = `oxy-app-${randomUUID()}`;
    const tenant = await boundTenant(oxyApplicationId);
    const token = tokenFor('bound');
    oxy.appIdForToken.set(token, oxyApplicationId);

    const caller = await authenticateOxyServiceToken(token, requestStub);

    expect(caller.tenant).toMatchObject({
      organizationId: tenant.organizationId,
      applicationId: tenant.applicationId,
    });
    expect(caller.credentialId).toBe(`oxy:${oxyApplicationId}`);
  });

  it('grants every application scope and no privileged one', async () => {
    const oxyApplicationId = `oxy-app-${randomUUID()}`;
    await boundTenant(oxyApplicationId);
    const token = tokenFor('scopes');
    oxy.appIdForToken.set(token, oxyApplicationId);

    const caller = await authenticateOxyServiceToken(token, requestStub);

    expect([...caller.scopes].sort()).toEqual([...APPLICATION_SCOPES].sort());
    for (const privileged of PRIVILEGED_SCOPES) {
      expect(caller.scopes).not.toContain(privileged);
    }
  });

  it('refuses a token Oxy did not issue', async () => {
    const oxyApplicationId = `oxy-app-${randomUUID()}`;
    await boundTenant(oxyApplicationId);
    // The stub knows nothing about this token, which is what Oxy's verifier
    // answers for a forged or expired one.

    await expect(
      authenticateOxyServiceToken(tokenFor('forged'), requestStub),
    ).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('refuses a real token for an application nobody bound', async () => {
    const token = tokenFor('unbound');
    oxy.appIdForToken.set(token, `oxy-app-${randomUUID()}`);

    await expect(authenticateOxyServiceToken(token, requestStub)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('refuses a binding whose application is no longer active', async () => {
    const oxyApplicationId = `oxy-app-${randomUUID()}`;
    const tenant = await boundTenant(oxyApplicationId);
    const token = tokenFor('suspended');
    oxy.appIdForToken.set(token, oxyApplicationId);
    // The positive control: it works before the application is suspended.
    await expect(authenticateOxyServiceToken(token, requestStub)).resolves.toMatchObject({
      credentialId: `oxy:${oxyApplicationId}`,
    });

    await applications.updateOne({ applicationId: tenant.applicationId }, { status: 'suspended' });

    await expect(authenticateOxyServiceToken(token, requestStub)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('refuses a suspended organization even while its application and Oxy service binding remain active', async () => {
    const oxyApplicationId = `oxy-app-${randomUUID()}`;
    const tenant = await boundTenant(oxyApplicationId);
    const token = tokenFor('suspended-org');
    oxy.appIdForToken.set(token, oxyApplicationId);
    await expect(authenticateOxyServiceToken(token, requestStub)).resolves.toBeDefined();
    await setOrganizationStatus(tenant.organizationId, 'suspended');
    await expect(authenticateOxyServiceToken(token, requestStub)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('never resolves one Oxy application to another tenant', async () => {
    const mine = `oxy-app-${randomUUID()}`;
    const theirs = `oxy-app-${randomUUID()}`;
    const myTenant = await boundTenant(mine);
    await boundTenant(theirs);
    const token = tokenFor('mine');
    oxy.appIdForToken.set(token, mine);

    const caller = await authenticateOxyServiceToken(token, requestStub);

    expect(caller.tenant.applicationId).toBe(myTenant.applicationId);
  });
});

describe('which verifier a token reaches', () => {
  it.each([
    ['an Oxy service token', 'header.payload.signature', true],
    ['a CrowdSource credential', 'cred_01ABCDEF:secret-value', false],
    ['something malformed', 'nonsense', false],
  ])('recognises %s', (_label, token, expected) => {
    expect(looksLikeOxyServiceToken(token)).toBe(expected);
  });
});

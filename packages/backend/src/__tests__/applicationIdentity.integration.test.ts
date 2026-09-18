import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import { provisionApplication, provisionTenant, startDatabase, stopDatabase } from './support/tenants';

/**
 * `GET /v1/applications/me` — the one route that authenticates without asking
 * for a scope.
 *
 * It exists for a caller that holds no CrowdSource credential: a first-party Oxy
 * service presents an Oxy service token, which names the Oxy application and
 * nothing about CrowdSource, so the tenant it maps to is a fact only this server
 * has. The report envelope names its application and the server refuses one that
 * disagrees — so a service that cannot ask this question cannot file a report.
 *
 * The properties worth holding are the ones that make it an identity echo rather
 * than a lookup: the answer comes from the authenticated tenant, it needs no
 * scope, and it still needs authentication.
 */

const app = createApp();

const ask = (token?: string) => {
  const pending = request(app).get('/v1/applications/me');
  return token ? pending.set('Authorization', `Bearer ${token}`) : pending;
};

beforeAll(async () => {
  await startDatabase();
});

afterAll(async () => {
  await stopDatabase();
});

describe('GET /v1/applications/me', () => {
  it('answers with the tenant the credential resolved to', async () => {
    const tenant = await provisionTenant();

    const response = await ask(tenant.token);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      applicationId: tenant.applicationId,
      organizationId: tenant.organizationId,
    });
  });

  it('names no capability — a credential granting one unrelated scope is enough', async () => {
    // Every other application route names the capability it needs. Naming one
    // here would mean asking for `reports:read` to learn where one's reports go.
    // A credential must hold at least one scope to exist at all, so the narrow
    // case this can express is a credential holding only a scope this route has
    // no use for.
    const tenant = await provisionTenant(['crowdsource:schemas:manage']);

    const response = await ask(tenant.token);

    expect(response.status).toBe(200);
    expect(response.body.applicationId).toBe(tenant.applicationId);
  });

  it('refuses an unauthenticated caller', async () => {
    const response = await ask();

    expect(response.status).toBe(401);
  });

  it('refuses a credential that does not exist', async () => {
    const response = await ask('cred_01DOESNOTEXIST:not-a-secret');

    expect(response.status).toBe(401);
  });

  it('never answers with a sibling application under the same organization', async () => {
    // One organization routinely runs several products, and this route is how a
    // service learns which one it is. Answering with the organization's first
    // application would send a second product's reports into the first's tenant.
    const first = await provisionTenant();
    const second = await provisionApplication(first.organizationId);

    const response = await ask(second.token);

    expect(response.body.applicationId).toBe(second.applicationId);
    expect(response.body.applicationId).not.toBe(first.applicationId);
  });
});

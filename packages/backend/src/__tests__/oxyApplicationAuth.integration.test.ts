import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import express from 'express';
import request from 'supertest';
import type { ServiceIntrospection } from '@oxy.so/contracts';

const live = new Map<string, ServiceIntrospection>();
const actual = await import('@oxy.so/core/server');
const temporaryCredentials = (accessKeyId: string) => async () => ({
  AccessKeyId: accessKeyId,
  SecretAccessKey: 'fixture-secret',
  Token: 'fixture-session',
});
mock.module('@oxy.so/core/server/aws', () => ({
  createAwsWorkloadCredentialProvider: () => temporaryCredentials('ASIA_CROWD_RECEIVER'),
}));
const { config } = await import('../config');
const originalApiUrl = config.oxy.apiUrl;
let issuer: ReturnType<typeof Bun.serve>;
let callerApplicationId = '';
const { CROWDSOURCE_SERVICE_AUDIENCE, looksLikeOxyServiceToken } = await import(
  '../modules/tenancy/oxyApplicationAuth'
);
const { requireServiceCredential, requireAnyServiceCredential, serviceCredentialCaller } =
  await import('../modules/tenancy/serviceCredentialAuth');
const { applications, applicationCredentials } = await import(
  '../modules/tenancy/tenancy.collections'
);
const { setOrganizationStatus } = await import('../modules/tenancy/provisioning.service');
const { provisionTenant, startDatabase, stopDatabase } = await import('./support/tenants');
const { errorHandler } = await import('../http/errorHandler');
const { crowdSourceForOxyService } = await import('../../../core/src/oxyService');

const key = generateKeyPairSync('ed25519');
const jwk = {
  ...key.publicKey.export({ format: 'jwk' }),
  kid: 'receiver-test',
  alg: 'EdDSA',
  use: 'sig',
};
const app = express();
app.use(express.json());
app.get('/v1/applications/me', requireAnyServiceCredential(), (req, res) =>
  res.json(serviceCredentialCaller(req).tenant),
);
app.get('/read', requireServiceCredential('crowdsource:reports:read'), (req, res) =>
  res.json(serviceCredentialCaller(req)),
);
app.post('/write', requireServiceCredential('crowdsource:reports:write'), (req, res) => {
  const caller = serviceCredentialCaller(req);
  if (req.body.applicationId !== caller.tenant.applicationId) return res.sendStatus(403);
  return res.json(caller);
});
app.post('/privileged', requireServiceCredential('crowdsource:decisions:emit'), (_req, res) =>
  res.sendStatus(200),
);
app.use(errorHandler);

function token(
  appId: string,
  authority: 'first_party' | 'external' = 'first_party',
  audience = CROWDSOURCE_SERVICE_AUDIENCE,
) {
  const now = Math.floor(Date.now() / 1000);
  const credentialId = `${authority === 'first_party' ? 'wl_' : 'cred_'}${randomUUID()}`;
  const scopes = ['crowdsource:reports:read'];
  const claims = {
    type: 'service',
    appId,
    appName: 'Official application',
    tier: 'internal',
    authority,
    credentialId,
    ownerAccountId: 'billing',
    environment: 'production',
    iss: 'oxy-auth',
    aud: audience,
    iat: now,
    exp: now + 300,
    ...(authority === 'external' ? { scopes } : {}),
  };
  const data = [{ alg: 'EdDSA', typ: 'JWT', kid: jwk.kid }, claims]
    .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'))
    .join('.');
  const bearer = `${data}.${sign(null, Buffer.from(data), key.privateKey).toString('base64url')}`;
  const common = {
    active: true as const,
    accountId: 'billing',
    applicationId: appId,
    credentialId,
    environment: 'production' as const,
    audience,
    expiresAt: new Date((now + 300) * 1000).toISOString(),
  };
  live.set(
    bearer,
    authority === 'first_party' ? { ...common, authority } : { ...common, authority, scopes },
  );
  return { bearer, credentialId };
}
async function bound() {
  const tenant = await provisionTenant();
  const appId = `oxy-${randomUUID()}`;
  await applications.updateOne(
    { applicationId: tenant.applicationId },
    { oxyApplicationId: appId },
  );
  return { ...tenant, appId };
}
beforeAll(async () => {
  await startDatabase();
  issuer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/.well-known/jwks.json') return Response.json({ keys: [jwk] });
      if (path === '/auth/service-token/workload/challenge')
        return Response.json({ data: { nonce: 'crowdsource-challenge' } });
      if (path === '/auth/service-token/workload') {
        const body = (await request.json()) as {
          provider?: string;
          protocolVersion?: number;
          nonce?: string;
          audience?: string;
          attestation?: { headers?: Record<string, string> };
        };
        const signature = body.attestation?.headers?.authorization ?? '';
        if (
          body.provider !== 'aws-iam' ||
          body.protocolVersion !== 2 ||
          body.nonce !== 'crowdsource-challenge' ||
          body.attestation?.headers?.['x-oxy-attestation-nonce'] !== body.nonce ||
          !signature.includes('ASIA_CROWD_')
        )
          return new Response(null, { status: 401 });
        const appId = signature.includes('ASIA_CROWD_RECEIVER')
          ? 'crowdsource-receiver'
          : callerApplicationId;
        const proof = token(appId, 'first_party', body.audience ?? 'oxy-api');
        return Response.json({
          data: { token: proof.bearer, expiresIn: 300, appName: 'Own workload' },
        });
      }
      if (path === '/auth/resources/introspect') {
        // The receiver's cached signed token remains valid across caller revocation.
        const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
        const payload = JSON.parse(Buffer.from(bearer.split('.')[1] ?? '', 'base64url').toString());
        if (payload.appId !== 'crowdsource-receiver') return new Response(null, { status: 401 });
        const body = (await request.json()) as { token: string };
        const result = live.get(body.token);
        return Response.json(result?.active ? { ...result, kind: 'service' } : { active: false });
      }
      if (path.includes('acting-as')) return Response.json({ authorized: false });
      return new Response(null, { status: 404 });
    },
  });
  Reflect.set(config.oxy, 'apiUrl', issuer.url.toString().replace(/\/$/, ''));
});
afterAll(async () => {
  const { oxyServiceServer } = await import('../modules/identity/oxyService');
  oxyServiceServer().dispose();
  issuer.stop(true);
  Reflect.set(config.oxy, 'apiUrl', originalApiUrl);
  await stopDatabase();
});
beforeEach(() => live.clear());

describe('shared service verifier and tenant binding over HTTP', () => {
  it('own authority has no scopes and audits the actual workload credential', async () => {
    const tenant = await bound();
    const proof = token(tenant.appId);
    const response = await request(app).get('/read').auth(proof.bearer, { type: 'bearer' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      authority: 'first_party',
      credentialId: `oxy:${proof.credentialId}`,
      tenant: { applicationId: tenant.applicationId },
    });
    expect(response.body).not.toHaveProperty('scopes');
    expect(
      (await request(app).post('/privileged').auth(proof.bearer, { type: 'bearer' })).status,
    ).toBe(403);
  });
  it('official branding never promotes an external Oxy key or its scopes', async () => {
    const tenant = await bound();
    const proof = token(tenant.appId, 'external', 'oxy-api');
    expect((await request(app).get('/read').auth(proof.bearer, { type: 'bearer' })).status).toBe(
      200,
    );
    expect(
      (
        await request(app)
          .post('/write')
          .auth(proof.bearer, { type: 'bearer' })
          .send({ applicationId: tenant.applicationId })
      ).status,
    ).toBe(403);
    live.delete(proof.bearer);
    expect((await request(app).get('/read').auth(proof.bearer, { type: 'bearer' })).status).toBe(
      401,
    );
  });
  it('checks live workload revocation on the next request', async () => {
    const tenant = await bound();
    const proof = token(tenant.appId);
    expect((await request(app).get('/read').auth(proof.bearer, { type: 'bearer' })).status).toBe(
      200,
    );
    live.delete(proof.bearer);
    expect((await request(app).get('/read').auth(proof.bearer, { type: 'bearer' })).status).toBe(
      401,
    );
  });
  it('refuses wrong audience, unbound identity and an unproven account header', async () => {
    const tenant = await bound();
    for (const bearer of [
      token(tenant.appId, 'first_party', 'oxy-service:other').bearer,
      token('unbound').bearer,
      'header.forged.signature',
    ]) {
      expect((await request(app).get('/read').auth(bearer, { type: 'bearer' })).status).toBe(401);
    }
    const proof = token(tenant.appId);
    // No session/task/context can substantiate this account header.
    expect(
      (
        await request(app)
          .get('/read')
          .auth(proof.bearer, { type: 'bearer' })
          .set('X-Oxy-User-Id', 'other-person')
      ).status,
    ).not.toBe(200);
  });
  it('preserves application, organization and envelope tenant fences', async () => {
    const tenant = await bound();
    const other = await bound();
    const proof = token(tenant.appId);
    expect(
      (
        await request(app)
          .post('/write')
          .auth(proof.bearer, { type: 'bearer' })
          .send({ applicationId: other.applicationId })
      ).status,
    ).toBe(403);
    await applications.updateOne({ applicationId: tenant.applicationId }, { status: 'suspended' });
    expect((await request(app).get('/read').auth(proof.bearer, { type: 'bearer' })).status).toBe(
      401,
    );
    await applications.updateOne({ applicationId: tenant.applicationId }, { status: 'active' });
    await setOrganizationStatus(tenant.organizationId, 'suspended');
    expect((await request(app).get('/read').auth(proof.bearer, { type: 'bearer' })).status).toBe(
      401,
    );
  });
  it('keeps native CrowdSource keys bounded and revocable', async () => {
    const tenant = await provisionTenant(['crowdsource:reports:read']);
    expect((await request(app).get('/read').auth(tenant.token, { type: 'bearer' })).status).toBe(
      200,
    );
    expect((await request(app).post('/write').auth(tenant.token, { type: 'bearer' })).status).toBe(
      403,
    );
    await applicationCredentials.updateOne(
      { credentialId: tenant.token.split('.')[0] },
      { status: 'revoked' },
    );
    expect((await request(app).get('/read').auth(tenant.token, { type: 'bearer' })).status).toBe(
      401,
    );
  });
  it('resolves the SDK identity through the same HTTP receiver', async () => {
    const tenant = await bound();
    callerApplicationId = tenant.appId;
    const listener = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => listener.once('listening', resolve));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    try {
      const oxy = new actual.OxyServer({
        baseURL: issuer.url.toString(),
        workloadCredentials: temporaryCredentials('ASIA_CROWD_CALLER'),
      });
      try {
        const client = crowdSourceForOxyService({
          oxy,
          baseUrl: `http://localhost:${address.port}`,
        });
        expect(await client?.applicationId).toBe(tenant.applicationId);
        client?.dispose();
      } finally {
        oxy.dispose();
      }
    } finally {
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });
});
it('token shape selects a verifier, never authority', () => {
  expect(looksLikeOxyServiceToken('a.b.c')).toBe(true);
  expect(looksLikeOxyServiceToken('cred_secret.value')).toBe(false);
});

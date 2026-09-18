import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootstrapFirstParty } from '../scripts/bootstrapFirstParty';
import { applications, organizations } from '../modules/tenancy/tenancy.collections';
import { startDatabase, stopDatabase } from './support/tenants';

/**
 * Onboarding one of Oxy's own services.
 *
 * A deploy runs this, which means it runs OFTEN and unattended. So the
 * properties that matter are not "it creates rows" but what happens the second,
 * third and hundredth time — and the one case where it must refuse rather than
 * quietly do the wrong thing.
 */

const args = (name: string, oxyApplicationId: string) => ({
  name,
  oxyApplicationId,
  organizationSlug: `oxy-test-${randomUUID().slice(0, 8)}`,
  organizationName: 'Oxy Test',
});

beforeAll(async () => {
  await startDatabase();
});

afterAll(async () => {
  await stopDatabase();
});

describe('bootstrapping a first-party application', () => {
  it('creates the organization, the application and the binding', async () => {
    const input = args('Mention', `oxy-app-${randomUUID()}`);

    const applicationId = await bootstrapFirstParty(input);

    const application = await applications.findOne({ applicationId });
    expect(application).toMatchObject({ name: 'Mention', status: 'active', oxyApplicationId: input.oxyApplicationId });
    const organization = await organizations.findOne({ organizationId: application?.organizationId });
    expect(organization).toMatchObject({ slug: input.organizationSlug });
  });

  it('issues no credential — there is nothing to copy anywhere', async () => {
    const input = args('Alia', `oxy-app-${randomUUID()}`);

    const applicationId = await bootstrapFirstParty(input);

    const { applicationCredentials } = await import('../modules/tenancy/tenancy.collections');
    expect(await applicationCredentials.findOne({ applicationId })).toBeNull();
  });

  it('is idempotent: running it again changes nothing', async () => {
    const input = args('Syra', `oxy-app-${randomUUID()}`);

    const first = await bootstrapFirstParty(input);
    const second = await bootstrapFirstParty(input);

    expect(second).toBe(first);
    const all = await applications.find({ oxyApplicationId: input.oxyApplicationId });
    expect(all).toHaveLength(1);
  });

  it('puts two services in ONE organization rather than one each', async () => {
    const slug = `oxy-test-${randomUUID().slice(0, 8)}`;
    const first = await bootstrapFirstParty({ ...args('Homiio', `oxy-app-${randomUUID()}`), organizationSlug: slug });
    const second = await bootstrapFirstParty({ ...args('Noted', `oxy-app-${randomUUID()}`), organizationSlug: slug });

    const one = await applications.findOne({ applicationId: first });
    const two = await applications.findOne({ applicationId: second });
    expect(one?.organizationId).toBe(two?.organizationId);
  });

  it('refuses to repoint an application at a different Oxy identity', async () => {
    const slug = `oxy-test-${randomUUID().slice(0, 8)}`;
    const name = 'Moovo';
    await bootstrapFirstParty({ ...args(name, `oxy-app-${randomUUID()}`), organizationSlug: slug });

    // The same application NAME, a different Oxy application. Silently moving
    // the binding would hand one service another's tenant and its data.
    await expect(
      bootstrapFirstParty({ ...args(name, `oxy-app-${randomUUID()}`), organizationSlug: slug }),
    ).rejects.toThrow(/already bound to a different Oxy application/);
  });
});

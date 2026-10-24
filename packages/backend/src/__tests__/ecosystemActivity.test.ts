import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { createEcosystemTraffic } from '@oxy.so/core/server';
import { workloadCredentials } from '../modules/identity/workload';
import {
  ecosystemActivityMiddleware,
  startEcosystemActivity,
  stopEcosystemActivity,
} from '../ecosystemActivity';

afterEach(stopEcosystemActivity);

describe('ecosystem activity configuration', () => {
  test('missing infrastructure region leaves session and application routes available', () => {
    const create = mock<typeof createEcosystemTraffic>(() => {
      throw new Error('must not create');
    });
    startEcosystemActivity(() => false, create, '');
    expect(create).not.toHaveBeenCalled();
    let continued = false;
    ecosystemActivityMiddleware({} as never, {} as never, () => {
      continued = true;
    });
    expect(continued).toBe(true);
  });
  test('configured region forwards temporary role provider without an ECS gate', async () => {
    const publisher = { installFetch: mock(), stop: mock(async () => {}) };
    const create = mock<typeof createEcosystemTraffic>(
      () => publisher as unknown as ReturnType<typeof createEcosystemTraffic>,
    );
    const ready = () => true;
    startEcosystemActivity(ready, create, 'us-west-2');
    startEcosystemActivity(ready, create, 'us-west-2');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      service: 'crowdsource',
      ready,
      region: 'us-west-2',
      workloadCredentials,
    });
    expect(publisher.installFetch).toHaveBeenCalledTimes(1);
    await stopEcosystemActivity();
    expect(publisher.stop).toHaveBeenCalledTimes(1);
  });
});

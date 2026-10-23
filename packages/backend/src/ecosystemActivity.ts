import { canAttestWorkloadIdentity, createEcosystemTraffic } from '@oxy.so/core/server';
import type { RequestHandler } from 'express';

let activity: ReturnType<typeof createEcosystemTraffic> | undefined;

/** Own telemetry uses attested workload identity, never customer API keys. */
function canAuthenticateToOxy(): boolean {
  return canAttestWorkloadIdentity();
}

/** Start only at process bootstrap; constructing a test app starts no publisher. */
export function startEcosystemActivity(ready: () => boolean): void {
  if (!canAuthenticateToOxy()) {
    console.warn(
      'Ecosystem activity is disabled for crowdsource: no workload identity this process can attest',
    );
    return;
  }
  if (activity) return;
  activity = createEcosystemTraffic({
    service: 'crowdsource',
    ready,
  });
  activity.installFetch();
}

export const ecosystemActivityMiddleware: RequestHandler = (request, response, next) => {
  if (activity) activity.observeHttp(request, response, next);
  else next();
};

export function observeEcosystemSocket(
  socket: Parameters<ReturnType<typeof createEcosystemTraffic>['observeSocket']>[0],
): void {
  activity?.observeSocket(socket);
}

export async function stopEcosystemActivity(): Promise<void> {
  const current = activity;
  activity = undefined;
  await current?.stop();
}

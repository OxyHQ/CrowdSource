import { createEcosystemTraffic } from '@oxy.so/core/server';
import type { RequestHandler } from 'express';
import { workloadCredentials } from './modules/identity/workload';

let activity: ReturnType<typeof createEcosystemTraffic> | undefined;

/** Region config enables telemetry; the shared provider resolves role credentials on demand. */
export function startEcosystemActivity(
  ready: () => boolean,
  create: typeof createEcosystemTraffic = createEcosystemTraffic,
  region = process.env.AWS_REGION,
): void {
  if (activity || !region) return;
  activity = create({ service: 'crowdsource', ready, region, workloadCredentials });
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

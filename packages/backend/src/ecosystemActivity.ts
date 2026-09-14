import { createEcosystemTraffic } from '@oxy.so/core/server';
import type { RequestHandler } from 'express';

let activity: ReturnType<typeof createEcosystemTraffic> | undefined;

/** Start only at process bootstrap; constructing a test app starts no publisher. */
export function startEcosystemActivity(ready: () => boolean): void {
  if (!process.env.OXY_SERVICE_API_KEY?.trim() || !process.env.OXY_SERVICE_API_SECRET?.trim()) {
    console.warn('Ecosystem activity is disabled for crowdsource: missing OXY_SERVICE_API_KEY/OXY_SERVICE_API_SECRET');
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

export function observeEcosystemSocket(socket: Parameters<ReturnType<typeof createEcosystemTraffic>['observeSocket']>[0]): void {
  activity?.observeSocket(socket);
}

export async function stopEcosystemActivity(): Promise<void> {
  const current = activity;
  activity = undefined;
  await current?.stop();
}

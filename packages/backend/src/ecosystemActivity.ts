import { canAttestWorkloadIdentity, createEcosystemTraffic } from '@oxy.so/core/server';
import type { RequestHandler } from 'express';

let activity: ReturnType<typeof createEcosystemTraffic> | undefined;

/**
 * Whether this process can authenticate to Oxy at all.
 *
 * Two ways, and the second is the one that outlives the first. A key pair in the
 * environment is what a task definition injects today. A workload identity
 * (oxy ADR 0026) is what the task PROVES by signing an STS `GetCallerIdentity`
 * request with its own IAM task role — no secret anyone typed, nothing in a
 * parameter store to rotate or leak. `@oxy.so/core` picks the pair when it is
 * present and falls back to attestation when it is not, so this only has to
 * answer "is either available".
 *
 * Checking BOTH is what makes the credential deletable. The pair-only guard this
 * replaced returned before `createEcosystemTraffic` was ever constructed, so the
 * day `OXY_SERVICE_API_KEY` left the task definition, crowdsource would have
 * stopped publishing ecosystem activity silently — a warning in a log nobody
 * reads, a service still healthy, and a producer simply gone. The library can
 * attest; it just never got the chance to.
 *
 * Off a task — a laptop, a CI runner — neither is available and the answer is
 * still no, which is the case the warning below is for.
 */
function canAuthenticateToOxy(): boolean {
  const hasKeyPair = Boolean(
    process.env.OXY_SERVICE_API_KEY?.trim() && process.env.OXY_SERVICE_API_SECRET?.trim(),
  );
  return hasKeyPair || canAttestWorkloadIdentity();
}

/** Start only at process bootstrap; constructing a test app starts no publisher. */
export function startEcosystemActivity(ready: () => boolean): void {
  if (!canAuthenticateToOxy()) {
    console.warn(
      'Ecosystem activity is disabled for crowdsource: no OXY_SERVICE_API_KEY/OXY_SERVICE_API_SECRET pair, and no workload identity this process can attest',
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

export function observeEcosystemSocket(socket: Parameters<ReturnType<typeof createEcosystemTraffic>['observeSocket']>[0]): void {
  activity?.observeSocket(socket);
}

export async function stopEcosystemActivity(): Promise<void> {
  const current = activity;
  activity = undefined;
  await current?.stop();
}

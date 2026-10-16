import { OxyServer } from '@oxy.so/core/server';

import { config } from '../../config';

/**
 * THIS service's own Oxy client: the one `OxyServer` that calls Oxy as
 * CrowdSource's Oxy application.
 *
 * With an `OXY_SERVICE_API_KEY`/`OXY_SERVICE_API_SECRET` pair it authenticates
 * with the pair; without one the SDK attests the task's IAM role (oxy ADR 0026),
 * which is what the deployment runs on — the same identity `ecosystemActivity.ts`
 * publishes with. One instance, so every caller shares one service token.
 *
 * Its callers are the account-event contract (`accountErasure/oxyAccountEvents.ts`)
 * and the evidence files (`evidence/oxyFiles.ts`). Verifying an Oxy SESSION is
 * `identity/oxySession.ts` and verifying another service's token is
 * `tenancy/oxyApplicationAuth.ts`; neither needs this identity.
 */

let server: OxyServer | null = null;

export function oxyServiceServer(): OxyServer {
  if (server) return server;
  const apiUrl = config.oxy.apiUrl;
  if (!apiUrl) {
    // Not a refusal of whatever asked: the request may be genuine, and every
    // caller answers this as "unavailable, retry" once the deployment is
    // configured.
    throw new Error('No Oxy API is configured; this service cannot call Oxy as itself.');
  }
  const apiKey = process.env.OXY_SERVICE_API_KEY?.trim();
  const apiSecret = process.env.OXY_SERVICE_API_SECRET?.trim();
  server = new OxyServer({
    baseURL: apiUrl,
    ...(apiKey && apiSecret ? { serviceAuth: { apiKey, apiSecret } } : {}),
  });
  return server;
}

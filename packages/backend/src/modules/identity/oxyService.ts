import { OxyServer } from '@oxy.so/core/server';

import { config } from '../../config';

/** Shared workload identity for outbound Oxy calls and live service verification. */

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
  server = new OxyServer({ baseURL: apiUrl });
  return server;
}

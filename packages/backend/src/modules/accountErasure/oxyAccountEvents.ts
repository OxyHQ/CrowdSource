import { OxyServices, type OxyAccountEvent, type OxyAccountEventFeedPage } from '@oxy.so/core';

import { config } from '../../config';

/**
 * THE ONE PLACE CrowdSource touches Oxy's account-event contract
 * (oxy `docs/identity/account-events.md`, OxyHQ/Mention#1178).
 *
 * Oxy signs an `account.deleted` Security Event Token for every relying
 * application when a person deletes their account, pushes it to
 * `POST /webhooks/oxy/account-events` and serves it from a pull feed. Both paths
 * come through here. Verification — the signature against Oxy's published key
 * set, `typ: secevent+jwt`, the issuer, and an audience equal to THIS service's
 * Oxy application — is `@oxy.so/core`'s `verifyAccountEvent`; this file only
 * builds the client and names the SDK's refusal.
 *
 * The client authenticates as this service. With an
 * `OXY_SERVICE_API_KEY`/`OXY_SERVICE_API_SECRET` pair it uses the pair; without
 * one the SDK attests the task's IAM role (oxy ADR 0026), which is what the
 * deployment runs on — the same identity `ecosystemActivity.ts` publishes with.
 * The audience a token must carry is the application that identity names.
 */

export type { OxyAccountEvent, OxyAccountEventFeedPage };

export interface AccountEventClient {
  verifyAccountEvent(token: string): Promise<OxyAccountEvent>;
  listAccountEvents(options: { after?: string; limit?: number }): Promise<OxyAccountEventFeedPage>;
}

let client: AccountEventClient | null = null;

function buildClient(): AccountEventClient {
  const apiUrl = config.oxy.apiUrl;
  if (!apiUrl) {
    // Not a refusal: the event may be genuine, and a 503 makes Oxy retry once
    // the deployment is configured.
    throw new Error('No Oxy API is configured; account events cannot be verified.');
  }
  const oxy = new OxyServices({ baseURL: apiUrl });
  const apiKey = process.env.OXY_SERVICE_API_KEY?.trim();
  const apiSecret = process.env.OXY_SERVICE_API_SECRET?.trim();
  if (apiKey && apiSecret) oxy.configureServiceAuth(apiKey, apiSecret);
  return oxy;
}

export function accountEventClient(): AccountEventClient {
  client ??= buildClient();
  return client;
}

/** Test seam: substitute the client, or `null` to rebuild from configuration. */
export function setAccountEventClientForTests(substitute: AccountEventClient | null): void {
  client = substitute;
}

/**
 * True for the SDK's refusal of a token: bad signature, unknown key, wrong
 * `typ`, another audience, a malformed payload. Matched by NAME rather than
 * `instanceof`, so a second copy of the SDK in the tree cannot turn a refusal
 * into a retry. A refusal is final; anything else (the key set could not be
 * fetched, no service identity) is worth a retry.
 */
export function isAccountEventRefusal(error: unknown): boolean {
  return error instanceof Error && error.name === 'OxyAccountEventError';
}

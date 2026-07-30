import { isIP } from 'node:net';

import { BLOCKED_HOSTNAMES, isBlockedIp } from '@oxyhq/core/server';
import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from '@oxyhq/crowdsource-contracts';
import type { ClientSession } from 'mongoose';

import type { TenantContext } from '../../db/tenantScope';
import { duplicateKeyViolation, withTransaction } from '../../db/transaction';
import { ApiError } from '../../http/apiError';
import { newPublicId } from '../../utils/identifiers';
import { quotaForApplication } from '../trust/applicationTrust.service';
import {
  decryptWebhookSecret,
  encryptWebhookSecret,
  generateWebhookSecret,
  WebhookSecretUnavailableError,
} from './secretCipher';
import {
  webhookEndpoints,
  webhookSecrets,
  type WebhookDisabledReason,
  type WebhookEndpointDocument,
  type WebhookSecretDocument,
} from './webhook.collections';

/**
 * Webhook endpoint registration and secret rotation (§10.2, §13.4).
 *
 * ## Why the OLDER secret is the one that signs during a rotation
 *
 * This is the part of the module most likely to be "fixed" by someone who reads
 * it as a bug, so it is written down here rather than left to be inferred.
 *
 * §10.8 pins the signature header to a single `v1=<hex>`. Stripe and GitHub can
 * cut over instantly because they send every live signature in one header and
 * the receiver accepts any of them; we cannot, because one header carries one
 * signature and that shape belongs to the published contract.
 *
 * With one signature per delivery, signing with the NEW secret at the instant of
 * rotation breaks every integrator who has not yet deployed it — which is the
 * whole failure rotation is supposed to avoid. So a rotation issues the new
 * secret immediately and lets the OLD one keep signing until the overlap ends.
 * The integrator installs the new secret alongside the old one during the
 * window — §10.8 tells receivers to allow exactly that — and at the boundary the
 * signature changes over with nothing to redeploy.
 *
 * `overlapSeconds: 0` is the leaked-secret path: the old secret expires at once
 * and the new one signs the next delivery.
 *
 * At most one rotation may be pending, because "exactly two valid secrets during
 * a window" is what a receiver is asked to implement; a third would quietly
 * break the promise the receiver was built against.
 */

/** §10.2's default window: long enough to deploy through a working day. */
export const DEFAULT_SECRET_OVERLAP_SECONDS = 24 * 60 * 60;
/** Beyond a week, a "rotation" is two secrets living together indefinitely. */
export const MAX_SECRET_OVERLAP_SECONDS = 7 * 24 * 60 * 60;

/** Matches the SSRF module's own cap, so a URL we accept is one it can fetch. */
const MAX_URL_LENGTH = 2048;

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(WEBHOOK_EVENT_TYPES);

/**
 * Validates a delivery target, offline (§7.2.7's reasoning, applied outbound).
 *
 * Everything here is decidable from the string, and that is deliberate: no DNS
 * is consulted, so registration cannot fail because a resolver was slow and the
 * test suite never touches the network. The check that actually stops SSRF is
 * `safeFetch` at delivery time, which resolves the host, refuses every private
 * or reserved answer, PINS the connection to the address it validated — closing
 * the rebinding window between check and connect — and re-validates every
 * redirect hop rather than only the first URL.
 *
 * https only, and that is a tightening the plan does not state. A webhook body
 * carries case ids, decision outcomes and policy versions; delivering those over
 * plaintext http would publish one tenant's moderation decisions to every
 * network between us and them.
 */
export function assertDeliverableUrl(rawUrl: string): void {
  if (rawUrl.length > MAX_URL_LENGTH) {
    throw new ApiError('invalid_request', `A webhook URL may not exceed ${MAX_URL_LENGTH} characters.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ApiError('invalid_request', 'The webhook url is not a valid absolute URL.');
  }

  if (parsed.protocol !== 'https:') {
    throw new ApiError(
      'invalid_request',
      'A webhook URL must use https: a decision delivered over plaintext is a decision published to every network in between.',
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    // Credentials in a URL end up in every log that ever prints it, including
    // ours. An endpoint that needs authentication verifies the signature.
    throw new ApiError('invalid_request', 'A webhook URL must not embed credentials.');
  }

  // `URL` keeps IPv6 literals bracketed; the IP denylist wants the address.
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  /**
   * `isBlockedIp` fails CLOSED — handed a hostname rather than an address it
   * answers "blocked" — so it is gated on `isIP`, exactly as ingress does. That
   * keeps this check to the question it can answer from the string alone.
   */
  if (BLOCKED_HOSTNAMES.has(host) || (isIP(host) !== 0 && isBlockedIp(host))) {
    throw new ApiError(
      'invalid_request',
      'A webhook URL must not point at a private, loopback or reserved address.',
    );
  }
}

/** Validates the subscription list against §10.6. */
export function assertKnownEventTypes(eventTypes: readonly string[]): WebhookEventType[] {
  if (eventTypes.length === 0) {
    throw new ApiError('invalid_request', 'A webhook endpoint must subscribe to at least one event type.');
  }

  const unknown = eventTypes.filter((type) => !EVENT_TYPE_SET.has(type));
  if (unknown.length > 0) {
    /**
     * A REGISTRATION naming an unknown event is refused, while a DELIVERY
     * carrying one must be ignored safely (§10.11). The asymmetry is the point:
     * a typo in a subscription is silence the integrator would never notice,
     * whereas a new event type arriving at an old receiver is normal.
     */
    throw new ApiError('invalid_request', `Unknown webhook event type: ${unknown.join(', ')}.`);
  }

  // Deduplicated and sorted: two registrations differing only in the order they
  // listed the same events are the same subscription.
  return [...new Set(eventTypes)].sort() as WebhookEventType[];
}

/** A secret, in the one moment it is legible. */
export interface IssuedWebhookSecret {
  readonly version: number;
  /** Shown once, at issue. Never re-served: §10.2 has no reveal endpoint. */
  readonly value: string;
  /** When this version starts signing. Now, unless it was issued by a rotation. */
  readonly signingStartsAt: Date;
}

export interface RegisteredWebhookEndpoint {
  readonly endpoint: WebhookEndpointDocument;
  /** Present only when the endpoint was created. A re-registration rotates nothing. */
  readonly secret: IssuedWebhookSecret | null;
  readonly created: boolean;
}

interface RegisterWebhookEndpointInput {
  readonly url: string;
  readonly eventTypes: readonly string[];
  readonly now?: Date;
}

/**
 * Registers an endpoint, or updates the one already registered for this URL.
 *
 * The endpoint and its first secret commit in ONE transaction. An endpoint
 * without a secret could never be delivered to and there is no route that would
 * give it one, so the two have to become visible together or not at all.
 *
 * Re-registering an existing URL is an UPDATE and mints no secret. §10.2 gives
 * registration no idempotency key, so a deploy script that POSTs on every boot
 * would otherwise both accumulate duplicate endpoints and invalidate the secret
 * the integrator is running with. It is also the only way back for an endpoint a
 * 410 disabled, since §10.2 has no re-enable route.
 */
export async function registerWebhookEndpoint(
  context: TenantContext,
  input: RegisterWebhookEndpointInput,
): Promise<RegisteredWebhookEndpoint> {
  assertDeliverableUrl(input.url);
  const eventTypes = assertKnownEventTypes(input.eventTypes);
  const now = input.now ?? new Date();

  const existing = await webhookEndpoints.findOne(context, { url: input.url });
  if (existing) {
    await webhookEndpoints.updateOne(
      context,
      { webhookEndpointId: existing.webhookEndpointId },
      {
        set: {
          eventTypes,
          status: 'active',
          disabledReason: null,
          disabledAt: null,
          updatedAt: now,
        },
      },
    );
    const refreshed = await requireEndpoint(context, existing.webhookEndpointId);
    return { endpoint: refreshed, secret: null, created: false };
  }

  /**
   * The endpoint quota (§15.10), checked only on the path that CREATES one.
   *
   * Re-registering an existing URL is exempt on purpose: an application already at
   * its limit must still be able to change the event types of an endpoint it has, or
   * revive one a 410 disabled, and refusing that would leave a tenant unable to fix
   * the very configuration that filled its quota.
   *
   * 429 rather than 403 because §10.5 gives that code to "rate limit o cuota", and
   * the fix is the same as any other quota: a promotion to a standing that allows
   * more. Counting active endpoints rather than all of them means a disabled one does
   * not permanently consume a slot.
   */
  const quota = await quotaForApplication(context);
  const active = await webhookEndpoints.countDocuments(context, { status: 'active' });
  if (active >= quota.webhookEndpoints) {
    throw new ApiError(
      'rate_limited',
      `This application may register ${quota.webhookEndpoints} webhook endpoints at its current standing.`,
      { activeEndpoints: active, limit: quota.webhookEndpoints },
    );
  }

  const webhookEndpointId = newPublicId('webhookEndpoint');
  const secretValue = generateWebhookSecret();
  // Before the transaction: an unconfigured encryption key is a 503 about
  // configuration, and opening a transaction to discover it would leave the
  // failure looking like a database problem.
  const encrypted = encryptWebhookSecret(secretValue);

  try {
    await withTransaction(async (session) => {
      await webhookEndpoints.insertOne(
        context,
        {
          webhookEndpointId,
          url: input.url,
          eventTypes,
          status: 'active',
          disabledReason: null,
          disabledAt: null,
          createdAt: now,
          updatedAt: now,
        },
        session,
      );

      await webhookSecrets.insertOne(
        context,
        {
          webhookEndpointId,
          version: 1,
          algorithm: encrypted.algorithm,
          keyFingerprint: encrypted.keyFingerprint,
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          activatesAt: now,
          expiresAt: null,
          createdAt: now,
          updatedAt: now,
        },
        session,
      );
    });
  } catch (error: unknown) {
    /**
     * Two registrations of the same URL raced. The unique index is the arbiter,
     * so the loser reads the winner's endpoint and reports it as an update —
     * which is what a retrying client asked for anyway.
     */
    if (duplicateKeyViolation(error)) {
      const winner = await webhookEndpoints.findOne(context, { url: input.url });
      if (winner) {
        return { endpoint: winner, secret: null, created: false };
      }
    }
    throw error;
  }

  return {
    endpoint: await requireEndpoint(context, webhookEndpointId),
    secret: { version: 1, value: secretValue, signingStartsAt: now },
    created: true,
  };
}

export interface RotatedWebhookSecret {
  readonly secret: IssuedWebhookSecret;
  /** The version being retired, and when it stops being valid. */
  readonly previous: { readonly version: number; readonly expiresAt: Date } | null;
}

interface RotateWebhookSecretInput {
  readonly overlapSeconds?: number;
  readonly now?: Date;
}

/** §10.2's `POST /v1/webhook-endpoints/{id}/rotate-secret`. */
export async function rotateWebhookSecret(
  context: TenantContext,
  webhookEndpointId: string,
  input: RotateWebhookSecretInput = {},
): Promise<RotatedWebhookSecret> {
  const overlapSeconds = input.overlapSeconds ?? DEFAULT_SECRET_OVERLAP_SECONDS;
  if (!Number.isInteger(overlapSeconds) || overlapSeconds < 0 || overlapSeconds > MAX_SECRET_OVERLAP_SECONDS) {
    throw new ApiError(
      'invalid_request',
      `overlapSeconds must be a whole number of seconds between 0 and ${MAX_SECRET_OVERLAP_SECONDS}.`,
    );
  }

  await requireEndpoint(context, webhookEndpointId);
  const now = input.now ?? new Date();
  const cutover = new Date(now.getTime() + overlapSeconds * 1_000);

  const live = await liveSecrets(context, webhookEndpointId, now);
  if (live.length === 0) {
    // Unreachable while registration writes both rows in one transaction. Left
    // as a refusal rather than an assumption: minting a fresh secret here would
    // silently re-key an endpoint whose secret rows had been lost, and the
    // integrator would learn about it from failing signatures.
    throw new ApiError(
      'conflict',
      'This endpoint has no live signing secret; it cannot be rotated.',
    );
  }
  if (live.some((secret) => secret.activatesAt.getTime() > now.getTime())) {
    throw new ApiError(
      'conflict',
      'A rotation is already scheduled for this endpoint. Receivers are asked to hold two secrets during a rotation, not three.',
    );
  }

  const current = live[0];
  const secretValue = generateWebhookSecret();
  const encrypted = encryptWebhookSecret(secretValue);
  const version = current.version + 1;

  try {
    await withTransaction(async (session) => {
      await webhookSecrets.insertOne(
        context,
        {
          webhookEndpointId,
          version,
          algorithm: encrypted.algorithm,
          keyFingerprint: encrypted.keyFingerprint,
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          activatesAt: cutover,
          expiresAt: null,
          createdAt: now,
          updatedAt: now,
        },
        session,
      );

      await webhookSecrets.updateOne(
        context,
        { webhookEndpointId, version: current.version },
        { set: { expiresAt: cutover, updatedAt: now } },
        session,
      );
    });
  } catch (error: unknown) {
    if (duplicateKeyViolation(error)) {
      // Two rotations raced for the same version number. One of them won and
      // the endpoint now has its two secrets; a second new secret would be a
      // third, which is the thing the pending-rotation check above refuses.
      throw new ApiError('conflict', 'A rotation for this endpoint is already in progress.');
    }
    throw error;
  }

  return {
    secret: { version, value: secretValue, signingStartsAt: cutover },
    previous: { version: current.version, expiresAt: cutover },
  };
}

/** Every secret that has not expired, newest version first. */
async function liveSecrets(
  context: TenantContext,
  webhookEndpointId: string,
  now: Date,
): Promise<WebhookSecretDocument[]> {
  return webhookSecrets.find(
    context,
    {
      webhookEndpointId,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    },
    { sort: { version: -1 } },
  );
}

/** A secret version resolved into the value that signs with it. */
export interface ResolvedWebhookSecret {
  readonly version: number;
  readonly value: string;
}

/**
 * The secret that signs a delivery made at `now`.
 *
 * "Activated, not yet expired, highest version." During an overlap that is the
 * OLDER of the two — see the note at the top of this file, which is the reason
 * and not an oversight.
 */
export async function signingSecretAt(
  context: TenantContext,
  webhookEndpointId: string,
  now: Date,
): Promise<ResolvedWebhookSecret> {
  const candidates = await liveSecrets(context, webhookEndpointId, now);
  const active = candidates.find((secret) => secret.activatesAt.getTime() <= now.getTime());
  if (!active) {
    throw new WebhookSecretUnavailableError(
      `Endpoint '${webhookEndpointId}' has no active signing secret.`,
    );
  }
  return { version: active.version, value: decryptWebhookSecret(active) };
}

/**
 * Every secret a receiver should currently accept — exactly two mid-rotation.
 *
 * Nothing in delivery calls this; it is what makes the overlap a property the
 * tests can state directly rather than infer from two signatures.
 */
export async function validSecretsAt(
  context: TenantContext,
  webhookEndpointId: string,
  now: Date,
): Promise<ResolvedWebhookSecret[]> {
  const candidates = await liveSecrets(context, webhookEndpointId, now);
  return candidates.map((secret) => ({
    version: secret.version,
    value: decryptWebhookSecret(secret),
  }));
}

/** The tenant's live endpoints that asked for this event type (§10.6). */
export async function endpointsSubscribedTo(
  context: TenantContext,
  eventType: string,
): Promise<WebhookEndpointDocument[]> {
  return webhookEndpoints.find(context, { status: 'active', eventTypes: eventType });
}

/**
 * Stops delivering to an endpoint (§10.9's 410 path).
 *
 * Conditional on the endpoint still being active, so two workers that both got a
 * 410 do not each stamp a different `disabledAt` — the second one is a no-op and
 * the record keeps the moment the first response arrived.
 */
export async function disableWebhookEndpoint(
  context: TenantContext,
  webhookEndpointId: string,
  reason: WebhookDisabledReason,
  now: Date,
  session?: ClientSession,
): Promise<boolean> {
  const changed = await webhookEndpoints.updateOne(
    context,
    { webhookEndpointId, status: 'active' },
    { set: { status: 'disabled', disabledReason: reason, disabledAt: now, updatedAt: now } },
    session,
  );
  return changed > 0;
}

/** Reads an endpoint of this tenant, or 404s. */
export async function requireEndpoint(
  context: TenantContext,
  webhookEndpointId: string,
): Promise<WebhookEndpointDocument> {
  const endpoint = await webhookEndpoints.findOne(context, { webhookEndpointId });
  if (!endpoint) {
    // A well-formed id belonging to another tenant and an id that never existed
    // get the same answer; the tenant filter is what decided, and saying which
    // one it was would confirm the existence of another tenant's endpoint.
    throw new ApiError('not_found', 'No such webhook endpoint.');
  }
  return endpoint;
}

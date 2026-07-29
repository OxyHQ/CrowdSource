import { Router } from 'express';
import { z } from 'zod';

import { ApiError } from '../../http/apiError';
import { isPublicId } from '../../utils/identifiers';
import { requestTenant, requireServiceCredential } from '../tenancy/serviceCredentialAuth';
import {
  registerWebhookEndpoint,
  rotateWebhookSecret,
  MAX_SECRET_OVERLAP_SECONDS,
  type RegisteredWebhookEndpoint,
} from './endpoint.service';
import { webhookSecretStorageConfigured } from './secretCipher';
import type { WebhookEndpointDocument } from './webhook.collections';

/**
 * The two webhook-management endpoints of §10.2.
 *
 * Exactly two, because §10.2 defines exactly two. There is no list, no read-back
 * and no delete — which is a real gap against the "near-zero configuration" goal,
 * since an integrator cannot see what it has registered, and it is flagged for a
 * decision rather than quietly filled in here. Re-registering a URL is the
 * documented way to change a subscription or revive a disabled endpoint.
 *
 * Both are `crowdsource:webhooks:manage`, and both derive their tenant from the
 * credential. There is no `applicationId` anywhere in a request or a response
 * body: an endpoint belongs to whichever application presented the key.
 */

const RegisterWebhookEndpointSchema = z.strictObject({
  url: z.string().min(1),
  eventTypes: z.array(z.string()).min(1),
});

const RotateSecretSchema = z.strictObject({
  /**
   * How long the outgoing secret keeps signing. Zero is an immediate cutover,
   * which is what a leaked secret needs; the default is a working day.
   */
  overlapSeconds: z.number().int().min(0).max(MAX_SECRET_OVERLAP_SECONDS).optional(),
});

/**
 * Refuses before acting when secrets cannot be stored.
 *
 * 503 and not 500: §10.5 gives 503 the meaning "temporary dependency, the
 * application retries", which is exactly right for a deployment missing
 * `WEBHOOK_SECRET_ENCRYPTION_KEY`. Refusing the operation is the point — an
 * endpoint that existed without a secret could never be delivered to, and the
 * failure would surface days later as silence rather than now as an error.
 */
function assertSecretStorageAvailable(): void {
  if (!webhookSecretStorageConfigured()) {
    throw new ApiError(
      'service_unavailable',
      'Webhook secret storage is unavailable: this deployment has no usable WEBHOOK_SECRET_ENCRYPTION_KEY.',
    );
  }
}

function endpointView(endpoint: WebhookEndpointDocument): Record<string, unknown> {
  return {
    webhookEndpointId: endpoint.webhookEndpointId,
    url: endpoint.url,
    eventTypes: endpoint.eventTypes,
    status: endpoint.status,
    disabledReason: endpoint.disabledReason,
    createdAt: endpoint.createdAt.toISOString(),
    updatedAt: endpoint.updatedAt.toISOString(),
  };
}

export const webhookEndpointsRouter: Router = Router();

webhookEndpointsRouter.post(
  '/webhook-endpoints',
  requireServiceCredential('crowdsource:webhooks:manage'),
  async (request, response) => {
    assertSecretStorageAvailable();

    const parsed = RegisterWebhookEndpointSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(
        'invalid_request',
        'A webhook endpoint registration needs a url and a non-empty eventTypes array.',
      );
    }

    const registered: RegisteredWebhookEndpoint = await registerWebhookEndpoint(
      requestTenant(request),
      { url: parsed.data.url, eventTypes: parsed.data.eventTypes },
    );

    /**
     * The secret appears in this response and nowhere else, ever. §13.4 makes a
     * service secret visible once; a webhook secret is decryptable by us because
     * we have to sign with it, but re-serving it would turn every credential
     * with `webhooks:manage` into a way to read the signing key of an endpoint
     * somebody else configured.
     *
     * 201 when the endpoint was created, 200 when an existing URL was updated —
     * and an update mints no secret, so a deploy script that re-registers on
     * every boot does not invalidate the secret it is running with.
     */
    response.status(registered.created ? 201 : 200).json({
      ...endpointView(registered.endpoint),
      ...(registered.secret
        ? {
            secret: {
              version: registered.secret.version,
              value: registered.secret.value,
              signingStartsAt: registered.secret.signingStartsAt.toISOString(),
            },
          }
        : {}),
    });
  },
);

webhookEndpointsRouter.post(
  '/webhook-endpoints/:webhookEndpointId/rotate-secret',
  requireServiceCredential('crowdsource:webhooks:manage'),
  async (request, response) => {
    assertSecretStorageAvailable();

    const webhookEndpointId = request.params.webhookEndpointId;
    // A malformed id and one belonging to another tenant get the same answer;
    // the tenant filter is what decides, and the shape check only saves a query.
    if (typeof webhookEndpointId !== 'string' || !isPublicId('webhookEndpoint', webhookEndpointId)) {
      throw new ApiError('not_found', 'No such webhook endpoint.');
    }

    const parsed = RotateSecretSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError(
        'invalid_request',
        `overlapSeconds must be a whole number of seconds between 0 and ${MAX_SECRET_OVERLAP_SECONDS}.`,
      );
    }

    const rotated = await rotateWebhookSecret(requestTenant(request), webhookEndpointId, {
      ...(parsed.data.overlapSeconds === undefined
        ? {}
        : { overlapSeconds: parsed.data.overlapSeconds }),
    });

    /**
     * `signingStartsAt` is the field that makes the overlap usable rather than
     * mysterious: it tells the integrator exactly when deliveries begin carrying
     * the new signature, so "install both, remove the old one after this
     * instant" is a procedure they can follow instead of a guess.
     */
    response.status(200).json({
      webhookEndpointId,
      secret: {
        version: rotated.secret.version,
        value: rotated.secret.value,
        signingStartsAt: rotated.secret.signingStartsAt.toISOString(),
      },
      previousSecret: rotated.previous
        ? {
            version: rotated.previous.version,
            expiresAt: rotated.previous.expiresAt.toISOString(),
          }
        : null,
    });
  },
);

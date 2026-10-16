import { createHash } from 'node:crypto';

import {
  verifyFileEventSignature,
  type FileEvent,
  type FileWebhookChallenge,
} from '@oxy.so/core/server';
import express, { Router, type Request, type Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

import { config } from '../../config';
import { logger } from '../../utils/logger';
import { acceptFileEvent } from './fileEvents.service';

/**
 * `POST /webhooks/oxy/file-events`: Oxy telling CrowdSource about a file its
 * evidence uses (oxy ADR 0043 D9) — deleted, trashed, restored, blocked,
 * unblocked, or its visibility changed.
 *
 * ## The signature is the authentication
 *
 * Oxy signs every event with the secret it returned when this endpoint was set
 * (`oxy-signature: t=…,v1=HMAC-SHA256(secret, "<t>.<raw body>")`), held in
 * `OXY_FILES_WEBHOOK_SECRET`. `verifyFileEventSignature` from `@oxy.so/core/server`
 * checks it against the RAW body within a five-minute window — which is why this
 * router mounts BEFORE the JSON parser, and outside `/v1`: neither a service
 * credential nor an Oxy session is a caller class of this route.
 *
 * ## Answers
 *
 * - 200 `{ challenge }`: Oxy's endpoint verification, sent unsigned when the
 *   endpoint is set (its secret does not exist until that call returns). Echoing
 *   it is the only thing done with it.
 * - 200 `{ received, duplicate }`: the event is recorded and applied
 *   (`fileEvents.service.ts`). A redelivery of a recorded event also gets 200,
 *   which is what stops Oxy retrying.
 * - 401: the signature or the body did not verify. Oxy retries, and a genuine
 *   event never gets here.
 * - 415: not JSON.
 * - 503: no `OXY_FILES_WEBHOOK_SECRET` yet, so a signed event cannot be checked.
 *   Not a 401: the event may be genuine, and Oxy retries it.
 * - 500: applying it failed. Oxy retries.
 *
 * ## Bounds
 *
 * A 64 KB body (an event is a few hundred bytes) and the per-address rate limit
 * of the account-events receiver, keyed on a digest of the address and held in
 * memory only.
 */

const MAX_BODY_BYTES = 64 * 1024;

function addressKey(request: Request): string {
  const address = ipKeyGenerator(request.ip ?? 'unknown');
  return createHash('sha256').update(address, 'utf8').digest('hex');
}

export async function handleFileEvent(request: Request, response: Response): Promise<void> {
  if (!request.is('application/json') || !Buffer.isBuffer(request.body)) {
    response.status(415).json({ error: 'Content-Type must be application/json' });
    return;
  }
  const secret = config.oxy.filesWebhookSecret ?? '';

  let verified: FileEvent | FileWebhookChallenge;
  try {
    verified = verifyFileEventSignature(request.body, request.headers, secret);
  } catch (_caught: unknown) {
    if (secret === '') {
      logger.error(
        { classification: 'file_event_unverifiable' },
        'A file event arrived but OXY_FILES_WEBHOOK_SECRET is unset',
      );
      response.status(503).json({ error: 'File events cannot be verified yet; retry.' });
      return;
    }
    logger.warn({ classification: 'file_event_refused' }, 'File event refused');
    response.status(401).json({ error: 'Invalid file event signature.' });
    return;
  }

  if (verified.type === 'webhook.challenge') {
    response.status(200).json({ challenge: verified.challenge });
    return;
  }

  try {
    const intake = await acceptFileEvent(verified);
    response.status(200).json({ received: true, duplicate: intake.duplicate });
  } catch (_caught: unknown) {
    logger.error(
      { eventId: verified.id, classification: 'file_event_apply_failed' },
      'File event could not be applied',
    );
    response.status(500).json({ error: 'The event could not be applied; retry.' });
  }
}

export function createOxyFileEventsRouter(): Router {
  const router = Router();
  router.post(
    '/oxy/file-events',
    rateLimit({
      windowMs: 60 * 1000,
      limit: 600,
      keyGenerator: addressKey,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: 'Too many requests.' },
    }),
    express.raw({ type: 'application/json', limit: MAX_BODY_BYTES }),
    handleFileEvent,
  );
  return router;
}

import { createHash } from 'node:crypto';

import express, { Router, type Request, type Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

import { logger } from '../../utils/logger';
import { acceptAccountEvent } from './accountErasure.service';
import { accountEventClient, isAccountEventRefusal, type OxyAccountEvent } from './oxyAccountEvents';

/**
 * `POST /webhooks/oxy/account-events`: Oxy telling CrowdSource a person deleted
 * their account (oxy `docs/identity/account-events.md`, OxyHQ/Mention#1178).
 *
 * ## The token is the authentication
 *
 * The body is a Security Event Token (`application/secevent+jwt`), a compact
 * JWS Oxy signs with its service-token key. Verifying it — signature against
 * Oxy's published key set, `typ`, issuer, and an audience equal to this
 * service's Oxy application — is what authenticates the request. Neither a
 * service credential nor an Oxy session is accepted in its place, and nothing
 * is erased on an unverified request. That is why this router mounts BEFORE the
 * JSON parser and outside `/v1`, where every route is behind one of those.
 *
 * ## Answers
 *
 * - 202: the event is durably recorded in `account_erasures`. A redelivery of a
 *   recorded event also gets 202, which is what stops Oxy retrying.
 * - 400: the body is not a compact JWS.
 * - 401: the token did not verify. Final: a genuine token never gets here.
 * - 415: wrong content type.
 * - 503: the token could not be CHECKED (Oxy's key set or this service's own
 *   Oxy identity unreachable). Not a 401: the event may be genuine, so Oxy
 *   must retry it.
 * - 500: recording failed. Oxy retries.
 *
 * ## Bounds
 *
 * A 16 KB body limit (a token is a few hundred bytes; the SDK refuses past
 * 16 KB) and a per-address rate limit far above Oxy's delivery rate — one
 * request per event, and a burst of deletions is a burst of events that must
 * all land. The limiter keys on a digest of the address and holds it in memory
 * only.
 */

export const ACCOUNT_EVENT_CONTENT_TYPE = 'application/secevent+jwt';
const MAX_TOKEN_BYTES = 16 * 1024;
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function addressKey(request: Request): string {
  const address = ipKeyGenerator(request.ip ?? 'unknown');
  return createHash('sha256').update(address, 'utf8').digest('hex');
}

export async function handleAccountEvent(request: Request, response: Response): Promise<void> {
  if (!request.is(ACCOUNT_EVENT_CONTENT_TYPE)) {
    response.status(415).json({ error: `Content-Type must be ${ACCOUNT_EVENT_CONTENT_TYPE}` });
    return;
  }
  const token = typeof request.body === 'string' ? request.body.trim() : '';
  if (!COMPACT_JWS.test(token)) {
    response.status(400).json({ error: 'The body must be a compact JWS security event token.' });
    return;
  }

  let event: OxyAccountEvent;
  try {
    event = await accountEventClient().verifyAccountEvent(token);
  } catch (caught: unknown) {
    if (isAccountEventRefusal(caught)) {
      logger.warn({ classification: 'account_event_refused' }, 'Account event token refused');
      response.status(401).json({ error: 'Invalid account event token.' });
      return;
    }
    logger.error({ classification: 'account_event_unverifiable' }, 'Account event token could not be verified');
    response.status(503).json({ error: 'The account event could not be verified; retry.' });
    return;
  }

  try {
    const intake = await acceptAccountEvent(event, 'webhook');
    response.status(202).json({ received: true, eventId: event.eventId, duplicate: !intake.inserted });
  } catch (_caught: unknown) {
    logger.error(
      { eventId: event.eventId, classification: 'account_event_record_failed' },
      'Account event could not be recorded',
    );
    response.status(500).json({ error: 'The event could not be recorded; retry.' });
  }
}

export function createAccountEventsRouter(): Router {
  const router = Router();
  router.post(
    '/oxy/account-events',
    rateLimit({
      windowMs: 60 * 1000,
      limit: 600,
      keyGenerator: addressKey,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: 'Too many requests.' },
    }),
    express.text({ type: ACCOUNT_EVENT_CONTENT_TYPE, limit: MAX_TOKEN_BYTES }),
    handleAccountEvent,
  );
  return router;
}

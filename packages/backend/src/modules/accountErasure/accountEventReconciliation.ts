import { randomUUID } from 'node:crypto';

import { getPostgresDatabase } from '../../db/postgres/database';
import {
  advanceAccountEventCursor,
  claimAccountEventFeed,
  findRetryableAccountErasures,
  releaseAccountEventFeed,
} from '../../db/postgres/repositories/accountErasure';
import { logger } from '../../utils/logger';
import { acceptAccountEvent, processAccountErasure } from './accountErasure.service';
import { accountEventClient, isAccountEventRefusal } from './oxyAccountEvents';

/**
 * THE SAFETY NET under the webhook: read Oxy's account-event feed on a timer,
 * and re-run any erasure that did not finish.
 *
 * Oxy's push is at-least-once, but CrowdSource can still miss one — a deploy
 * across the retry window, a bug in the route, Oxy dead-lettering after its
 * attempt limit, or no webhook registered yet. The pull feed
 * (`GET /account-events?after=`) holds every event addressed to this service for
 * 30 days, so reading it forward from a durable cursor catches what the push
 * lost. Overlap with the push is normal: both dedupe on the event id.
 *
 * ## One reader at a time, without a leader
 *
 * Every task runs this timer — the service has no leader election — so the
 * feed is read under a lease on its cursor row (`account_event_cursors`), and
 * the cursor only moves while this task still holds that lease. Erasures are
 * single-flight per row through their own lease.
 *
 * ## What moves the cursor
 *
 * Only a page whose every event was recorded. A failure to reach Oxy or to
 * record leaves the cursor where it was, and the next tick re-reads the page. A
 * token the feed serves that fails verification is REFUSED and skipped: it can
 * never verify on a retry, and would otherwise pin the cursor forever. A
 * failure that is not a refusal (the key set could not be fetched) stops the
 * tick without moving.
 *
 * ## Never infers
 *
 * Signed events only. It never asks Oxy whether an account exists, and a 404 is
 * not a deletion.
 */

export const ACCOUNT_EVENTS_FEED = 'oxy-account-events';
export const RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 30 * 1000;
/** Events per page (Oxy allows 1..200). */
export const RECONCILIATION_PAGE_SIZE = 100;
/** Pages per tick, so a backlog is read over several ticks. */
export const RECONCILIATION_MAX_PAGES = 20;
/** How long one tick may hold the feed. Longer than a tick can take. */
export const FEED_LEASE_MS = 4 * 60 * 1000;
/** Unfinished erasures retried per tick. */
export const RECONCILIATION_RETRY_LIMIT = 10;

export interface PullResult {
  pages: number;
  recorded: number;
  refused: number;
  cursorAdvanced: boolean;
  /** False when another task held the feed. */
  leased: boolean;
}

/** Read the feed forward from the stored cursor, recording every verified event. */
export async function pullAccountEvents(owner: string = randomUUID(), now: Date = new Date()): Promise<PullResult> {
  const db = getPostgresDatabase();
  const result: PullResult = { pages: 0, recorded: 0, refused: 0, cursorAdvanced: false, leased: false };
  const claimed = await claimAccountEventFeed(db, ACCOUNT_EVENTS_FEED, owner, now, FEED_LEASE_MS);
  if (!claimed) return result;
  result.leased = true;

  const client = accountEventClient();
  let cursor = claimed.cursor;
  try {
    for (let page = 0; page < RECONCILIATION_MAX_PAGES; page += 1) {
      const response = await client.listAccountEvents({
        ...(cursor ? { after: cursor } : {}),
        limit: RECONCILIATION_PAGE_SIZE,
      });
      result.pages += 1;

      for (const item of response.events) {
        let event;
        try {
          event = await client.verifyAccountEvent(item.token);
        } catch (caught: unknown) {
          if (!isAccountEventRefusal(caught)) throw caught;
          result.refused += 1;
          logger.error(
            { eventId: item.eventId, classification: 'account_event_refused' },
            'The account-event feed served a token that does not verify; skipped',
          );
          continue;
        }
        // The signed token is the authority, never the feed's plain fields.
        await acceptAccountEvent(event, 'reconciliation');
        result.recorded += 1;
      }

      const next = response.nextCursor;
      if (!next || next === cursor) break;
      if (!(await advanceAccountEventCursor(db, ACCOUNT_EVENTS_FEED, owner, next))) break;
      cursor = next;
      result.cursorAdvanced = true;
      if (response.events.length < RECONCILIATION_PAGE_SIZE) break;
    }
  } finally {
    await releaseAccountEventFeed(db, ACCOUNT_EVENTS_FEED, owner);
  }
  return result;
}

/** Re-run erasures that were recorded but never finished. */
export async function retryUnfinishedErasures(now: Date = new Date()): Promise<number> {
  const db = getPostgresDatabase();
  const eventIds = await findRetryableAccountErasures(db, now, RECONCILIATION_RETRY_LIMIT);
  let completed = 0;
  for (const eventId of eventIds) {
    if ((await processAccountErasure(eventId, now)) === 'completed') completed += 1;
  }
  return completed;
}

/** One pass: pull, then retry. Each half is isolated so one failure does not stop the other. */
export async function reconcileAccountEvents(): Promise<void> {
  try {
    const pulled = await pullAccountEvents();
    logger.info({ ...pulled }, 'Account-event feed read');
  } catch (_caught: unknown) {
    logger.warn({ classification: 'account_event_pull_failed' }, 'Account-event feed read failed; the cursor did not move');
  }
  try {
    const retried = await retryUnfinishedErasures();
    if (retried > 0) logger.info({ retried }, 'Unfinished account erasures completed');
  } catch (_caught: unknown) {
    logger.warn({ classification: 'account_erasure_retry_failed' }, 'Account erasure retry scan failed');
  }
}

let timer: NodeJS.Timeout | null = null;
let firstTick: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;

/** One single-flight pass per process. */
export async function reconcileOnce(): Promise<void> {
  if (inFlight) return await inFlight;
  const work = reconcileAccountEvents().finally(() => {
    inFlight = null;
  });
  inFlight = work;
  await work;
}

/**
 * Started by `server.ts`, never by `app.ts`: building the application starts no
 * timers. A first pass soon after boot, so a deploy does not wait a whole
 * interval to catch up on what arrived while no task was serving.
 */
export function startAccountEventReconciliation(intervalMs = RECONCILIATION_INTERVAL_MS): void {
  if (timer) return;
  timer = setInterval(() => {
    void reconcileOnce();
  }, intervalMs);
  timer.unref?.();
  firstTick = setTimeout(() => {
    void reconcileOnce();
  }, Math.min(FIRST_TICK_DELAY_MS, intervalMs));
  firstTick.unref?.();
}

export function stopAccountEventReconciliation(): void {
  if (timer) clearInterval(timer);
  if (firstTick) clearTimeout(firstTick);
  timer = null;
  firstTick = null;
}

import { randomBytes, randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OxyAccountEvent, OxyAccountEventFeedPage } from '@oxy.so/core';

/**
 * Receiving Oxy's `account.deleted` (`docs/architecture/account-erasure.md`):
 * the webhook's answers, the idempotency of push and pull together, and the
 * pull feed's cursor and lease. Oxy is replaced by a fake client at the one
 * seam the module has (`setAccountEventClientForTests`); the ledger, the cursor
 * and the erasure run against the suite's real PostgreSQL.
 */

const { createApp } = await import('../app');
const { getPostgresDatabase } = await import('../db/postgres/database');
const { accountErasures, accountEventCursors } = await import('../db/postgres/schema/accountErasure');
const { recordAccountErasure, findAccountErasure } = await import('../db/postgres/repositories/accountErasure');
const { setAccountEventClientForTests } = await import('../modules/accountErasure/oxyAccountEvents');
const { settleBackgroundErasures, processAccountErasure, acceptAccountEvent } = await import(
  '../modules/accountErasure/accountErasure.service'
);
const reconciliation = await import('../modules/accountErasure/accountEventReconciliation');
const { startDatabase } = await import('./support/tenants');

const app = createApp();
const db = getPostgresDatabase();

/** An Oxy-shaped account id that no other suite could have written anywhere. */
const oxyId = (): string => randomBytes(12).toString('hex');

function event(overrides: Partial<OxyAccountEvent> = {}): OxyAccountEvent {
  return {
    eventId: randomUUID(),
    type: 'account.deleted',
    userId: oxyId(),
    username: null,
    occurredAt: new Date().toISOString(),
    retained: false,
    applicationId: 'oxy-app-crowdsource',
    issuedAt: new Date().toISOString(),
    ...overrides,
  } as OxyAccountEvent;
}

function refusal(): Error {
  const error = new Error('refused');
  error.name = 'OxyAccountEventError';
  return error;
}

/** A fake Oxy: tokens map to events, to a refusal, or to an outage. */
class FakeOxy {
  readonly tokens = new Map<string, OxyAccountEvent | 'refuse' | 'outage'>();
  pages: (OxyAccountEventFeedPage | 'outage')[] = [];
  readonly listCalls: { after?: string; limit?: number }[] = [];
  onList: (() => Promise<void>) | null = null;

  token(value: OxyAccountEvent | 'refuse' | 'outage'): string {
    const token = `hdr.${randomUUID().replace(/-/g, '')}.sig`;
    this.tokens.set(token, value);
    return token;
  }

  async verifyAccountEvent(token: string): Promise<OxyAccountEvent> {
    const value = this.tokens.get(token);
    if (value === 'refuse' || value === undefined) throw refusal();
    if (value === 'outage') throw new Error('JWKS unreachable');
    return value;
  }

  async listAccountEvents(options: { after?: string; limit?: number }): Promise<OxyAccountEventFeedPage> {
    this.listCalls.push(options);
    if (this.onList) await this.onList();
    const page = this.pages.shift();
    if (page === undefined) return { events: [], nextCursor: options.after ?? null };
    if (page === 'outage') throw new Error('Oxy unreachable');
    return page;
  }
}

let oxy: FakeOxy;

function feedItem(fake: FakeOxy, value: OxyAccountEvent | 'refuse' | 'outage', id: string = randomUUID()) {
  const base = typeof value === 'object' ? value : event({ eventId: id });
  return {
    eventId: base.eventId,
    type: 'account.deleted' as const,
    userId: base.userId,
    username: null,
    occurredAt: base.occurredAt,
    retained: false,
    token: fake.token(value),
  };
}

async function cursor(): Promise<string | null | undefined> {
  const [row] = await db
    .select()
    .from(accountEventCursors)
    .where(eq(accountEventCursors.feed, reconciliation.ACCOUNT_EVENTS_FEED));
  return row?.cursor;
}

function deliver(token: string, contentType = 'application/secevent+jwt') {
  return request(app).post('/webhooks/oxy/account-events').set('Content-Type', contentType).send(token);
}

beforeAll(async () => {
  await startDatabase();
});

beforeEach(async () => {
  oxy = new FakeOxy();
  setAccountEventClientForTests(oxy);
  await db.delete(accountEventCursors).where(eq(accountEventCursors.feed, reconciliation.ACCOUNT_EVENTS_FEED));
});

afterEach(async () => {
  await settleBackgroundErasures();
});

afterAll(() => {
  setAccountEventClientForTests(null);
  reconciliation.stopAccountEventReconciliation();
});

describe('POST /webhooks/oxy/account-events', () => {
  it('records a verified event with 202, and answers a redelivery 202 without a second row', async () => {
    const deleted = event();
    const token = oxy.token(deleted);

    const first = await deliver(token);
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ received: true, eventId: deleted.eventId, duplicate: false });

    const again = await deliver(token);
    expect(again.status).toBe(202);
    expect(again.body.duplicate).toBe(true);

    await settleBackgroundErasures();
    const rows = await db.select().from(accountErasures).where(eq(accountErasures.eventId, deleted.eventId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'webhook', status: 'completed', oxyUserId: deleted.userId });
  });

  it('refuses a token that does not verify with 401, and erases nothing', async () => {
    const response = await deliver(oxy.token('refuse'));
    expect(response.status).toBe(401);
  });

  it('answers 503 when the token could not be CHECKED, so Oxy retries', async () => {
    const response = await deliver(oxy.token('outage'));
    expect(response.status).toBe(503);
  });

  it('answers 415 for another content type and 400 for a body that is not a compact JWS', async () => {
    expect((await deliver(oxy.token(event()), 'application/json')).status).toBe(415);
    expect((await deliver('not-a-token')).status).toBe(400);
    expect((await deliver('')).status).toBe(400);
  });

  it('answers 500 when the event cannot be recorded, so Oxy retries', async () => {
    const unrecordable = event({ userId: undefined as unknown as string });
    const response = await deliver(oxy.token(unrecordable));
    expect(response.status).toBe(500);
    expect(await findAccountErasure(db, unrecordable.eventId)).toBeNull();
  });

  it('refuses a body larger than any token', async () => {
    const response = await deliver(`a.${'b'.repeat(17 * 1024)}.c`);
    expect(response.status).toBe(413);
  });

  it('is not reachable under /v1 and needs no credential', async () => {
    expect((await request(app).post('/v1/webhooks/oxy/account-events').send('a.b.c')).status).not.toBe(202);
  });
});

describe('the pull feed', () => {
  it('records every verified event, skips a refused one, and moves the cursor past both', async () => {
    const recorded = event();
    oxy.pages = [
      { events: [feedItem(oxy, recorded), feedItem(oxy, 'refuse')], nextCursor: 'cursor-1' },
    ];

    const result = await reconciliation.pullAccountEvents();

    expect(result).toMatchObject({ leased: true, recorded: 1, refused: 1, cursorAdvanced: true, pages: 1 });
    expect(await cursor()).toBe('cursor-1');
    expect((await findAccountErasure(db, recorded.eventId))?.source).toBe('reconciliation');
  });

  it('reads forward from the stored cursor, page after page', async () => {
    const page = (next: string) => ({
      events: Array.from({ length: reconciliation.RECONCILIATION_PAGE_SIZE }, () => feedItem(oxy, event())),
      nextCursor: next,
    });
    oxy.pages = [page('c-1'), page('c-2'), { events: [], nextCursor: 'c-2' }];

    const result = await reconciliation.pullAccountEvents();

    expect(result.recorded).toBe(2 * reconciliation.RECONCILIATION_PAGE_SIZE);
    expect(oxy.listCalls.map((call) => call.after)).toEqual([undefined, 'c-1', 'c-2']);
    expect(await cursor()).toBe('c-2');
  });

  it('does not move the cursor past a page it could not verify, and throws for the tick to log', async () => {
    oxy.pages = [{ events: [feedItem(oxy, event()), feedItem(oxy, 'outage')], nextCursor: 'never' }];
    await expect(reconciliation.pullAccountEvents()).rejects.toThrow('JWKS unreachable');
    expect(await cursor()).toBeNull();

    // The lease was released, so the next tick re-reads the same page.
    oxy.pages = [{ events: [], nextCursor: 'after-retry' }];
    expect((await reconciliation.pullAccountEvents()).cursorAdvanced).toBe(true);
    expect(oxy.listCalls.at(-1)?.after).toBeUndefined();
  });

  it('records the same event once when the push and the pull both carry it', async () => {
    const deleted = event();
    expect((await deliver(oxy.token(deleted))).status).toBe(202);
    oxy.pages = [{ events: [feedItem(oxy, deleted)], nextCursor: 'both' }];

    await reconciliation.pullAccountEvents();
    await settleBackgroundErasures();

    const rows = await db.select().from(accountErasures).where(eq(accountErasures.eventId, deleted.eventId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'webhook', status: 'completed', attempts: 1 });
  });

  it('leaves the feed to the task that holds its lease', async () => {
    const now = new Date();
    oxy.pages = [{ events: [], nextCursor: 'held' }];
    const holder = await reconciliation.pullAccountEvents('holder', now);
    expect(holder.leased).toBe(true);

    // Held again, and not released, as a task that is still reading would.
    await db
      .update(accountEventCursors)
      .set({ leaseOwner: 'holder', leaseUntil: new Date(now.getTime() + 60_000) })
      .where(eq(accountEventCursors.feed, reconciliation.ACCOUNT_EVENTS_FEED));

    const other = await reconciliation.pullAccountEvents('other', now);
    expect(other).toMatchObject({ leased: false, pages: 0 });

    // A lapsed lease is taken over.
    const later = new Date(now.getTime() + 120_000);
    expect((await reconciliation.pullAccountEvents('other', later)).leased).toBe(true);
  });

  it('stops without moving the cursor once another task has taken the lease mid-read', async () => {
    oxy.onList = async () => {
      await db
        .update(accountEventCursors)
        .set({ leaseOwner: 'thief' })
        .where(eq(accountEventCursors.feed, reconciliation.ACCOUNT_EVENTS_FEED));
    };
    oxy.pages = [{ events: [], nextCursor: 'stolen' }];

    const result = await reconciliation.pullAccountEvents('reader');

    expect(result.cursorAdvanced).toBe(false);
    expect(await cursor()).toBeNull();
  });

  it('stops when the feed answers the cursor it was given', async () => {
    oxy.pages = [{ events: [], nextCursor: null }];
    const result = await reconciliation.pullAccountEvents();
    expect(result).toMatchObject({ pages: 1, cursorAdvanced: false });
  });
});

describe('retrying unfinished erasures', () => {
  it('runs a recorded erasure that never started, and one that failed', async () => {
    const pending = event();
    await recordAccountErasure(db, {
      eventId: pending.eventId,
      oxyUserId: pending.userId,
      source: 'webhook',
      occurredAt: null,
      retained: false,
    });
    const failing = event();
    await recordAccountErasure(db, {
      eventId: failing.eventId,
      oxyUserId: failing.userId,
      source: 'webhook',
      occurredAt: null,
      retained: false,
    });

    // A step that throws, in an isolated module graph so nothing else sees it.
    vi.resetModules();
    vi.doMock('../db/postgres/repositories/accountErasure', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../db/postgres/repositories/accountErasure')>()),
      listApplicationTenants: () => Promise.reject(new TypeError('a message that may quote data')),
    }));
    const isolated = await import('../modules/accountErasure/accountErasure.service');
    const isolatedDatabase = await import('../db/postgres/database');
    expect(await isolated.processAccountErasure(failing.eventId)).toBe('failed');
    await isolatedDatabase.closePostgresDatabase();
    vi.doUnmock('../db/postgres/repositories/accountErasure');
    vi.resetModules();

    const failed = await findAccountErasure(db, failing.eventId);
    expect(failed).toMatchObject({ status: 'failed', lastError: 'TypeError', leaseUntil: null, attempts: 1 });

    expect(await reconciliation.retryUnfinishedErasures()).toBeGreaterThanOrEqual(2);
    expect((await findAccountErasure(db, pending.eventId))?.status).toBe('completed');
    expect(await findAccountErasure(db, failing.eventId)).toMatchObject({ status: 'completed', attempts: 2 });

    // A completed erasure is never claimed again.
    expect(await processAccountErasure(pending.eventId)).toBe('skipped');
  });

  it('does not take an erasure another task is running', async () => {
    const running = event();
    await recordAccountErasure(db, {
      eventId: running.eventId,
      oxyUserId: running.userId,
      source: 'reconciliation',
      occurredAt: null,
      retained: false,
    });
    await db
      .update(accountErasures)
      .set({ status: 'running', leaseUntil: new Date(Date.now() + 60_000) })
      .where(eq(accountErasures.eventId, running.eventId));

    expect(await processAccountErasure(running.eventId)).toBe('skipped');
    expect(await processAccountErasure(running.eventId, new Date(Date.now() + 120_000))).toBe('completed');
  });

  it('records an event whose time Oxy did not state as unknown, rather than refusing it', async () => {
    const undated = event({ occurredAt: 'not a date' });
    const intake = await acceptAccountEvent(undated, 'reconciliation');
    expect(intake.inserted).toBe(true);
    expect((await findAccountErasure(db, undated.eventId))?.occurredAt).toBeNull();
  });
});

describe('the reconciliation tick', () => {
  it('survives an unreachable Oxy and still retries, one pass at a time', async () => {
    const pending = event();
    await recordAccountErasure(db, {
      eventId: pending.eventId,
      oxyUserId: pending.userId,
      source: 'webhook',
      occurredAt: null,
      retained: false,
    });
    oxy.pages = ['outage'];

    await Promise.all([reconciliation.reconcileOnce(), reconciliation.reconcileOnce()]);

    expect(oxy.listCalls).toHaveLength(1);
    expect((await findAccountErasure(db, pending.eventId))?.status).toBe('completed');
  });

  it('survives a database that refuses the retry scan', async () => {
    setAccountEventClientForTests({
      verifyAccountEvent: () => Promise.reject(new Error('unused')),
      listAccountEvents: () => Promise.resolve({ events: [], nextCursor: null }),
    });
    await expect(reconciliation.reconcileAccountEvents()).resolves.toBeUndefined();
  });

  it('starts once, ticks on its own, and stops', async () => {
    reconciliation.startAccountEventReconciliation(20);
    reconciliation.startAccountEventReconciliation(20);
    await new Promise((resolve) => setTimeout(resolve, 80));
    reconciliation.stopAccountEventReconciliation();
    reconciliation.stopAccountEventReconciliation();
    expect(oxy.listCalls.length).toBeGreaterThan(0);
  });
});

describe('the Oxy client', () => {
  it('is built once from configuration, with the key pair when the task carries one', async () => {
    vi.resetModules();
    vi.stubEnv('OXY_SERVICE_API_KEY', 'key');
    vi.stubEnv('OXY_SERVICE_API_SECRET', 'secret');
    const isolated = await import('../modules/accountErasure/oxyAccountEvents');
    const client = isolated.accountEventClient();
    expect(isolated.accountEventClient()).toBe(client);
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('refuses to exist without an Oxy API, which the webhook answers as 503', async () => {
    vi.resetModules();
    vi.stubEnv('OXY_API_URL', '');
    const isolated = await import('../modules/accountErasure/oxyAccountEvents');
    expect(() => isolated.accountEventClient()).toThrow('No Oxy API is configured');
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});

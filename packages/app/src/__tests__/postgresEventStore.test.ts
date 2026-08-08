/**
 * The Postgres event store, against a real Postgres.
 *
 * Four properties, each named with the change it catches. The first is the one
 * the whole webhook receiver rests on: a redelivery must not be handled twice,
 * and the answer to "did I take this claim" must never be confused with "the
 * database was unreachable".
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresEventStore } from '../postgres/store/events.js';
import { postgresTransactionRunner } from '../postgres/store/transaction.js';
import type { ModerationPgHandle } from '../postgres/store/transaction.js';
import type { ModerationEventStore, ModerationTransactionRunner } from '../store/types.js';
import {
  createPostgresTestDatabase,
  type PostgresTestDatabase,
} from './support/postgres/database.js';
import { moderation } from './support/postgres/schema.js';

const RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

let database: PostgresTestDatabase | null = null;
let store: ModerationEventStore<ModerationPgHandle> | null = null;
let transaction: ModerationTransactionRunner<ModerationPgHandle> | null = null;

beforeAll(async () => {
  database = await createPostgresTestDatabase();
  store = postgresEventStore({ db: database.db, tables: moderation });
  transaction = postgresTransactionRunner(database.db);
});

afterAll(async () => {
  await database?.close();
  database = null;
});

beforeEach(async () => {
  await handle().delete(moderation.events);
});

function handle(): ModerationPgHandle {
  if (database === null) throw new Error('the throwaway database was not created');
  return database.db;
}

function eventStore(): ModerationEventStore<ModerationPgHandle> {
  if (store === null) throw new Error('the store was not built');
  return store;
}

function runner(): ModerationTransactionRunner<ModerationPgHandle> {
  if (transaction === null) throw new Error('the runner was not built');
  return transaction;
}

function claimInput(eventId: string): { eventId: string; receivedAt: Date; expiresAt: Date } {
  const receivedAt = new Date('2026-08-01T10:00:00.000Z');
  return { eventId, receivedAt, expiresAt: new Date(receivedAt.getTime() + RETENTION_MS) };
}

async function readRow(eventId: string): Promise<Record<string, unknown> | undefined> {
  const rows = await handle()
    .select()
    .from(moderation.events)
    .where(eq(moderation.events.id, eventId));
  return rows[0];
}

describe('the claim', () => {
  it('is taken by exactly one of two concurrent callers', async () => {
    /**
     * Catches `rows.length === 1` collapsing to `true`, and catches dropping
     * `.returning()` — both of which make every caller believe it took the claim,
     * so two instances behind one load balancer each run the same decision.
     *
     * Genuinely concurrent, on two pooled connections, because that is the case
     * the receiver is deduplicating: a sequential pair would also pass against an
     * implementation that only worked when the row was already committed.
     */
    const input = claimInput('evt_concurrent');
    const [first, second] = await Promise.all([
      eventStore().claim(input),
      eventStore().claim(input),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    const row = await readRow('evt_concurrent');
    expect(row?.state).toBe('claimed');
  });

  it('answers false for a duplicate rather than throwing', async () => {
    /**
     * The structural difference from Mongo, asserted rather than described: a
     * duplicate is a row COUNT here, not an exception, so there is no catch block
     * whose predicate could be widened into swallowing a connection failure as
     * "already processed".
     */
    const input = claimInput('evt_twice');
    expect(await eventStore().claim(input)).toBe(true);
    await expect(eventStore().claim(input)).resolves.toBe(false);
  });

  it('can be taken again after it is released', async () => {
    /** Catches a `release` that deletes nothing — the sender's retry would then be
     * deduplicated against a claim nobody is holding, and a decision that failed
     * once could never be processed. */
    const input = claimInput('evt_released');
    expect(await eventStore().claim(input)).toBe(true);

    await eventStore().release(input.eventId);
    expect(await readRow(input.eventId)).toBeUndefined();

    expect(await eventStore().claim(input)).toBe(true);
  });
});

describe('recording what arrived', () => {
  it('rolls markQueued back with the transaction that carried it', async () => {
    /**
     * Catches `db` used where `tx` belongs. The row would then complete to
     * `queued` on its own connection while the outbox row that carries the work
     * rolled back — an event permanently deduplicated with no work queued, which
     * is a decision lost with a row saying it arrived.
     */
    const input = claimInput('evt_rolled_back');
    expect(await eventStore().claim(input)).toBe(true);

    await expect(
      runner().run(async (tx) => {
        await eventStore().markQueued(
          {
            eventId: input.eventId,
            type: 'decision.published',
            caseId: 'case_1',
            payload: { caseId: 'case_1', decision: { id: 'dec_1' } },
            now: new Date('2026-08-01T10:00:01.000Z'),
          },
          tx,
        );
        throw new Error('the outbox write failed');
      }),
    ).rejects.toThrow('the outbox write failed');

    const row = await readRow(input.eventId);
    expect(row?.state).toBe('claimed');
    expect(row?.queuedAt).toBeNull();
    expect(row?.payload).toBeNull();
  });

  it('commits markQueued with the audit fields it was given', async () => {
    const input = claimInput('evt_queued');
    expect(await eventStore().claim(input)).toBe(true);

    const queuedAt = new Date('2026-08-01T10:00:02.000Z');
    await runner().run(async (tx) => {
      await eventStore().markQueued(
        {
          eventId: input.eventId,
          type: 'decision.published',
          caseId: 'case_2',
          payload: { caseId: 'case_2', decision: { id: 'dec_2' } },
          now: queuedAt,
        },
        tx,
      );
    });

    const row = await readRow(input.eventId);
    expect(row?.state).toBe('queued');
    expect(row?.type).toBe('decision.published');
    expect(row?.caseId).toBe('case_2');
    expect(row?.queuedAt).toEqual(queuedAt);
    expect(row?.payload).toEqual({ caseId: 'case_2', decision: { id: 'dec_2' } });
  });

  it('leaves case_id NULL for an ignored event that carries no case', async () => {
    /**
     * Catches `caseId: String(caseId)` — or any spelling that writes an absent
     * value rather than omitting it. `'undefined'` in that column reads as a case
     * id to everything downstream, and `moderation_events_case_id_idx` would
     * happily index it.
     */
    const input = claimInput('evt_ignored');
    expect(await eventStore().claim(input)).toBe(true);

    await eventStore().markIgnored({
      eventId: input.eventId,
      type: 'case.created',
      now: new Date('2026-08-01T10:00:03.000Z'),
    });

    const row = await readRow(input.eventId);
    expect(row?.state).toBe('ignored');
    expect(row?.type).toBe('case.created');
    expect(row?.caseId).toBeNull();
  });

  it('records the case id for an ignored event that has one', async () => {
    const input = claimInput('evt_ignored_with_case');
    expect(await eventStore().claim(input)).toBe(true);

    await eventStore().markIgnored({
      eventId: input.eventId,
      type: 'case.closed',
      caseId: 'case_3',
      now: new Date('2026-08-01T10:00:04.000Z'),
    });

    const row = await readRow(input.eventId);
    expect(row?.caseId).toBe('case_3');
  });
});

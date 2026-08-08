/**
 * The Postgres outbox store, against a real Postgres.
 *
 * Every assertion here names the change it would catch, and none is written that
 * cannot name one. The store is addressed DIRECTLY rather than through the
 * pipeline: the backend-neutral harness gets its Postgres implementation later,
 * and the four guarantees this store carries are worth pinning before anything is
 * built on top of them.
 *
 * Three of the properties have a BLOCK as their natural failure mode, so the pool
 * carries a two-second `statement_timeout` and the tests assert TIMING as well as
 * outcome. "Answered null promptly" and "was cancelled after two seconds" are
 * different results, and a test that cannot tell them apart passes either way.
 */

import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeRows } from '@oxyhq/db';
import { ModerationOutboxTransactionError } from '../outbox/service.js';
import { postgresOutboxStore } from '../postgres/store/outbox.js';
import { postgresTransactionRunner } from '../postgres/store/transaction.js';
import type { ModerationOutboxStore, ModerationTransactionRunner } from '../store/types.js';
import type { ModerationPgHandle } from '../postgres/store/transaction.js';
import {
  createPostgresTestDatabase,
  STATEMENT_TIMEOUT_MS,
  type PostgresTestDatabase,
} from './support/postgres/database.js';
import { moderation } from './support/postgres/schema.js';

const OWNER = 'moderation:test-owner';
const OTHER_OWNER = 'moderation:another-task';
const RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

let database: PostgresTestDatabase | null = null;
let store: ModerationOutboxStore<ModerationPgHandle> | null = null;
let transaction: ModerationTransactionRunner<ModerationPgHandle> | null = null;

beforeAll(async () => {
  database = await createPostgresTestDatabase();
  store = postgresOutboxStore({ db: database.db, tables: moderation });
  transaction = postgresTransactionRunner(database.db);
});

afterAll(async () => {
  await database?.close();
  database = null;
});

beforeEach(async () => {
  await handle().delete(moderation.outbox);
});

function handle(): ModerationPgHandle {
  if (database === null) throw new Error('the throwaway database was not created');
  return database.db;
}

/**
 * The CONCRETE handle, for raw `sql` only.
 *
 * `ModerationPgHandle` is the base `PgDatabase`, and it is deliberately NOT a
 * `SqlExecutor`: its `execute` returns an unresolved `PgQueryResultHKT`, so the
 * row type is not an array and `executeRows` refuses it (`TS2345`). The concrete
 * `PostgresJsDatabase` resolves that HKT to a row list and satisfies the
 * interface. Worth knowing before a store reaches for a raw-SQL escape hatch: it
 * would have to take a second, concrete handle to get one, and the stores take
 * the base type precisely so a `tx` can be passed where a pool handle can.
 */
function concreteHandle(): PostgresTestDatabase['db'] {
  if (database === null) throw new Error('the throwaway database was not created');
  return database.db;
}

function outboxStore(): ModerationOutboxStore<ModerationPgHandle> {
  if (store === null) throw new Error('the store was not built');
  return store;
}

function runner(): ModerationTransactionRunner<ModerationPgHandle> {
  if (transaction === null) throw new Error('the runner was not built');
  return transaction;
}

/** Enqueue through the store, in a real transaction, exactly as the service does. */
async function enqueue(input: {
  eventId: string;
  now: Date;
  reportId?: string;
}): Promise<void> {
  await runner().run(async (tx) => {
    await outboxStore().enqueue(
      {
        eventId: input.eventId,
        kind: 'report.submit',
        payload: { reportId: input.reportId ?? 'report-1' },
        availableAt: input.now,
        expiresAt: new Date(input.now.getTime() + RETENTION_MS),
        now: input.now,
      },
      tx,
    );
  });
}

async function readRow(eventId: string): Promise<Record<string, unknown> | undefined> {
  const rows = await handle()
    .select()
    .from(moderation.outbox)
    .where(eq(moderation.outbox.id, eventId));
  return rows[0];
}

async function countRows(): Promise<number> {
  const rows = await handle()
    .select({ total: sql<number>`count(*)::int` })
    .from(moderation.outbox);
  return rows[0]?.total ?? 0;
}

describe('the enqueue', () => {
  it('applies the statement timeout its own assertions depend on', async () => {
    /**
     * First, because two tests below distinguish "answered promptly" from "was
     * cancelled" and both readings are meaningless if the bound never reached the
     * session. A pool option that silently did not apply would make those two
     * tests pass for the wrong reason.
     */
    /**
     * Read from `pg_settings`, not `current_setting()`: the latter answers in
     * whatever unit Postgres finds tidy — it normalises 2000ms to the string
     * `'2s'` — so an assertion against a spelling breaks the moment the constant
     * changes. `pg_settings.setting` is the value in the parameter's own base
     * unit, milliseconds, which is what the constant is in.
     *
     * `executeRows` rather than `db.execute`: the base handle's `execute` is not
     * generic, and its row type is `unknown`. The row shape must be a `type`
     * alias — a named `interface` does not satisfy the implicit index signature
     * `executeRows` requires.
     */
    const rows = await executeRows<{ setting: string }>(
      concreteHandle(),
      sql`select setting from pg_settings where name = 'statement_timeout'`,
    );
    expect(Number(rows[0]?.setting)).toBe(STATEMENT_TIMEOUT_MS);
  });

  it('leaves an existing row byte-identical on a repeat', async () => {
    /**
     * Catches `onConflictDoNothing` becoming `onConflictDoUpdate`. The property is
     * stronger than "no duplicate row": a repeat must not WRITE, because the
     * dispatcher is concurrently taking and renewing leases on these same rows and
     * a write there conflicts with a live lease.
     *
     * The second enqueue carries a LATER clock and a different payload, so a
     * `DO UPDATE` would be visible in `updated_at` and in `payload` — a fixture
     * that repeated the same values could not tell the two implementations apart.
     */
    const eventId = 'moderation:report.submit:repeat-is-a-no-op';
    await enqueue({ eventId, now: new Date('2026-08-01T10:00:00.000Z') });
    const first = await readRow(eventId);

    await enqueue({
      eventId,
      now: new Date('2026-08-02T11:00:00.000Z'),
      reportId: 'a-different-report',
    });
    const second = await readRow(eventId);

    expect(second).toEqual(first);
    expect(await countRows()).toBe(1);
  });

  it('refuses the pool handle where a transaction belongs, and writes nothing', async () => {
    /**
     * Catches deleting the `instanceof PgTransaction` guard. Both handles are a
     * `ModerationPgHandle`, so this call type-checks perfectly — and without the
     * guard the row commits on its own pooled connection, independently of the
     * domain write it was supposed to be atomic with.
     */
    await expect(
      outboxStore().enqueue(
        {
          eventId: 'moderation:report.submit:no-transaction',
          kind: 'report.submit',
          payload: { reportId: 'no-transaction' },
          availableAt: new Date(),
          expiresAt: new Date(Date.now() + RETENTION_MS),
          now: new Date(),
        },
        handle(),
      ),
    ).rejects.toBeInstanceOf(ModerationOutboxTransactionError);

    expect(await countRows()).toBe(0);
  });

  it('rolls the row back when the enclosing transaction throws', async () => {
    /**
     * Catches a store call given `db` instead of `tx` inside the callback — which
     * commits on a different connection, so the row would SURVIVE this rollback.
     * That is the whole atomicity guarantee, and it fails silently.
     */
    await expect(
      runner().run(async (tx) => {
        await outboxStore().enqueue(
          {
            eventId: 'moderation:report.submit:rolled-back',
            kind: 'report.submit',
            payload: { reportId: 'rolled-back' },
            availableAt: new Date(),
            expiresAt: new Date(Date.now() + RETENTION_MS),
            now: new Date(),
          },
          tx,
        );
        throw new Error('the domain write failed');
      }),
    ).rejects.toThrow('the domain write failed');

    expect(await countRows()).toBe(0);
  });
});

describe('the claim', () => {
  it('takes the oldest due event first', async () => {
    /**
     * Catches dropping `orderBy(asc(createdAt))`: a backlog then drains in
     * whatever order the storage engine finds convenient, and the oldest report
     * waits longest.
     *
     * The rows are INSERTED newest-first, so their physical order is the opposite
     * of their chronological one. That is the whole fixture: with them inserted
     * oldest-first this test passed with the ORDER BY deleted — measured — because
     * a sequential scan happened to return them in the order it wanted. A test
     * about ordering has to make the two orders disagree.
     */
    await enqueue({ eventId: 'newer', now: new Date('2026-08-01T10:00:01.000Z') });
    await enqueue({ eventId: 'older', now: new Date('2026-08-01T10:00:00.000Z') });

    const now = new Date('2026-08-01T12:00:00.000Z');
    const first = await outboxStore().claim({
      leaseOwner: OWNER,
      leaseUntil: new Date(now.getTime() + 60_000),
      now,
    });
    const second = await outboxStore().claim({
      leaseOwner: OWNER,
      leaseUntil: new Date(now.getTime() + 60_000),
      now,
    });

    expect([first?.id, second?.id]).toEqual(['older', 'newer']);
    // The claim is what counts an attempt, so the retry ceiling can be reached.
    expect(first?.attempts).toBe(1);
  });

  it('skips a row another connection holds, promptly rather than by timing out', async () => {
    /**
     * Catches dropping `skipLocked: true`. Without it, under READ COMMITTED the
     * sub-select is evaluated once, the loser BLOCKS on the head row and then
     * returns zero rows — so a deployment of N tasks drains at 1/N the rate with
     * nothing failing. Here, without it, the update would block on the held row
     * until the statement timeout and reject with `57014` instead of answering.
     *
     * Both halves of the assertion matter: `null` alone is what a cancelled
     * statement would never produce, and the elapsed bound is what stops a
     * two-second block from reading as a pass if the rejection were ever
     * swallowed.
     */
    const eventId = 'moderation:report.submit:locked';
    await enqueue({ eventId, now: new Date('2026-08-01T10:00:00.000Z') });

    const holder = postgres(database?.url ?? '', { max: 1 });
    class Rollback extends Error {}
    try {
      await holder
        .begin(async (tx) => {
          await tx`select id from moderation_outbox where id = ${eventId} for update`;

          const now = new Date('2026-08-01T12:00:00.000Z');
          const started = Date.now();
          const claimed = await outboxStore().claim({
            leaseOwner: OWNER,
            leaseUntil: new Date(now.getTime() + 60_000),
            now,
          });
          const elapsed = Date.now() - started;

          expect(claimed).toBeNull();
          expect(elapsed).toBeLessThan(STATEMENT_TIMEOUT_MS);
          throw new Rollback('release the lock');
        })
        .catch((error: unknown) => {
          if (!(error instanceof Rollback)) throw error;
        });
    } finally {
      await holder.end();
    }

    // And the row is still due afterwards: the lock skipped it, nothing consumed it.
    const now = new Date('2026-08-01T12:00:01.000Z');
    const afterRelease = await outboxStore().claim({
      leaseOwner: OWNER,
      leaseUntil: new Date(now.getTime() + 60_000),
      now,
    });
    expect(afterRelease?.id).toBe(eventId);
  });

  it('reclaims a processing row whose lease has expired', async () => {
    /**
     * Catches dropping the second arm of the due-or-expired predicate. A worker
     * that died mid-delivery would then strand its event forever, and the report
     * it was delivering is never sent — with the row sitting in `processing`,
     * which reads as work in progress.
     */
    const eventId = 'moderation:report.submit:expired-lease';
    await enqueue({ eventId, now: new Date('2026-08-01T10:00:00.000Z') });

    const firstClaim = new Date('2026-08-01T10:00:05.000Z');
    expect(
      (
        await outboxStore().claim({
          leaseOwner: OTHER_OWNER,
          leaseUntil: new Date(firstClaim.getTime() + 30_000),
          now: firstClaim,
        })
      )?.id,
    ).toBe(eventId);

    // Well past that lease.
    const later = new Date('2026-08-01T10:05:00.000Z');
    const reclaimed = await outboxStore().claim({
      leaseOwner: OWNER,
      leaseUntil: new Date(later.getTime() + 30_000),
      now: later,
    });

    expect(reclaimed?.id).toBe(eventId);
    expect(reclaimed?.leaseOwner).toBe(OWNER);
    // Two claims, two attempts — the ceiling counts reclaims too.
    expect(reclaimed?.attempts).toBe(2);
  });

  it('answers null when nothing is due, and for an event that does not exist', async () => {
    const now = new Date('2026-08-01T12:00:00.000Z');
    expect(
      await outboxStore().claim({
        leaseOwner: OWNER,
        leaseUntil: new Date(now.getTime() + 60_000),
        now,
      }),
    ).toBeNull();
    expect(await outboxStore().statusOf('never-written')).toBeNull();
  });
});

describe('the lease transitions', () => {
  const claimedAt = new Date('2026-08-01T12:00:00.000Z');
  const eventId = 'moderation:report.submit:leased';

  beforeEach(async () => {
    await enqueue({ eventId, now: new Date('2026-08-01T10:00:00.000Z') });
    await outboxStore().claim({
      leaseOwner: OWNER,
      leaseUntil: new Date(claimedAt.getTime() + 60_000),
      now: claimedAt,
    });
  });

  it('completes only for the owner that holds the lease', async () => {
    /** Catches dropping `leaseOwner` from `complete`'s WHERE: a task that lost its
     * lease would then retire an event another task is mid-delivery on. */
    expect(
      await outboxStore().complete({ eventId, leaseOwner: OTHER_OWNER, now: claimedAt }),
    ).toBe(false);
    expect(await outboxStore().statusOf(eventId)).toBe('processing');

    expect(await outboxStore().complete({ eventId, leaseOwner: OWNER, now: claimedAt })).toBe(
      true,
    );
    expect(await outboxStore().statusOf(eventId)).toBe('processed');
    const row = await readRow(eventId);
    expect(row?.leaseOwner).toBeNull();
    expect(row?.leaseUntil).toBeNull();
  });

  it('renews only for the owner, and only while the lease is still live', async () => {
    /**
     * Two mutations: dropping `leaseOwner` (a stranger extends somebody else's
     * lease) and dropping `gt(leaseUntil, now)` (an EXPIRED lease is revived,
     * after another task may already have reclaimed the event — two workers then
     * believe they own one delivery).
     */
    const extended = new Date(claimedAt.getTime() + 120_000);
    expect(
      await outboxStore().renew({
        eventId,
        leaseOwner: OTHER_OWNER,
        leaseUntil: extended,
        now: claimedAt,
      }),
    ).toBe(false);

    const afterExpiry = new Date(claimedAt.getTime() + 90_000);
    expect(
      await outboxStore().renew({
        eventId,
        leaseOwner: OWNER,
        leaseUntil: new Date(afterExpiry.getTime() + 60_000),
        now: afterExpiry,
      }),
    ).toBe(false);

    expect(
      await outboxStore().renew({
        eventId,
        leaseOwner: OWNER,
        leaseUntil: extended,
        now: claimedAt,
      }),
    ).toBe(true);
    expect((await readRow(eventId))?.leaseUntil).toEqual(extended);
  });

  it('fails only for the owner, and writes the transition it was given', async () => {
    /** Catches dropping `leaseOwner` from `fail`'s WHERE, and proves the store
     * applies the status and backoff the SERVICE computed rather than deciding
     * either itself. */
    const availableAt = new Date(claimedAt.getTime() + 4_000);
    expect(
      await outboxStore().fail({
        eventId,
        leaseOwner: OTHER_OWNER,
        status: 'pending',
        availableAt,
        lastError: 'a stranger should not release this',
        now: claimedAt,
      }),
    ).toBe(false);
    expect((await readRow(eventId))?.lastError).toBeNull();

    expect(
      await outboxStore().fail({
        eventId,
        leaseOwner: OWNER,
        status: 'dead_letter',
        availableAt: claimedAt,
        lastError: 'the payload cannot be accepted',
        now: claimedAt,
      }),
    ).toBe(true);

    const row = await readRow(eventId);
    expect(row?.status).toBe('dead_letter');
    expect(row?.availableAt).toEqual(claimedAt);
    expect(row?.lastError).toBe('the payload cannot be accepted');
    expect(row?.leaseOwner).toBeNull();
  });
});

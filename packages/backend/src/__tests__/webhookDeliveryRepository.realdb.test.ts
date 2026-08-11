import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isUniqueViolation } from '@oxyhq/db';

import * as deliveryRepository from '../db/postgres/repositories/webhookDeliveries';
import { webhookDeliveries } from '../db/postgres/schema/webhooks';
import { createPostgresTestDatabase, type PostgresTestDatabase } from './support/postgresTestDatabase';

/**
 * The webhook delivery queue, against a real PostgreSQL server.
 *
 * More of this file is load-bearing than for the other ported tables, because two
 * of its statements have NO mocked counterpart: `FOR UPDATE SKIP LOCKED` and
 * `ON CONFLICT … DO NOTHING RETURNING` are behaviours of the server, and a mock
 * agrees with whatever you assert about them.
 *
 * Every instant is written RELATIVE to a `now` captured per test.
 */

let database: PostgresTestDatabase;

beforeAll(async () => {
  database = await createPostgresTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.asMigrator`TRUNCATE webhook_deliveries`;
});

const ORGANIZATION_ID = 'org_delivery_repo_fixture';
const APPLICATION_ID = 'app_delivery_repo_fixture';
const ENDPOINT_ID = 'whe_delivery_repo_fixture';

const MINUTE = 60 * 1000;
const offset = (ms: number) => new Date(Date.now() + ms);

function deliveryRow(
  overrides: Partial<typeof webhookDeliveries.$inferInsert> & { readonly deliveryId: string },
): typeof webhookDeliveries.$inferInsert {
  return {
    organizationId: ORGANIZATION_ID,
    applicationId: APPLICATION_ID,
    webhookEndpointId: ENDPOINT_ID,
    eventId: `evt_${overrides.deliveryId}`,
    eventType: 'decision.published',
    body: '{}',
    status: 'pending',
    attemptCount: 0,
    cycleAttemptCount: 0,
    nextAttemptAt: new Date(),
    leaseExpiresAt: null,
    lastResponseStatus: null,
    deadLetterReason: null,
    succeededAt: null,
    deadLetteredAt: null,
    replayCount: 0,
    ...overrides,
  };
}

/** Seeds directly, so a repository write is never its own fixture. */
async function seed(rows: readonly (typeof webhookDeliveries.$inferInsert)[]): Promise<void> {
  await database.db.insert(webhookDeliveries).values([...rows]);
}

describe('recording a delivery once per (endpoint, event)', () => {
  it('inserts the first and reports the second as already present', async () => {
    const first = await deliveryRepository.insertDeliveryIfAbsent(
      database.db,
      deliveryRow({ deliveryId: 'dlv_first', eventId: 'evt_shared' }),
    );
    expect(first).toBe(true);

    /**
     * A DIFFERENT `delivery_id`, so the primary key cannot be what refuses it —
     * this is the redelivered-outbox-row case, which produces the same
     * `(endpoint, event)` pair with a fresh delivery id.
     */
    const second = await deliveryRepository.insertDeliveryIfAbsent(
      database.db,
      deliveryRow({ deliveryId: 'dlv_second', eventId: 'evt_shared' }),
    );
    expect(second, 'the same event was delivered to the same endpoint twice').toBe(false);

    const stored = await database.db.select().from(webhookDeliveries);
    expect(stored.map((r) => r.deliveryId)).toEqual(['dlv_first']);
  });

  /**
   * NEGATIVE ATTRIBUTION: the conflict target is the PAIR, not `event_id`.
   *
   * One event fans out to every subscribed endpoint, so the SAME event id must be
   * accepted for a different endpoint. Without this, a conflict target narrowed to
   * `event_id` alone would pass every other assertion in this describe block while
   * silently delivering each event to exactly one endpoint.
   */
  it('ACCEPTS the same event for a DIFFERENT endpoint', async () => {
    await deliveryRepository.insertDeliveryIfAbsent(
      database.db,
      deliveryRow({ deliveryId: 'dlv_ep_a', eventId: 'evt_fanout', webhookEndpointId: 'whe_a' }),
    );

    const other = await deliveryRepository.insertDeliveryIfAbsent(
      database.db,
      deliveryRow({ deliveryId: 'dlv_ep_b', eventId: 'evt_fanout', webhookEndpointId: 'whe_b' }),
    );

    expect(other, 'fan-out to a second endpoint was refused').toBe(true);
  });

  /**
   * The empty result is the answer, and NO statement fails.
   *
   * The Mongo site catches `11000` and returns false. That does not port: one
   * failed statement aborts the whole transaction in PostgreSQL (`25P02`), so a
   * caught duplicate inside the fan-out transaction would doom every write around
   * it. Asserted by doing it INSIDE a transaction and then writing again — which
   * is impossible if the conflict aborted it.
   */
  it('leaves the surrounding transaction usable after a conflict', async () => {
    await seed([deliveryRow({ deliveryId: 'dlv_existing', eventId: 'evt_dup' })]);

    await database.db.transaction(async (tx) => {
      const inserted = await deliveryRepository.insertDeliveryIfAbsent(
        tx,
        deliveryRow({ deliveryId: 'dlv_conflicting', eventId: 'evt_dup' }),
      );
      expect(inserted).toBe(false);

      // If the conflict had aborted the transaction, this would raise 25P02.
      await deliveryRepository.insertDeliveryIfAbsent(
        tx,
        deliveryRow({ deliveryId: 'dlv_after', eventId: 'evt_after' }),
      );
    });

    const stored = await database.db.select().from(webhookDeliveries);
    expect(stored.map((r) => r.deliveryId).sort()).toEqual(['dlv_after', 'dlv_existing']);
  });
});

describe('claiming the next due delivery', () => {
  it('claims the oldest due row and increments both counters', async () => {
    const now = new Date();
    await seed([
      deliveryRow({ deliveryId: 'dlv_newer', nextAttemptAt: offset(-1 * MINUTE) }),
      deliveryRow({
        deliveryId: 'dlv_older',
        nextAttemptAt: offset(-30 * MINUTE),
        attemptCount: 2,
        cycleAttemptCount: 1,
      }),
    ]);

    const claimed = await deliveryRepository.claimDueDelivery(database.db, now, offset(5 * MINUTE));

    expect(claimed?.deliveryId).toBe('dlv_older');
    expect(claimed?.status).toBe('delivering');
    expect(claimed?.attemptCount, 'the total attempt counter did not advance').toBe(3);
    expect(claimed?.cycleAttemptCount, 'the cycle counter did not advance').toBe(2);
    expect(claimed?.leaseExpiresAt).not.toBeNull();
  });

  /**
   * Crash recovery: a `delivering` row whose lease ran out is claimable again.
   *
   * Without this branch a worker killed mid-attempt strands its delivery forever
   * and nothing says so — the row simply stops being due and no query reports it.
   */
  it('reclaims a delivering row whose lease has expired', async () => {
    const now = new Date();
    await seed([
      deliveryRow({
        deliveryId: 'dlv_abandoned',
        status: 'delivering',
        nextAttemptAt: null,
        leaseExpiresAt: offset(-1 * MINUTE),
      }),
    ]);

    const claimed = await deliveryRepository.claimDueDelivery(database.db, now, offset(5 * MINUTE));

    expect(claimed?.deliveryId).toBe('dlv_abandoned');
  });

  it('does not claim a live lease, a future attempt, or a finished delivery', async () => {
    const now = new Date();
    await seed([
      deliveryRow({
        deliveryId: 'dlv_leased',
        status: 'delivering',
        nextAttemptAt: null,
        leaseExpiresAt: offset(5 * MINUTE),
      }),
      deliveryRow({ deliveryId: 'dlv_future', nextAttemptAt: offset(5 * MINUTE) }),
      deliveryRow({ deliveryId: 'dlv_done', status: 'succeeded', nextAttemptAt: null }),
      deliveryRow({ deliveryId: 'dlv_dead', status: 'dead_letter', nextAttemptAt: null }),
    ]);

    const claimed = await deliveryRepository.claimDueDelivery(database.db, now, offset(5 * MINUTE));

    expect(claimed).toBeNull();
  });
});

/**
 * `FOR UPDATE SKIP LOCKED`, which has no mocked counterpart and no expression in
 * the type system.
 *
 * The first worker's transaction is held OPEN while a second one runs: two awaited
 * calls in sequence never overlap and would prove nothing about concurrency. The
 * harness's 2s `statement_timeout` is what makes the failure legible — without
 * `SKIP LOCKED` the second call BLOCKS on the row lock, and a blocked test is
 * indistinguishable from a slow machine unless it is bounded.
 */
describe('two delivery workers racing', () => {
  /**
   * Granted row-level write locks on THIS table, read from a third connection.
   *
   * `pg_locks` rather than `pg_stat_activity`: the roles differ, and PostgreSQL
   * blanks `state` and `query` for another role's backend, so a
   * `pg_stat_activity` predicate would silently match nothing and the wait below
   * would pass by never measuring anything.
   */
  async function openWriteLocks(): Promise<number> {
    const [row] = await database.asMigrator<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM pg_locks
      WHERE relation = 'webhook_deliveries'::regclass
        AND mode = 'RowExclusiveLock'
        AND granted
    `;
    return row.n;
  }

  /** Runs a second claim while the first is genuinely open, and REFUSES otherwise. */
  async function whileFirstClaimIsOpen(now: Date): Promise<{
    first: deliveryRepository.WebhookDeliveryRow | null;
    second: deliveryRepository.WebhookDeliveryRow | null;
  }> {
    expect(
      await openWriteLocks(),
      'a write lock on webhook_deliveries was already open before this test started; ' +
        'the precondition below would then be satisfied by somebody else and measure nothing',
    ).toBe(0);

    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalClaimed = (): void => undefined;
    const claimReturned = new Promise<void>((resolve) => {
      signalClaimed = resolve;
    });

    const firstPromise = database.db.transaction(async (tx) => {
      const claimed = await deliveryRepository.claimDueDelivery(tx, now, offset(5 * MINUTE));
      signalClaimed();
      await held;
      return claimed;
    });

    await claimReturned;

    // Bounded, and a failure here is an ERROR rather than a quiet pass.
    const deadline = Date.now() + 2_000;
    let locks = await openWriteLocks();
    while (locks === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      locks = await openWriteLocks();
    }
    if (locks === 0) {
      release();
      await firstPromise;
      throw new Error(
        'the first claim never took a row lock on webhook_deliveries, so the second ' +
          'claim would not have contended with it and this test would have passed ' +
          'without measuring SKIP LOCKED at all',
      );
    }

    const second = await deliveryRepository.claimDueDelivery(
      database.db,
      now,
      offset(5 * MINUTE),
    );
    release();

    return { first: await firstPromise, second };
  }

  it('gives two concurrent workers two DIFFERENT deliveries', async () => {
    const now = new Date();
    await seed([
      deliveryRow({ deliveryId: 'dlv_race_a', nextAttemptAt: offset(-30 * MINUTE) }),
      deliveryRow({ deliveryId: 'dlv_race_b', nextAttemptAt: offset(-20 * MINUTE) }),
    ]);

    const { first, second } = await whileFirstClaimIsOpen(now);

    expect(first?.deliveryId).toBe('dlv_race_a');
    expect(second?.deliveryId).toBe('dlv_race_b');
  });

  /**
   * The half that matters most: with ONE row due, the loser gets NOTHING rather
   * than the same row twice. Two workers delivering one webhook twice is the
   * duplicate the whole lease mechanism exists to prevent.
   */
  it('gives the loser nothing when only one delivery is due', async () => {
    const now = new Date();
    await seed([deliveryRow({ deliveryId: 'dlv_race_solo', nextAttemptAt: offset(-30 * MINUTE) })]);

    const { first, second } = await whileFirstClaimIsOpen(now);

    expect(first?.deliveryId).toBe('dlv_race_solo');
    expect(second, 'the same delivery was claimed by both workers').toBeNull();
  });
});

describe('recording an outcome and replaying', () => {
  it('writes every field and clears the lease, including the nulls', async () => {
    const now = new Date();
    await seed([
      deliveryRow({
        deliveryId: 'dlv_outcome',
        status: 'delivering',
        leaseExpiresAt: offset(5 * MINUTE),
        deadLetterReason: 'client_error',
        nextAttemptAt: null,
      }),
    ]);

    await deliveryRepository.recordDeliveryOutcome(database.db, 'dlv_outcome', {
      status: 'succeeded',
      nextAttemptAt: null,
      lastResponseStatus: 200,
      deadLetterReason: null,
      succeededAt: now,
      deadLetteredAt: null,
    });

    const [row] = await database.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.deliveryId, 'dlv_outcome'));

    expect(row.status).toBe('succeeded');
    expect(row.lastResponseStatus).toBe(200);
    expect(row.succeededAt?.getTime()).toBe(now.getTime());
    /** The two that a patch built from `undefined` would have left stale. */
    expect(row.deadLetterReason, 'a stale dead-letter reason survived a success').toBeNull();
    expect(row.leaseExpiresAt, 'the lease was not released').toBeNull();
  });

  /**
   * `cycle_attempt_count` resets and `attempt_count` does NOT.
   *
   * The §10.9 ladder reads the cycle counter, so a replay gets the full schedule
   * again while the total keeps numbering attempts monotonically. Reversed, a
   * replayed delivery gets one attempt before dead-lettering again — which looks
   * like the endpoint failing rather than like the replay being broken.
   */
  it('resets the cycle counter on replay and preserves the total', async () => {
    await seed([
      deliveryRow({
        deliveryId: 'dlv_replay',
        status: 'dead_letter',
        attemptCount: 7,
        cycleAttemptCount: 7,
        nextAttemptAt: null,
        deadLetterReason: 'attempts_exhausted',
        deadLetteredAt: new Date(),
        replayCount: 1,
      }),
    ]);

    await deliveryRepository.replayDeadLetteredDelivery(database.db, 'dlv_replay', new Date());

    const [row] = await database.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.deliveryId, 'dlv_replay'));

    expect(row.status).toBe('pending');
    expect(row.cycleAttemptCount, 'the ladder was not reset').toBe(0);
    expect(row.attemptCount, 'the monotonic total was reset').toBe(7);
    expect(row.replayCount).toBe(2);
    expect(row.deadLetterReason).toBeNull();
    expect(row.deadLetteredAt).toBeNull();
  });
});

describe('the tenant-scoped reads', () => {
  it('refuses a delivery belonging to another tenant', async () => {
    await seed([deliveryRow({ deliveryId: 'dlv_theirs', applicationId: 'app_somebody_else' })]);

    const found = await deliveryRepository.findTenantDelivery(
      database.db,
      ORGANIZATION_ID,
      APPLICATION_ID,
      'dlv_theirs',
    );

    expect(found, "another tenant's delivery was returned").toBeNull();
  });

  it('lists newest first, filtered, and honours the limit', async () => {
    await seed([
      deliveryRow({ deliveryId: 'dlv_l_old', createdAt: offset(-30 * MINUTE) }),
      deliveryRow({ deliveryId: 'dlv_l_new', createdAt: offset(-1 * MINUTE) }),
      deliveryRow({ deliveryId: 'dlv_l_dead', status: 'dead_letter', createdAt: offset(-2 * MINUTE) }),
      deliveryRow({ deliveryId: 'dlv_l_theirs', applicationId: 'app_somebody_else' }),
    ]);

    const all = await deliveryRepository.listTenantDeliveries(
      database.db,
      ORGANIZATION_ID,
      APPLICATION_ID,
      {},
      10,
    );
    expect(all.map((r) => r.deliveryId)).toEqual(['dlv_l_new', 'dlv_l_dead', 'dlv_l_old']);

    const onlyDead = await deliveryRepository.listTenantDeliveries(
      database.db,
      ORGANIZATION_ID,
      APPLICATION_ID,
      { status: 'dead_letter' },
      10,
    );
    expect(onlyDead.map((r) => r.deliveryId)).toEqual(['dlv_l_dead']);

    const limited = await deliveryRepository.listTenantDeliveries(
      database.db,
      ORGANIZATION_ID,
      APPLICATION_ID,
      {},
      1,
    );
    expect(limited.map((r) => r.deliveryId)).toEqual(['dlv_l_new']);
  });

  /**
   * The one cross-tenant read, and `NULLS LAST` is the thing under test.
   *
   * `dead_lettered_at` is nullable and under `DESC` PostgreSQL puts NULLs FIRST by
   * default — so a `dead_letter` row without a timestamp would sit at the head of
   * the operator's queue ahead of every real one. That is the house bug, and the
   * fixture writes exactly such a row so the ordering cannot be right by accident.
   */
  it('orders dead letters newest first, with undated rows LAST', async () => {
    await seed([
      deliveryRow({
        deliveryId: 'dlv_dl_old',
        status: 'dead_letter',
        deadLetteredAt: offset(-30 * MINUTE),
      }),
      deliveryRow({
        deliveryId: 'dlv_dl_new',
        status: 'dead_letter',
        deadLetteredAt: offset(-1 * MINUTE),
      }),
      deliveryRow({ deliveryId: 'dlv_dl_undated', status: 'dead_letter', deadLetteredAt: null }),
      deliveryRow({ deliveryId: 'dlv_dl_pending', status: 'pending' }),
    ]);

    const rows = await deliveryRepository.listDeadLetteredAcrossTenants(database.db, 10);

    expect(rows.map((r) => r.deliveryId)).toEqual(['dlv_dl_new', 'dlv_dl_old', 'dlv_dl_undated']);
  });
});

/**
 * The counts, where `GROUP BY` and `countDocuments` disagree about absence.
 *
 * A `GROUP BY` omits a status nobody is in; it does not return zero for it. Mongo's
 * `countDocuments` returns `0`. So the zero-fill is the whole port, and the test
 * that matters is the one with a status nobody is in.
 */
describe('delivery health counts', () => {
  it('reports ZERO for a status with no rows, not a missing key', async () => {
    await seed([deliveryRow({ deliveryId: 'dlv_c_pending', status: 'pending' })]);

    const counts = await deliveryRepository.countDeliveriesAcrossTenants(database.db);

    expect(counts).toEqual({ pending: 1, delivering: 0, succeeded: 0, deadLetter: 0 });
  });

  /**
   * `count(*)` arrives from postgres.js as a STRING — `int8` is decoded as text —
   * while drizzle types it `number`. Untouched, these values compare and add as
   * strings, and `"1" + 1` is `"11"`. Asserted by ARITHMETIC rather than by
   * `toEqual`, because `toEqual` on a number literal would fail for a string too
   * but would not say why.
   */
  it('returns numbers, not the strings postgres.js decodes int8 into', async () => {
    await seed([
      deliveryRow({ deliveryId: 'dlv_n_1', status: 'succeeded' }),
      deliveryRow({ deliveryId: 'dlv_n_2', status: 'succeeded' }),
    ]);

    const counts = await deliveryRepository.countDeliveriesAcrossTenants(database.db);

    expect(typeof counts.succeeded).toBe('number');
    expect(counts.succeeded + 1, 'the count concatenated instead of adding').toBe(3);
  });

  it('counts one endpoint within one tenant, and nothing else', async () => {
    await seed([
      deliveryRow({ deliveryId: 'dlv_h_a', status: 'pending' }),
      deliveryRow({ deliveryId: 'dlv_h_b', status: 'dead_letter' }),
      deliveryRow({ deliveryId: 'dlv_h_other_ep', webhookEndpointId: 'whe_other', status: 'pending' }),
      deliveryRow({
        deliveryId: 'dlv_h_other_tenant',
        applicationId: 'app_somebody_else',
        status: 'pending',
      }),
    ]);

    const counts = await deliveryRepository.countDeliveriesForEndpoint(
      database.db,
      ORGANIZATION_ID,
      APPLICATION_ID,
      ENDPOINT_ID,
    );

    expect(counts).toEqual({ pending: 1, delivering: 0, succeeded: 0, deadLetter: 1 });
  });
});

/** A vacuity floor: every assertion above is "rows come back" or "none do". */
describe('the fixtures reach the table under test', () => {
  it('writes rows that are really in webhook_deliveries', async () => {
    await seed([deliveryRow({ deliveryId: 'dlv_floor' })]);

    const [row] = await database.asMigrator<{ count: string }[]>`
      SELECT count(*)::text AS count FROM webhook_deliveries WHERE delivery_id = 'dlv_floor'
    `;
    expect(row.count).toBe('1');

    const conflict = await database.db
      .insert(webhookDeliveries)
      .values(deliveryRow({ deliveryId: 'dlv_floor' }))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(isUniqueViolation(conflict, 'webhook_deliveries_pkey')).toBe(true);
  });
});

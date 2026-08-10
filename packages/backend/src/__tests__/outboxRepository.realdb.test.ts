import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as outboxRepository from '../db/postgres/repositories/outbox';
import { outboxEvents } from '../db/postgres/schema/infrastructure';
import { createTenantContext, type TenantContext } from '../db/tenantScope';
import { withTenant, type PgTransactionHandle } from '../db/postgres/withTenant';
import {
  OUTBOX_EVENT_TYPES,
  type OutboxEventType,
} from '../modules/outbox/outbox.collection';
import {
  createPostgresTestDatabase,
  type PostgresTestDatabase,
} from './support/postgresTestDatabase';

/**
 * The outbox repository, against a real PostgreSQL server.
 *
 * Nothing calls it in production yet, so without this file these would be
 * statements whose first execution is in production. That is the ordinary reason.
 * The particular reason is that three of the properties below have NO mocked
 * counterpart: `FOR UPDATE SKIP LOCKED`, a transaction that aborts and takes an
 * already-successful INSERT with it, and `$onUpdate` actually reaching the
 * column. A mock agrees with every claim made about all three.
 *
 * The file is organised around the one question that matters — does the outbox
 * row commit with the work it records — and every negative assertion has a
 * positive control beside it, because "no row" and "nothing was ever written"
 * are the same observation.
 */

let database: PostgresTestDatabase;

const tenant: TenantContext = createTenantContext('org_outbox', 'app_outbox_one');
const sibling: TenantContext = createTenantContext('org_outbox_other', 'app_outbox_two');

/**
 * Every instant that decides DUE-NESS is relative to the moment this file loaded,
 * and that is a correctness requirement rather than a style.
 *
 * `appendOutboxEvent` stamps `available_at` from the process clock, so a fixture
 * pinned to an absolute wall-clock time makes the suite green only when it runs
 * on the right side of that time — a green that expires at a particular hour of
 * the day and fails somewhere else entirely. Anchoring here means an appended row
 * is always LATER than `NOW` and therefore never due, whatever the clock says.
 */
const NOW = new Date();

function offset(milliseconds: number): Date {
  return new Date(NOW.getTime() + milliseconds);
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** The claim window every test shares unless it is testing the window itself. */
const LEASE_UNTIL = offset(MINUTE);
const DUE = offset(-60 * MINUTE);

/**
 * Far enough in the past that "the stamp moved" is never a same-millisecond tie.
 * Safe as a stored value: `outbox_events` is not an expiry target — `expiry.ts`
 * registers only `webhook_attempts` — so nothing sweeps a row for being old.
 */
const ANCIENT_STAMP = offset(-365 * 24 * 60 * MINUTE);

interface SeedRow {
  readonly eventId: string;
  readonly type?: OutboxEventType;
  readonly status?: string;
  readonly attempts?: number;
  readonly availableAt?: Date;
  readonly lastError?: string | null;
  readonly context?: TenantContext;
}

/**
 * Seeds a row AS THE MIGRATOR, with the exact status, attempt count and deadline
 * a case needs.
 *
 * Raw SQL rather than `appendOutboxEvent`, because most of these states — an
 * expired lease, a dead letter, a row not yet due — are ones the append cannot
 * produce. Seeding through it would restrict every test to the single state it
 * writes.
 *
 * `updated_at` is stamped a year back on purpose: the claim test asserts the
 * stamp MOVED, and a row written milliseconds earlier could tie.
 *
 * ONE CONSTRAINT THIS FILE LIVES UNDER, because it is invisible until it bites:
 * every test shares one table, and a claim is filtered only by TYPE. So a test
 * that leaves a due row behind decides what the NEXT claim of that type returns.
 * A type may be reused only once its earlier rows are unclaimable — dispatched,
 * dead-lettered, or leased past the claim's clock. Two tests seeding the same
 * type at the same deadline is a tie broken arbitrarily by the server, which is a
 * flake rather than a failure.
 */
async function seed(row: SeedRow): Promise<string> {
  const context = row.context ?? tenant;
  await database.asMigrator`
    INSERT INTO outbox_events (event_id, organization_id, application_id, type, payload,
                               status, attempts, available_at, dispatched_at, last_error,
                               created_at, updated_at)
    VALUES (${row.eventId}, ${context.organizationId}, ${context.applicationId},
            ${row.type ?? OUTBOX_EVENT_TYPES.reportReceived},
            ${JSON.stringify({ reportId: row.eventId })}::jsonb,
            ${row.status ?? 'pending'}, ${row.attempts ?? 0},
            ${row.availableAt ?? DUE}, NULL, ${row.lastError ?? null},
            ${ANCIENT_STAMP}, ${ANCIENT_STAMP})
  `;
  return row.eventId;
}

/** How many rows carry this id, read as the migrator so no policy is involved. */
async function countById(eventId: string): Promise<number> {
  const [row] = await database.asMigrator<{ n: number }[]>`
    SELECT count(*)::int AS n FROM outbox_events WHERE event_id = ${eventId}
  `;
  return row.n;
}

function claimOf(types: readonly OutboxEventType[], now: Date = NOW) {
  return { types, now, leaseUntil: LEASE_UNTIL };
}

beforeAll(async () => {
  database = await createPostgresTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

describe('the append commits with the work it records', () => {
  /**
   * The positive control, and it is not decoration.
   *
   * Every rollback assertion below reads "no row with this id" — which is also
   * exactly what a silently broken INSERT reports, and both readings are green.
   * This is what makes the zeros below mean ROLLED BACK rather than NEVER
   * WRITTEN.
   */
  it('control: a committed transaction leaves exactly one row, tenant-stamped', async () => {
    const eventId = await withTenant(database.db, tenant, async (tx) =>
      outboxRepository.appendOutboxEvent(tx, tenant, {
        type: OUTBOX_EVENT_TYPES.reportReceived,
        payload: { reportId: 'rpt_committed' },
      }),
    );

    expect(await countById(eventId)).toBe(1);

    const stored = await outboxRepository.findOutboxEventById(database.db, eventId);
    expect(stored).not.toBeNull();
    expect(stored?.organizationId).toBe(tenant.organizationId);
    expect(stored?.applicationId).toBe(tenant.applicationId);
    expect(stored?.status).toBe('pending');
    expect(stored?.attempts).toBe(0);
    expect(stored?.dispatchedAt).toBeNull();
    expect(stored?.lastError).toBeNull();
    expect(stored?.payload).toEqual({ reportId: 'rpt_committed' });
  });

  /**
   * THE test this layer exists for.
   *
   * The obvious version — make the OUTBOX write fail, check the domain write is
   * gone — proves nothing about where the row was written, because the caller
   * rolls back either way. Here the append SUCCEEDS and a later step in the same
   * transaction throws, so the row survives if and only if it escaped: precisely
   * the bug that leaves moderation work with no trace.
   */
  it('takes the row with it when a LATER step in the same transaction throws', async () => {
    const appended: string[] = [];

    await expect(
      withTenant(database.db, tenant, async (tx) => {
        appended.push(
          await outboxRepository.appendOutboxEvent(tx, tenant, {
            type: OUTBOX_EVENT_TYPES.reportReceived,
            payload: { reportId: 'rpt_rolled_back' },
          }),
        );
        throw new Error('the domain write failed after the outbox row was appended');
      }),
    ).rejects.toThrow(/the domain write failed/);

    // The append DID run and DID produce an id. Without this the test would pass
    // on a callback that never reached the append at all.
    expect(appended).toHaveLength(1);
    expect(await countById(appended[0])).toBe(0);
  });

  /**
   * The same property when the failure is the DATABASE's rather than JavaScript's.
   *
   * Its own case because the two travel different paths: a thrown `Error` unwinds
   * through drizzle, while a `23505` leaves the server-side transaction already
   * aborted (`25P02`) — every subsequent statement in it fails too. The append
   * must not survive either.
   */
  it('takes the row with it when a later statement violates a constraint', async () => {
    const clash = await seed({ eventId: 'evt_pk_clash' });
    const appended: string[] = [];

    await expect(
      withTenant(database.db, tenant, async (tx) => {
        appended.push(
          await outboxRepository.appendOutboxEvent(tx, tenant, {
            type: OUTBOX_EVENT_TYPES.caseReadyForTriage,
            payload: { caseId: 'case_rolled_back' },
          }),
        );

        // A primary-key collision with the row seeded above.
        await tx.insert(outboxEvents).values({
          eventId: clash,
          organizationId: tenant.organizationId,
          applicationId: tenant.applicationId,
          type: OUTBOX_EVENT_TYPES.reportReceived,
          payload: {},
          status: 'pending',
          attempts: 0,
          availableAt: NOW,
        });
      }),
    ).rejects.toThrow();

    expect(appended).toHaveLength(1);
    expect(await countById(appended[0])).toBe(0);
    // The seeded row is untouched — the rollback undid the attempt, not the table.
    expect(await countById(clash)).toBe(1);
  });
});

describe('the guard that makes a pool unusable here', () => {
  /**
   * The runtime half of the enforcement, exercised through the hole it exists for:
   * a handle that is TYPED as a transaction and IS a pool.
   *
   * The real pool, not a stub — the property asserted is a fact about drizzle's
   * own objects, and a hand-made `{}` would pass while proving nothing.
   */
  it('refuses a pool handle that was cast to a transaction', async () => {
    await expect(
      outboxRepository.appendOutboxEvent(
        database.db as unknown as PgTransactionHandle,
        tenant,
        { type: OUTBOX_EVENT_TYPES.reportReceived, payload: { reportId: 'rpt_pool' } },
      ),
    ).rejects.toThrow(/must run inside a transaction/);
  });

  /**
   * The non-vacuity half. Without it a guard that threw on EVERYTHING would
   * satisfy the assertion above, and "the append always fails" is not the claim.
   *
   * It also makes a design decision observable: `outbox_events` carries no policy,
   * so an append does not require a TENANT transaction — which is why the
   * parameter is `PgTransactionHandle` rather than `TenantScopedHandle`.
   */
  it('accepts a real transaction that carries no tenant context', async () => {
    const eventId = await database.db.transaction(async (tx) =>
      outboxRepository.appendOutboxEvent(tx, sibling, {
        type: OUTBOX_EVENT_TYPES.reportReceived,
        payload: { reportId: 'rpt_untenanted' },
      }),
    );

    const stored = await outboxRepository.findOutboxEventById(database.db, eventId);
    expect(stored?.applicationId).toBe(sibling.applicationId);
  });
});

describe('claiming a due row', () => {
  it('claims the oldest due row and returns it AFTER the update', async () => {
    const older = await seed({
      eventId: 'evt_claim_older',
      availableAt: offset(-120 * MINUTE),
    });
    await seed({
      eventId: 'evt_claim_newer',
      availableAt: offset(-30 * MINUTE),
    });

    const claimed = await outboxRepository.claimNextOutboxEvent(
      database.db,
      claimOf([OUTBOX_EVENT_TYPES.reportReceived, OUTBOX_EVENT_TYPES.caseReadyForTriage]),
    );

    expect(claimed?.eventId).toBe(older);
    expect(claimed?.status).toBe('dispatching');
    expect(claimed?.availableAt).toEqual(LEASE_UNTIL);
    /**
     * ONE, not zero. Mongo's wrapper hardcodes `returnDocument: 'after'`, and the
     * dispatcher's dead-letter arithmetic reads `attempts` off this row — a
     * before-image would dead-letter every row one attempt late, silently.
     */
    expect(claimed?.attempts).toBe(1);
  });

  /**
   * `updated_at` is maintained by `$onUpdate`, which the query BUILDER applies and
   * a raw `db.execute` would not. Asserting the stamp MOVED is what makes "the
   * claim is built, not hand-written SQL" a checked property rather than a
   * stylistic preference.
   */
  it('moves updated_at, which only the query builder does', async () => {
    const eventId = await seed({
      eventId: 'evt_claim_stamp',
      type: OUTBOX_EVENT_TYPES.caseReadyForReview,
      availableAt: offset(-120 * MINUTE),
    });

    const before = await outboxRepository.findOutboxEventById(database.db, eventId);
    expect(before?.updatedAt).toEqual(ANCIENT_STAMP);

    await outboxRepository.claimNextOutboxEvent(
      database.db,
      claimOf([OUTBOX_EVENT_TYPES.caseReadyForReview]),
    );

    const after = await outboxRepository.findOutboxEventById(database.db, eventId);
    expect(after).not.toBeNull();
    expect(after?.updatedAt.getTime()).toBeGreaterThan(ANCIENT_STAMP.getTime());
  });

  it('leaves a row that is not yet due, and takes it once it is', async () => {
    await seed({
      eventId: 'evt_not_due',
      type: OUTBOX_EVENT_TYPES.assignmentVacated,
      availableAt: offset(60 * MINUTE),
    });

    expect(
      await outboxRepository.claimNextOutboxEvent(
        database.db,
        claimOf([OUTBOX_EVENT_TYPES.assignmentVacated]),
      ),
    ).toBeNull();

    // The control: the same row, the same call, a clock that has caught up. Without
    // it the null above is equally what an empty table would report.
    const later = await outboxRepository.claimNextOutboxEvent(
      database.db,
      claimOf([OUTBOX_EVENT_TYPES.assignmentVacated], offset(120 * MINUTE)),
    );
    expect(later?.eventId).toBe('evt_not_due');
  });

  /**
   * A dead letter stays put. §12.5's guarantee is that pending work is
   * re-derivable from these rows, so a row that cannot be handled has to stay
   * visible for an operator to replay; claiming it again would spin forever.
   */
  it('never claims a failed row, and does claim an identical pending one', async () => {
    await seed({
      eventId: 'evt_dead_letter',
      type: OUTBOX_EVENT_TYPES.reviewSubmitted,
      status: 'failed',
      attempts: 8,
    });

    expect(
      await outboxRepository.claimNextOutboxEvent(
        database.db,
        claimOf([OUTBOX_EVENT_TYPES.reviewSubmitted]),
      ),
    ).toBeNull();

    // Same type, same deadline, same attempt count — only the status differs. So
    // the null above is the STATUS filter rather than an exhausted queue.
    await seed({
      eventId: 'evt_still_pending',
      type: OUTBOX_EVENT_TYPES.reviewSubmitted,
      status: 'pending',
      attempts: 8,
    });
    const claimed = await outboxRepository.claimNextOutboxEvent(
      database.db,
      claimOf([OUTBOX_EVENT_TYPES.reviewSubmitted]),
    );
    expect(claimed?.eventId).toBe('evt_still_pending');
  });

  /**
   * Crash recovery: a lease that has run out is claimable again. Without it a
   * dispatcher that died mid-handler would hold its rows forever, and nothing in
   * the system would say so.
   */
  it('reclaims a dispatching row whose lease has expired', async () => {
    await seed({
      eventId: 'evt_expired_lease',
      type: OUTBOX_EVENT_TYPES.caseDecided,
      status: 'dispatching',
      attempts: 2,
    });

    const claimed = await outboxRepository.claimNextOutboxEvent(
      database.db,
      claimOf([OUTBOX_EVENT_TYPES.caseDecided]),
    );

    expect(claimed?.eventId).toBe('evt_expired_lease');
    expect(claimed?.attempts).toBe(3);
  });

  it('claims only types with a consumer, and takes the row once its type has one', async () => {
    await seed({ eventId: 'evt_unconsumed', type: OUTBOX_EVENT_TYPES.appealDecided });

    expect(
      await outboxRepository.claimNextOutboxEvent(
        database.db,
        claimOf([OUTBOX_EVENT_TYPES.decisionCorrected]),
      ),
    ).toBeNull();

    const claimed = await outboxRepository.claimNextOutboxEvent(
      database.db,
      claimOf([OUTBOX_EVENT_TYPES.appealDecided]),
    );
    expect(claimed?.eventId).toBe('evt_unconsumed');
  });

  it('claims nothing when no type has a consumer, and touches no row', async () => {
    const eventId = await seed({
      eventId: 'evt_no_consumers',
      type: OUTBOX_EVENT_TYPES.appealCreated,
    });

    expect(
      await outboxRepository.claimNextOutboxEvent(database.db, claimOf([])),
    ).toBeNull();

    /**
     * Untouched, not merely unclaimed.
     *
     * What this does NOT pin is the early return in `claimNextOutboxEvent`:
     * deleting that line leaves this test green, because drizzle renders an empty
     * `inArray` as `false` and the statement matches nothing anyway. The property
     * asserted here is the OUTCOME — no consumer means no row moves — which stays
     * true either way and is the thing a dispatcher depends on.
     */
    const after = await outboxRepository.findOutboxEventById(database.db, eventId);
    expect(after?.status).toBe('pending');
    expect(after?.attempts).toBe(0);
    expect(after?.updatedAt).toEqual(ANCIENT_STAMP);
  });

  /**
   * `caseReadyForTriage` because no earlier test leaves a row of it behind — the
   * only one that appends it does so inside a transaction that rolls back. See
   * the constraint stated on `seed`.
   */
  it('claims across tenants, which is the whole reason the table has no policy', async () => {
    await seed({
      eventId: 'evt_other_tenant',
      type: OUTBOX_EVENT_TYPES.caseReadyForTriage,
      context: sibling,
    });

    const claimed = await outboxRepository.claimNextOutboxEvent(
      database.db,
      claimOf([OUTBOX_EVENT_TYPES.caseReadyForTriage]),
    );

    expect(claimed?.eventId).toBe('evt_other_tenant');
    expect(claimed?.applicationId).toBe(sibling.applicationId);
  });
});

/**
 * `FOR UPDATE SKIP LOCKED`, which has no mocked counterpart and no expression in
 * the type system.
 *
 * Both cases hold the first dispatcher's transaction OPEN while a second one
 * runs: two awaited calls in sequence never overlap and would prove nothing about
 * concurrency. The harness's 2s `statement_timeout` is what makes the failure
 * legible — without `SKIP LOCKED` the second call BLOCKS on the row lock, and a
 * blocked test is indistinguishable from a slow machine unless it is bounded.
 * Bounded, it fails as `57014 query_canceled` in about two seconds.
 */
describe('two dispatchers racing for the same rows', () => {
  async function whileFirstClaimIsOpen(
    types: readonly OutboxEventType[],
  ): Promise<{
    first: outboxRepository.OutboxEventRow | null;
    second: outboxRepository.OutboxEventRow | null;
  }> {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const firstPromise = database.db.transaction(async (tx) => {
      const claimed = await outboxRepository.claimNextOutboxEvent(tx, claimOf(types));
      await held;
      return claimed;
    });

    // Long enough for the first transaction to have taken its row lock. If it has
    // not, the second call simply claims the same row and the assertions below
    // fail — the correct direction for a flake to fail in.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = await outboxRepository.claimNextOutboxEvent(database.db, claimOf(types));
    release();

    return { first: await firstPromise, second };
  }

  it('gives two concurrent dispatchers two DIFFERENT rows', async () => {
    await seed({
      eventId: 'evt_race_a',
      type: OUTBOX_EVENT_TYPES.caseReadyForReview,
      availableAt: offset(-180 * MINUTE),
    });
    await seed({
      eventId: 'evt_race_b',
      type: OUTBOX_EVENT_TYPES.caseReadyForReview,
      availableAt: offset(-150 * MINUTE),
    });

    const { first, second } = await whileFirstClaimIsOpen([
      OUTBOX_EVENT_TYPES.caseReadyForReview,
    ]);

    expect(first?.eventId).toBe('evt_race_a');
    expect(second?.eventId).toBe('evt_race_b');
  });

  it('gives the loser NOTHING when only one row is due, never the same row twice', async () => {
    await seed({
      eventId: 'evt_race_solo',
      type: OUTBOX_EVENT_TYPES.appealDecided,
      availableAt: offset(-180 * MINUTE),
    });

    const { first, second } = await whileFirstClaimIsOpen([OUTBOX_EVENT_TYPES.appealDecided]);

    expect(first?.eventId).toBe('evt_race_solo');
    expect(second).toBeNull();
  });
});

describe('completing a claimed row', () => {
  it('marks a row dispatched and clears its last error', async () => {
    const eventId = await seed({
      eventId: 'evt_done',
      status: 'dispatching',
      attempts: 1,
      lastError: 'a previous attempt failed',
    });

    const dispatchedAt = offset(5 * MINUTE);
    expect(
      await outboxRepository.markOutboxEventDispatched(database.db, eventId, dispatchedAt),
    ).toBe(1);

    const stored = await outboxRepository.findOutboxEventById(database.db, eventId);
    expect(stored?.status).toBe('dispatched');
    expect(stored?.dispatchedAt).toEqual(dispatchedAt);
    expect(stored?.lastError).toBeNull();
  });

  it('schedules a retry, and the row is claimable again at its deadline', async () => {
    const eventId = await seed({
      eventId: 'evt_retry',
      type: OUTBOX_EVENT_TYPES.decisionCorrected,
      status: 'dispatching',
      attempts: 2,
    });
    const retryAt = offset(4 * SECOND);

    expect(
      await outboxRepository.markOutboxEventFailed(database.db, eventId, {
        status: 'pending',
        availableAt: retryAt,
        lastError: 'handler threw',
      }),
    ).toBe(1);

    const stored = await outboxRepository.findOutboxEventById(database.db, eventId);
    expect(stored?.status).toBe('pending');
    expect(stored?.availableAt).toEqual(retryAt);
    expect(stored?.lastError).toBe('handler threw');

    // Claimable once the backoff has passed. A retry that quietly stopped being
    // due would be a dead letter nothing reported.
    const claimed = await outboxRepository.claimNextOutboxEvent(
      database.db,
      claimOf([OUTBOX_EVENT_TYPES.decisionCorrected], offset(5 * SECOND)),
    );
    expect(claimed?.eventId).toBe(eventId);
  });

  it('dead-letters a row, which then stays put', async () => {
    const eventId = await seed({
      eventId: 'evt_exhausted',
      type: OUTBOX_EVENT_TYPES.appealCreated,
      status: 'dispatching',
      attempts: 8,
    });

    expect(
      await outboxRepository.markOutboxEventFailed(database.db, eventId, {
        status: 'failed',
        availableAt: NOW,
        lastError: 'handler threw for the eighth time',
      }),
    ).toBe(1);

    const stored = await outboxRepository.findOutboxEventById(database.db, eventId);
    expect(stored?.status).toBe('failed');
    // NOT deleted. Discarding it would turn a handler bug into permanently lost
    // moderation work with no record that it ever existed.
    expect(await countById(eventId)).toBe(1);
  });

  /**
   * An id nothing matches answers 0 rather than throwing.
   *
   * The count comes off `returning()`. Read off `rows.length` of a NON-returning
   * update it would be 0 for a row that WAS updated too — so this case together
   * with the three above is what separates the two spellings.
   */
  it('answers zero for an id that matches nothing, and finds no such row', async () => {
    expect(
      await outboxRepository.markOutboxEventDispatched(database.db, 'evt_absent', NOW),
    ).toBe(0);
    expect(
      await outboxRepository.markOutboxEventFailed(database.db, 'evt_absent', {
        status: 'pending',
        availableAt: NOW,
        lastError: 'never happened',
      }),
    ).toBe(0);
    expect(await outboxRepository.findOutboxEventById(database.db, 'evt_absent')).toBeNull();
  });
});

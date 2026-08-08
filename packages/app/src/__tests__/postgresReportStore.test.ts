/**
 * The Postgres report store, against a real Postgres.
 *
 * The revision guard is the property worth most here — three of the assertions
 * attack one clause of it each.
 *
 * One assertion records a MEASUREMENT that contradicts the plan: an `extra` key
 * the table does not declare is dropped silently, exactly as Mongoose strict mode
 * drops it, because drizzle builds the statement from the table's own columns and
 * Postgres never sees the offending name. See that test for the evidence.
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresReportStore } from '../postgres/store/reports.js';
import { postgresTransactionRunner } from '../postgres/store/transaction.js';
import type { ModerationPgHandle } from '../postgres/store/transaction.js';
import type {
  ModerationReportDecisionUpdate,
  ModerationReportStore,
  ModerationTransactionRunner,
} from '../store/types.js';
import type { ModerationReportFields } from '../types.js';
import {
  createPostgresTestDatabase,
  type PostgresTestDatabase,
} from './support/postgres/database.js';
import { moderation, reports } from './support/postgres/schema.js';

/** The fictional application's report: the shared fields plus its legacy verdict. */
interface TestPostgresReport extends ModerationReportFields {
  legacyStatus: string;
}

let database: PostgresTestDatabase | null = null;
let store: ModerationReportStore<TestPostgresReport, ModerationPgHandle> | null = null;
let transaction: ModerationTransactionRunner<ModerationPgHandle> | null = null;

beforeAll(async () => {
  database = await createPostgresTestDatabase();
  store = postgresReportStore<TestPostgresReport>({
    db: database.db,
    reportTable: reports,
  });
  transaction = postgresTransactionRunner(database.db);
});

afterAll(async () => {
  await database?.close();
  database = null;
});

beforeEach(async () => {
  await handle().delete(moderation.outbox);
  await handle().delete(reports);
});

function handle(): ModerationPgHandle {
  if (database === null) throw new Error('the throwaway database was not created');
  return database.db;
}

function reportStore(): ModerationReportStore<TestPostgresReport, ModerationPgHandle> {
  if (store === null) throw new Error('the store was not built');
  return store;
}

function runner(): ModerationTransactionRunner<ModerationPgHandle> {
  if (transaction === null) throw new Error('the runner was not built');
  return transaction;
}

/** Store a report the way intake does: inside a transaction, through the store. */
async function insertReport(overrides: {
  reporter?: string;
  reportedId?: string;
  localStatus?: ModerationReportFields['localStatus'];
  extra?: Readonly<Record<string, unknown>>;
} = {}): Promise<TestPostgresReport> {
  return await runner().run(
    async (tx) =>
      await reportStore().insert(
        {
          reportedType: 'widget',
          reportedId: overrides.reportedId ?? 'widget-1',
          reporter: overrides.reporter ?? 'oxy-reporter',
          categories: ['spam'],
          localStatus: overrides.localStatus ?? 'queued',
          ...(overrides.extra === undefined ? {} : { extra: overrides.extra }),
        },
        tx,
      ),
  );
}

function decisionUpdate(revision: number, outcome: string): ModerationReportDecisionUpdate {
  return {
    localStatus: 'closed',
    decisionId: 'dec_1',
    decisionRevision: revision,
    decisionOutcome: outcome,
    decisionStatus: 'final',
    decidedAt: new Date('2026-08-01T12:00:00.000Z'),
    enforcedAction: 'restrict',
    extra: { legacyStatus: outcome === 'violation' ? 'resolved' : 'dismissed' },
  };
}

async function readRow(id: string): Promise<Record<string, unknown> | undefined> {
  const rows = await handle().select().from(reports).where(eq(reports.id, id));
  return rows[0];
}

describe('storing a report', () => {
  it('returns the row it wrote, with the id the database generated', async () => {
    const report = await insertReport();
    expect(report.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(report.localStatus).toBe('queued');
    expect(report.categories).toEqual(['spam']);
    // Straight back out of the database, so the returned row is not a local fiction.
    expect((await reportStore().findById(report.id))?.id).toBe(report.id);
  });

  it("stores the application's own columns without letting them decide ours", async () => {
    const report = await insertReport({
      extra: { legacyStatus: 'triaged', localStatus: 'closed' },
    });
    expect(report.legacyStatus).toBe('triaged');
    expect(report.localStatus).toBe('queued');
  });

  it('DROPS an extra field the table does not declare, exactly as Mongoose does', async () => {
    /**
     * This assertion records a behaviour the plan expected to be the opposite, so
     * it is written to the measurement rather than to the expectation.
     *
     * The brief says an undeclared key "raises rather than silently dropping it —
     * this is Postgres's own behaviour", and Postgres would indeed raise `42703`
     * for a column that does not exist. **It never sees one.** Drizzle builds the
     * INSERT from the TABLE's declared columns and ignores every key it does not
     * recognise: measured with `.toSQL()`, `notAColumnAtAll` appears nowhere in
     * the statement or its parameters.
     *
     * So the silent-discard hazard is not a Mongoose property, it is an ORM
     * property, and BOTH ORMs have it. `CreateReportInput.extra` is
     * `Record<string, unknown>` by design — the whole point is that this package
     * does not know an adopter's columns — so no type catches it either, on either
     * backend. An adopter who misspells one of their own columns stores nothing
     * there, forever, with no error and no warning.
     *
     * Asserted here so the next reader gets the measurement instead of the
     * expectation; a guard belongs in one place for both backends, which is a
     * decision above this task.
     */
    const report = await insertReport({
      extra: { legacyStatus: 'triaged', notAColumnAtAll: 'anything' },
    });

    // The declared column landed; the undeclared key vanished without a sound.
    expect(report.legacyStatus).toBe('triaged');
    const row = await readRow(report.id);
    expect(row).not.toHaveProperty('notAColumnAtAll');
    expect(row?.legacyStatus).toBe('triaged');
  });

  it('finds a duplicate by reporter, object and type', async () => {
    const first = await insertReport();
    const found = await runner().run(
      async (tx) =>
        await reportStore().findDuplicate(
          { reporter: 'oxy-reporter', reportedId: 'widget-1', reportedType: 'widget' },
          tx,
        ),
    );
    expect(found?.id).toBe(first.id);

    const other = await runner().run(
      async (tx) =>
        await reportStore().findDuplicate(
          { reporter: 'somebody-else', reportedId: 'widget-1', reportedType: 'widget' },
          tx,
        ),
    );
    expect(other).toBeNull();
  });

  it('answers null for an id nothing could have generated, without rejecting', async () => {
    /**
     * G13, and the reason it evaporates: `id` is `text`, so a malformed id matches
     * no rows. Mongoose raises a `CastError` for the same input and its store has
     * to catch it; there is nothing to catch here, and a branch for `22P02` would
     * handle an error this column cannot raise.
     */
    await expect(reportStore().findById('not-an-id-at-all')).resolves.toBeNull();
    await expect(reportStore().findById('')).resolves.toBeNull();
  });
});

describe('the revision guard', () => {
  it('refuses a revision older than the one already stored', async () => {
    /** Catches dropping the `lte(decisionRevision, maxRevision)` arm — an older
     * revision landing last would overwrite the current answer with a stale one,
     * which is what happens whenever a correction and its predecessor are in
     * flight together. */
    const report = await insertReport();

    expect(
      await reportStore().applyDecision(report.id, decisionUpdate(2, 'violation'), 2),
    ).toBe(true);
    expect(
      await reportStore().applyDecision(report.id, decisionUpdate(1, 'no_violation'), 1),
    ).toBe(false);

    const row = await readRow(report.id);
    expect(row?.decisionRevision).toBe(2);
    expect(row?.decisionOutcome).toBe('violation');
    expect(row?.legacyStatus).toBe('resolved');
  });

  it('applies to a report that has no decision yet', async () => {
    /** Catches dropping the `isNull(decisionRevision)` arm. A first decision would
     * then match nothing at all: every report would stay `queued` forever, with
     * the decision worker reporting zero rows updated. */
    const report = await insertReport();
    expect(await readRow(report.id)).toMatchObject({ decisionRevision: null });

    expect(
      await reportStore().applyDecision(report.id, decisionUpdate(3, 'violation'), 3),
    ).toBe(true);
    expect((await readRow(report.id))?.decisionRevision).toBe(3);
  });

  it('accepts a redelivery of the SAME revision', async () => {
    /** Catches `lte` becoming `lt`. CrowdSource retries for 24 hours, so the same
     * revision arriving twice is ordinary — and a partially-applied decision needs
     * the second delivery to converge rather than be refused. */
    const report = await insertReport();
    expect(
      await reportStore().applyDecision(report.id, decisionUpdate(2, 'violation'), 2),
    ).toBe(true);
    expect(
      await reportStore().applyDecision(report.id, decisionUpdate(2, 'violation'), 2),
    ).toBe(true);
  });

  it('answers false for a report that does not exist', async () => {
    expect(
      await reportStore().applyDecision('no-such-report', decisionUpdate(1, 'violation'), 1),
    ).toBe(false);
  });
});

describe('the delivery transitions', () => {
  it('marks a report submitted and clears what is no longer true', async () => {
    const report = await insertReport();
    await reportStore().markDeliveryFailed(report.id, 'CrowdSource was unreachable');
    await reportStore().close(report.id, 'nothing to review');

    const submittedAt = new Date('2026-08-01T12:00:00.000Z');
    await reportStore().markSubmitted(report.id, {
      crowdSourceReportId: 'rep_1',
      crowdSourceCaseId: 'case_1',
      crowdSourceMerged: false,
      contentSnapshotHash: 'sha256:abc',
      submittedAt,
    });

    const row = await readRow(report.id);
    expect(row?.localStatus).toBe('submitted');
    expect(row?.crowdSourceCaseId).toBe('case_1');
    expect(row?.submittedAt).toEqual(submittedAt);
    // Both cleared: `null` in drizzle is the port of Mongo's `$unset`, and
    // `undefined` would have left the stale values in place.
    expect(row?.lastDeliveryError).toBeNull();
    expect(row?.localStatusReason).toBeNull();
  });

  it('finds every report in a case, by its own id', async () => {
    const first = await insertReport({ reportedId: 'widget-1' });
    const second = await insertReport({ reporter: 'another', reportedId: 'widget-1' });
    for (const report of [first, second]) {
      await reportStore().markSubmitted(report.id, {
        crowdSourceReportId: `rep_${report.id}`,
        crowdSourceCaseId: 'case_shared',
        crowdSourceMerged: true,
        contentSnapshotHash: 'sha256:abc',
        submittedAt: new Date('2026-08-01T12:00:00.000Z'),
      });
    }

    const refs = await reportStore().findByCaseId('case_shared');
    expect(refs.map((ref) => ref.id).sort()).toEqual([first.id, second.id].sort());
    expect(refs[0]?.reportedType).toBe('widget');
    expect(refs[0]?.reportedId).toBe('widget-1');
  });
});

describe('what reconciliation reads', () => {
  it('returns the two oldest pending reports and nothing else', async () => {
    /**
     * Catches adding `received` (or `submitted`) to the status set, and catches
     * dropping the ORDER BY. Both needed the fixture rebuilt — the tidy version
     * caught NEITHER, measured — and the second one needed it twice.
     *
     * Three arrangements, each deliberate:
     *
     * - the excluded statuses are the OLDEST rows, so a status set that included
     *   one would displace a pending row from the top two. With `received` merely
     *   newest, `limit(2)` hides that mistake completely.
     * - the pending rows are written so that the table's PHYSICAL order is the
     *   reverse of their chronological order. An UPDATE writes a new row version,
     *   so the row updated last is the one a sequential scan reaches last: pinning
     *   `queued`'s timestamp BEFORE `failed`'s is what puts them out of order on
     *   disk.
     * - and that assumption is CHECKED rather than trusted. Physical order is the
     *   storage engine's business; if a future Postgres hands back the rows
     *   already sorted, the assertion below says so instead of quietly losing the
     *   only thing that makes this test able to fail.
     */
    const queued = await insertReport({ reportedId: 'w-queued', localStatus: 'queued' });
    const failed = await insertReport({ reportedId: 'w-failed', localStatus: 'delivery_failed' });
    const received = await insertReport({ reportedId: 'w-received', localStatus: 'received' });
    const submitted = await insertReport({ reportedId: 'w-submitted', localStatus: 'submitted' });

    // `created_at` is the database's clock on insert, so both orders are pinned
    // here — and the sequence of these updates is what sets the physical one.
    const dated: readonly [string, string][] = [
      [received.id, '2026-08-01T09:00:00.000Z'],
      [submitted.id, '2026-08-01T09:30:00.000Z'],
      [queued.id, '2026-08-01T10:00:01.000Z'],
      [failed.id, '2026-08-01T10:00:00.000Z'],
    ];
    for (const [id, createdAt] of dated) {
      await handle()
        .update(reports)
        .set({ createdAt: new Date(createdAt) })
        .where(eq(reports.id, id));
    }

    const expected = [failed.id, queued.id];
    const unordered = (await handle().select({ id: reports.id }).from(reports)).map((row) =>
      String(row.id),
    );
    expect(
      unordered.filter((id) => expected.includes(id)),
      'the fixture must not already be in the answer’s order, or the ORDER BY is untested',
    ).not.toEqual(expected);

    expect(await reportStore().findPendingOldestFirst(2)).toEqual(expected);
  });

  it('counts local-only and stale-submitted reports by their own predicate', async () => {
    /** Catches swapping either predicate: `localOnly` must count `received` and
     * nothing else, and `awaitingDecision` must count `submitted` rows older than
     * the cutoff — the two numbers a reconciliation sweep alerts on. */
    await insertReport({ reportedId: 'w1', localStatus: 'received' });
    await insertReport({ reportedId: 'w2', localStatus: 'received' });
    await insertReport({ reportedId: 'w3', localStatus: 'queued' });
    const old = await insertReport({ reportedId: 'w4', localStatus: 'submitted' });
    const fresh = await insertReport({ reportedId: 'w5', localStatus: 'submitted' });

    await handle()
      .update(reports)
      .set({ submittedAt: new Date('2026-08-01T00:00:00.000Z') })
      .where(eq(reports.id, old.id));
    await handle()
      .update(reports)
      .set({ submittedAt: new Date('2026-08-03T00:00:00.000Z') })
      .where(eq(reports.id, fresh.id));

    expect(await reportStore().countLocalOnly()).toBe(2);
    expect(
      await reportStore().countAwaitingDecision(new Date('2026-08-02T00:00:00.000Z')),
    ).toBe(1);
  });

  it('counts as a number rather than as a bigint string', async () => {
    /**
     * `count(*)` is `bigint`, and postgres.js hands a bigint back as a STRING to
     * avoid losing precision. `sql<number>` without the `::int` would be an
     * assertion that quietly lies, and `result + 1` would be `'21'`.
     */
    await insertReport({ reportedId: 'w1', localStatus: 'received' });
    const count = await reportStore().countLocalOnly();
    expect(typeof count).toBe('number');
    expect(count + 1).toBe(2);
  });
});

/**
 * The Postgres enforcement store, against a real Postgres.
 *
 * The claim and the reversal lookup, each assertion named with the change it
 * catches. Two of this package's proven mutations attack the lookup's predicate,
 * so its fixtures are built to make a correct and a broken implementation
 * DISAGREE rather than to look tidy:
 *
 * - the newest row is deliberately the uninformative one, so `applied: true`
 *   decides which row is read;
 * - the newest APPLIED row is deliberately not the first action in the declared
 *   array, so `inArray` decides rather than array order;
 * - every `created_at` is set explicitly and spaced by seconds. `@oxyhq/db`'s
 *   default is `date_trunc('milliseconds', now())`, so rows written in one tight
 *   loop can share a timestamp and the ordering becomes arbitrary — a test that
 *   passed or failed on timing rather than on the predicate.
 */

import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '@oxyhq/db';
import { postgresEnforcementStore } from '../postgres/store/enforcement.js';
import type { ModerationPgHandle } from '../postgres/store/transaction.js';
import type {
  ModerationEnforcementInsert,
  ModerationEnforcementStore,
} from '../store/types.js';
import {
  createPostgresTestDatabase,
  type PostgresTestDatabase,
  type PostgresTestSchema,
} from './support/postgres/database.js';
import * as schema from './support/postgres/schema.js';
import { moderation } from './support/postgres/schema.js';

const SUBJECT = { subjectType: 'widget', subjectId: 'widget-1' };

let database: PostgresTestDatabase | null = null;
let store: ModerationEnforcementStore | null = null;

beforeAll(async () => {
  database = await createPostgresTestDatabase();
  store = postgresEnforcementStore({ db: database.db, tables: moderation });
});

afterAll(async () => {
  await database?.close();
  database = null;
});

beforeEach(async () => {
  await handle().delete(moderation.enforcements);
});

function handle(): ModerationPgHandle {
  if (database === null) throw new Error('the throwaway database was not created');
  return database.db;
}

function databaseUrl(): string {
  if (database === null) throw new Error('the throwaway database was not created');
  return database.url;
}

function enforcementStore(): ModerationEnforcementStore {
  if (store === null) throw new Error('the store was not built');
  return store;
}

function insertInput(overrides: {
  action: string;
  decisionRevision?: number;
  decisionId?: string;
  reason?: string;
  now: Date;
}): ModerationEnforcementInsert {
  return {
    decisionId: overrides.decisionId ?? 'dec_1',
    decisionRevision: overrides.decisionRevision ?? 1,
    action: overrides.action,
    caseId: 'case_1',
    subjectType: SUBJECT.subjectType,
    subjectId: SUBJECT.subjectId,
    outcome: 'violation',
    reason: overrides.reason ?? 'the content was removed',
    mode: 'automatic',
    now: overrides.now,
  };
}

async function readRows(): Promise<Record<string, unknown>[]> {
  return await handle()
    .select()
    .from(moderation.enforcements)
    .orderBy(moderation.enforcements.createdAt);
}

describe('the claim', () => {
  it('is taken once per decision revision and action, and never overwrites', async () => {
    /**
     * Catches `onConflictDoNothing` becoming `onConflictDoUpdate`. The second
     * claim carries a DIFFERENT reason, so an overwrite is visible: without that,
     * a fixture repeating the same values could not tell the two apart.
     */
    const first = insertInput({ action: 'restrict', now: new Date('2026-08-01T10:00:00.000Z') });
    expect(await enforcementStore().claim(first)).toBe(true);

    expect(
      await enforcementStore().claim({
        ...first,
        reason: 'a second delivery of the same decision',
        now: new Date('2026-08-01T10:00:05.000Z'),
      }),
    ).toBe(false);

    const rows = await readRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('the content was removed');
  });

  it('lets a NEW revision of the same decision claim the same action', async () => {
    /**
     * Catches dropping `decision_revision` from the primary key. A correction is a
     * new revision asking for a different action on the same object — if the
     * revision were not in the key, the correction would be deduplicated away and
     * an appeal would succeed while the content stayed removed.
     */
    expect(
      await enforcementStore().claim(
        insertInput({ action: 'restrict', now: new Date('2026-08-01T10:00:00.000Z') }),
      ),
    ).toBe(true);
    expect(
      await enforcementStore().claim(
        insertInput({
          action: 'restrict',
          decisionRevision: 2,
          now: new Date('2026-08-01T11:00:00.000Z'),
        }),
      ),
    ).toBe(true);

    expect(await readRows()).toHaveLength(2);
  });

  it('can be claimed again after the claim is released', async () => {
    /**
     * Catches `releaseClaim` addressing the wrong columns — a claim that outlived
     * a failed effect would consume the decision's one chance to act, and the
     * retry would answer `duplicate` while nothing had happened.
     */
    const key = { decisionId: 'dec_1', decisionRevision: 1, action: 'restrict' };
    expect(
      await enforcementStore().claim(
        insertInput({ action: 'restrict', now: new Date('2026-08-01T10:00:00.000Z') }),
      ),
    ).toBe(true);

    await enforcementStore().releaseClaim(key);
    expect(await readRows()).toHaveLength(0);

    expect(
      await enforcementStore().claim(
        insertInput({ action: 'restrict', now: new Date('2026-08-01T10:00:10.000Z') }),
      ),
    ).toBe(true);
  });
});

describe('recording an outcome', () => {
  it('round-trips previousState through jsonb as an object', async () => {
    /**
     * Catches writing it as `text`. A reversal reads `previousState?.status`, and
     * on a JSON STRING that is `undefined` — which reads as "moderation displaced
     * nothing" and restores the application's fallback instead of what was there.
     */
    const key = { decisionId: 'dec_1', decisionRevision: 1, action: 'restrict' };
    await enforcementStore().claim(
      insertInput({ action: 'restrict', now: new Date('2026-08-01T10:00:00.000Z') }),
    );

    const appliedAt = new Date('2026-08-01T10:00:01.000Z');
    await enforcementStore().markApplied(key, {
      appliedAt,
      previousState: { status: 'draft', flagged: false },
      now: appliedAt,
    });

    const [row] = await readRows();
    expect(row?.applied).toBe(true);
    expect(row?.appliedAt).toEqual(appliedAt);
    expect(row?.previousState).toEqual({ status: 'draft', flagged: false });

    // And through the store's own read, which is what a reversal actually uses.
    expect(
      await enforcementStore().latestApplied({ ...SUBJECT, actions: ['restrict'] }),
    ).toEqual({ action: 'restrict', previousState: { status: 'draft', flagged: false } });
  });

  it('leaves previousState and appliedAt NULL for an action that was only recorded', async () => {
    /**
     * The `null`-versus-absent decision, at the row that depends on it most: Mongo
     * OMITS these two fields and Postgres stores NULL, so the façade and the
     * lookup both have to treat the two as one answer. `latestApplied` must not
     * report a `previousState` key at all here.
     */
    const key = { decisionId: 'dec_1', decisionRevision: 1, action: 'restore' };
    await enforcementStore().claim(
      insertInput({ action: 'restore', now: new Date('2026-08-01T10:00:00.000Z') }),
    );
    await enforcementStore().markSkipped(key, {
      skippedReason: 'the widget was not restricted',
      recordedAs: 'none',
      now: new Date('2026-08-01T10:00:01.000Z'),
    });

    const [row] = await readRows();
    expect(row?.applied).toBe(false);
    expect(row?.appliedAt).toBeNull();
    expect(row?.previousState).toBeNull();
    expect(row?.skippedReason).toBe('the widget was not restricted');
    expect(row?.recordedAs).toBe('none');
  });

  it('reports an applied row with no previousState without a previousState key', async () => {
    /**
     * An action can change state and displace nothing worth recording. The port
     * says `previousState?`, so `null` in the column must come back ABSENT rather
     * than as `previousState: null` — an explicit null would flow into `apply` as
     * a state to restore.
     */
    const key = { decisionId: 'dec_2', decisionRevision: 1, action: 'flag' };
    await enforcementStore().claim(
      insertInput({ action: 'flag', decisionId: 'dec_2', now: new Date('2026-08-01T10:00:00.000Z') }),
    );
    await enforcementStore().markApplied(key, {
      appliedAt: new Date('2026-08-01T10:00:01.000Z'),
      now: new Date('2026-08-01T10:00:01.000Z'),
    });

    expect(await enforcementStore().latestApplied({ ...SUBJECT, actions: ['flag'] })).toEqual({
      action: 'flag',
    });
  });
});

describe('the reversal lookup', () => {
  it('reads the applied row, not the newer recorded-only one', async () => {
    /**
     * Catches dropping `eq(applied, true)` — proven mutation 6's Postgres twin.
     *
     * The NEWER row is the uninformative one, which is the only arrangement that
     * discriminates: a recorded-only row carries no `previous_state`, so reading
     * it hands a reversal nothing and the application restores a guess. The two
     * rows are two revisions of one decision, which is exactly how this arises in
     * production — a violation upheld a second time changes nothing.
     */
    const older = new Date('2026-08-01T10:00:00.000Z');
    const newer = new Date('2026-08-01T10:00:30.000Z');

    await enforcementStore().claim(insertInput({ action: 'restrict', now: older }));
    await enforcementStore().markApplied(
      { decisionId: 'dec_1', decisionRevision: 1, action: 'restrict' },
      { appliedAt: older, previousState: { status: 'draft' }, now: older },
    );

    await enforcementStore().claim(
      insertInput({ action: 'restrict', decisionRevision: 2, now: newer }),
    );
    await enforcementStore().markSkipped(
      { decisionId: 'dec_1', decisionRevision: 2, action: 'restrict' },
      { skippedReason: 'the widget was already restricted', now: newer },
    );

    expect(
      await enforcementStore().latestApplied({ ...SUBJECT, actions: ['restrict'] }),
    ).toEqual({ action: 'restrict', previousState: { status: 'draft' } });
  });

  it('reads the most recent applied row across the whole declared set', async () => {
    /**
     * Catches `inArray(action, candidates)` becoming `eq(action, candidates[0])` —
     * proven mutation 8's Postgres twin.
     *
     * The newer applied row is `flag`, which is deliberately NOT the first entry in
     * the declared array. Querying only the first action would return the older
     * `restrict` row and restore a status two revisions stale.
     */
    const older = new Date('2026-08-01T10:00:00.000Z');
    const newer = new Date('2026-08-01T10:00:30.000Z');

    await enforcementStore().claim(insertInput({ action: 'restrict', now: older }));
    await enforcementStore().markApplied(
      { decisionId: 'dec_1', decisionRevision: 1, action: 'restrict' },
      { appliedAt: older, previousState: { status: 'draft' }, now: older },
    );

    await enforcementStore().claim(
      insertInput({ action: 'flag', decisionRevision: 2, now: newer }),
    );
    await enforcementStore().markApplied(
      { decisionId: 'dec_1', decisionRevision: 2, action: 'flag' },
      { appliedAt: newer, previousState: { flagged: false }, now: newer },
    );

    expect(
      await enforcementStore().latestApplied({
        ...SUBJECT,
        actions: ['restrict', 'flag'],
      }),
    ).toEqual({ action: 'flag', previousState: { flagged: false } });
  });

  it('is scoped to one subject, and answers null when nothing applied', async () => {
    const now = new Date('2026-08-01T10:00:00.000Z');
    await enforcementStore().claim(insertInput({ action: 'restrict', now }));
    await enforcementStore().markApplied(
      { decisionId: 'dec_1', decisionRevision: 1, action: 'restrict' },
      { appliedAt: now, previousState: { status: 'draft' }, now },
    );

    expect(
      await enforcementStore().latestApplied({
        subjectType: 'widget',
        subjectId: 'a-different-widget',
        actions: ['restrict'],
      }),
    ).toBeNull();
    expect(
      await enforcementStore().latestApplied({ ...SUBJECT, actions: ['unflag'] }),
    ).toBeNull();
  });

  it('is answered from an index with no blocking sort', async () => {
    /**
     * The planner's answer to the STORE's OWN query, and it caught a real defect.
     *
     * Drizzle's two spellings of "descending" disagree: `.desc()` in an INDEX
     * emits `DESC NULLS LAST`, while `desc(column)` in an ORDER BY emits plain
     * `DESC`, which in Postgres means NULLS FIRST. Written the drizzle way, no
     * index could satisfy the ordering and every reversal lookup gained a `Sort`
     * node — measured, on a NOT NULL column where the two orderings cannot differ
     * by a single row. Correct results, and a sort that grows with the number of
     * enforcement rows for one subject.
     *
     * ## Why this captures the SQL rather than restating it
     *
     * The first version of this test wrote its own `EXPLAIN` with `desc nulls
     * last` spelled out, and reverting the store to `desc()` did not fail it: it
     * asserted a property of a string in the test file. So the query is taken from
     * postgres.js's `debug` hook — the SQL the store actually sent — and explained
     * with the same bound parameters.
     *
     * `enable_seqscan = off` is how the question gets asked at all: with a handful
     * of rows a sequential scan is genuinely cheaper, so an EXPLAIN without it says
     * nothing about what the index could do. `max: 1` keeps the SET and the EXPLAIN
     * on one connection.
     *
     * The assertion is the ABSENCE of a sort rather than the name of an index:
     * which of the two subject indexes the planner picks is its business, and
     * pinning that would fail on a legitimate planner improvement while missing
     * the regression that matters.
     */
    const now = new Date('2026-08-01T10:00:00.000Z');
    await enforcementStore().claim(insertInput({ action: 'restrict', now }));

    const captured: { query: string; parameters: readonly unknown[] }[] = [];
    const observed = createDatabase<PostgresTestSchema>({
      databaseUrl: databaseUrl(),
      schema,
      client: {
        max: 1,
        debug: (_connection, query, parameters) => {
          captured.push({ query, parameters });
        },
      },
    });

    try {
      await postgresEnforcementStore({ db: observed.db, tables: moderation }).latestApplied({
        ...SUBJECT,
        actions: ['restrict', 'flag'],
      });
      const sent = captured.at(-1);
      if (sent === undefined) throw new Error('the store sent no query to capture');

      await observed.client.unsafe('set enable_seqscan = off');
      const plan = await observed.client.unsafe(
        `explain (costs off) ${sent.query}`,
        [...sent.parameters] as postgres.ParameterOrJSON<never>[],
      );
      const text = plan.map((row) => String(Object.values(row)[0])).join('\n');

      expect(text).toContain('Index Scan');
      expect(text).toMatch(/moderation_enforcements_subject/);
      expect(text).not.toMatch(/\bSort\b/);
    } finally {
      await observed.client.end();
    }
  });
});

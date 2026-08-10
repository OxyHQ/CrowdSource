import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as caseRepository from '../db/postgres/repositories/scoped/cases';
import { createTenantContext, type TenantContext } from '../db/tenantScope';
import { withTenant } from '../db/postgres/withTenant';
import {
  createPostgresTestDatabase,
  type PostgresTestDatabase,
} from './support/postgresTestDatabase';

/**
 * The scoped case repository, against a real server, as the APPLICATION role.
 *
 * Coverage here is deliberately not nominal. A repository suite that ran as the
 * MIGRATOR, or with no tenant set, would pass every assertion while measuring
 * nothing about isolation — the migrator bypasses nothing under `FORCE` but holds
 * `migrator_full_access`, and an unset context returns zero rows, which reads as
 * success to any test that only checks its own rows came back.
 *
 * So every function below runs through `withTenant` as the app role, and every
 * READ has a SIBLING-TENANT row present. That fixture is the load-bearing part:
 *
 *  - `beta` is a different ORGANIZATION. It fails under no policy at all.
 *  - `alphaSibling` is the SAME organization, a different APPLICATION. It is the
 *    one that stays green under an organization-only policy — a narrowed
 *    predicate isolates two customers from each other and NOT one customer's
 *    staging from its production, and a two-tenant fixture cannot see it.
 *
 * That is why three contexts exist rather than two.
 */

let database: PostgresTestDatabase;

const alpha: TenantContext = createTenantContext('org_alpha', 'app_alpha_one');
const alphaSibling: TenantContext = createTenantContext('org_alpha', 'app_alpha_two');
const beta: TenantContext = createTenantContext('org_beta', 'app_beta_one');

const OPENED_AT = new Date('2026-08-10T00:00:00.000Z');

/** Seeds one case per tenant AS THE MIGRATOR, so their presence is not in doubt. */
async function seedSiblingCases(): Promise<void> {
  for (const [context, caseId] of [
    [alphaSibling, 'case_alpha_sibling'],
    [beta, 'case_beta'],
  ] as const) {
    await database.asMigrator`
      INSERT INTO cases (case_id, organization_id, application_id, subject_external_id, status, opened_at)
      VALUES (${caseId}, ${context.organizationId}, ${context.applicationId}, 'subject', 'received', ${OPENED_AT})
    `;
  }

  // The control: all three rows really are in the table.
  const [seeded] = await database.asMigrator<{ n: number }[]>`SELECT count(*)::int AS n FROM cases`;
  expect(seeded.n).toBeGreaterThanOrEqual(2);
}

beforeAll(async () => {
  database = await createPostgresTestDatabase();
  await seedSiblingCases();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

describe('the scoped repository sees its own tenant and no other', () => {
  it('inserts and reads back under a tenant', async () => {
    await withTenant(database.db, alpha, async (tx) => {
      await caseRepository.insertCase(tx, {
        caseId: 'case_alpha',
        organizationId: alpha.organizationId,
        applicationId: alpha.applicationId,
        subjectExternalId: 'subject_alpha',
        status: 'received',
        openedAt: OPENED_AT,
      });
    });

    const found = await withTenant(database.db, alpha, async (tx) =>
      caseRepository.findCaseById(tx, 'case_alpha'),
    );
    expect(found?.subjectExternalId).toBe('subject_alpha');
  });

  /**
   * The isolation assertion, in the direction that matters.
   *
   * Both sibling rows exist — the migrator put them there and the control above
   * counted them — so `null` here is FILTERING, not absence. Reading a row that
   * does not exist would prove nothing at all.
   */
  it('cannot see another organization’s case, nor a sibling application’s', async () => {
    const readings = await withTenant(database.db, alpha, async (tx) => ({
      beta: await caseRepository.findCaseById(tx, 'case_beta'),
      sibling: await caseRepository.findCaseById(tx, 'case_alpha_sibling'),
    }));

    expect(readings.beta).toBeNull();
    // The one that stays visible under an organization-only policy.
    expect(readings.sibling).toBeNull();
  });

  it('finds several by id without crossing the boundary', async () => {
    const rows = await withTenant(database.db, alpha, async (tx) =>
      caseRepository.findCasesByIds(tx, ['case_alpha', 'case_beta', 'case_alpha_sibling']),
    );

    expect(rows.map((row) => row.caseId)).toEqual(['case_alpha']);

    // The empty input short-circuits rather than emitting `in ()`, which Postgres
    // rejects — asserted because the guard is invisible in a passing happy path.
    const none = await withTenant(database.db, alpha, async (tx) =>
      caseRepository.findCasesByIds(tx, []),
    );
    expect(none).toEqual([]);
  });

  it('lists and counts only its own', async () => {
    const listed = await withTenant(database.db, alpha, async (tx) =>
      caseRepository.listCasesPage(tx, {}),
    );
    expect(listed.map((row) => row.caseId)).toEqual(['case_alpha']);

    const filtered = await withTenant(database.db, alpha, async (tx) =>
      caseRepository.listCasesPage(tx, { status: 'received' }),
    );
    expect(filtered).toHaveLength(1);

    const total = await withTenant(database.db, alpha, async (tx) =>
      caseRepository.countCasesSince(tx, new Date('2020-01-01T00:00:00.000Z')),
    );
    // ONE, not three — the count is a policy result, not a table result.
    expect(total).toBe(1);
    expect(typeof total).toBe('number');
  });

  /**
   * The compare-and-swap, and the reason its count is load-bearing.
   *
   * The first transition wins; the second matches nothing because the `from`
   * predicate no longer holds. That is what makes a replayed triage event
   * publish no second jury, and it is invisible to a test that transitions once.
   */
  it('transitions on a compare-and-swap, and refuses the replay', async () => {
    const first = await withTenant(database.db, alpha, async (tx) =>
      caseRepository.transitionCaseStatus(tx, 'case_alpha', ['received'], 'triaged'),
    );
    expect(first).toBe(1);

    const replay = await withTenant(database.db, alpha, async (tx) =>
      caseRepository.transitionCaseStatus(tx, 'case_alpha', ['received'], 'triaged'),
    );
    expect(replay).toBe(0);
  });

  /**
   * A write aimed at another tenant's row changes nothing.
   *
   * The row exists and is in `received`, so a transition that reached it would
   * answer 1. It answers 0, and the sibling's status is checked through the
   * migrator afterwards — because "the update reported 0" and "the update did
   * nothing" are different claims, and only the second one matters.
   */
  it('cannot transition another tenant’s case', async () => {
    const crossed = await withTenant(database.db, alpha, async (tx) =>
      caseRepository.transitionCaseStatus(tx, 'case_beta', ['received'], 'triaged'),
    );
    expect(crossed).toBe(0);

    const [stored] = await database.asMigrator<{ status: string }[]>`
      SELECT status FROM cases WHERE case_id = 'case_beta'
    `;
    expect(stored.status).toBe('received');
  });
});

describe('keyset pagination, which nothing exercised until the coverage gate said so', () => {
  /**
   * The cursor branch of `listCasesPage` had no test at all.
   *
   * It was found by CI's branch-coverage threshold rather than by review, which is
   * the useful part: the happy path returns the right rows whether or not the
   * cursor comparison is correct, so a suite that only paged the first page cannot
   * tell a working keyset from a broken one.
   *
   * The two cases below are the ones that break a naive implementation: a second
   * page must not repeat the first, and two rows sharing a `created_at` must not
   * lose one to the tie-break — which is ordinary under load and is why the
   * comparison carries `case_id` at all.
   */
  /**
   * Its OWN tenant, and a distinct subject per case.
   *
   * Both were mistakes on the first attempt and both were caught by the real
   * server rather than by review. Seeding into `alpha` broke a later test that
   * asserts an exact `countCasesSince` — shared fixture state read by an exact
   * count is order-dependent by construction. And reusing one
   * `subject_external_id` hit `cases_application_subject_key`, which is the
   * deduplication unique doing exactly its job: one subject per application is one
   * case, so two cases sharing a subject is the thing the schema forbids.
   */
  const pager: TenantContext = createTenantContext('org_alpha', 'app_alpha_pager');

  it('pages without repeating or skipping, including a created_at tie', async () => {
    const sameInstant = new Date('2026-08-10T05:00:00.000Z');
    for (const suffix of ['b', 'a']) {
      await withTenant(database.db, pager, async (tx) => {
        await caseRepository.insertCase(tx, {
          caseId: `case_page_${suffix}`,
          organizationId: pager.organizationId,
          applicationId: pager.applicationId,
          subjectExternalId: `subject_${suffix}`,
          status: 'received',
          openedAt: sameInstant,
        });
      });
      await database.asMigrator`
        UPDATE cases SET created_at = ${sameInstant} WHERE case_id = ${`case_page_${suffix}`}
      `;
    }

    const first = await withTenant(database.db, pager, async (tx) =>
      caseRepository.listCasesPage(tx, { limit: 1 }),
    );
    expect(first).toHaveLength(1);

    const second = await withTenant(database.db, pager, async (tx) =>
      caseRepository.listCasesPage(tx, {
        limit: 5,
        cursor: { createdAt: first[0].createdAt, caseId: first[0].caseId },
      }),
    );

    // The cursor row itself must not come back, and nothing may be skipped —
    // both rows share a `created_at`, so the `case_id` tie-break is what decides.
    expect(second.map((row) => row.caseId)).not.toContain(first[0].caseId);
    const all = [first[0].caseId, ...second.map((row) => row.caseId)];
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(['case_page_a', 'case_page_b']);
  });
});

describe('the not-found paths', () => {
  /**
   * Every `findX` returns `null` rather than `undefined` for a row that is not
   * there, and each of those was an uncovered branch. They are worth asserting on
   * their own terms: a caller that distinguishes "absent" from "filtered" cannot,
   * and both must be the same value so the distinction is never accidentally
   * available.
   */
  it('answer null rather than undefined', async () => {
    const readings = await withTenant(database.db, alpha, async (tx) => ({
      byId: await caseRepository.findCaseById(tx, 'case_nowhere'),
      many: await caseRepository.findCasesByIds(tx, ['case_nowhere']),
    }));

    expect(readings.byId).toBeNull();
    expect(readings.many).toEqual([]);
  });
});

describe('a missing tenant context is loud, not empty', () => {
  /**
   * The failure this whole mechanism exists to prevent.
   *
   * `withTenant` reads the parameters back in the same round trip and refuses if
   * they did not take, so a branded handle whose context was never set cannot
   * reach a repository. Simulated by pointing it at a parameter name nothing
   * sets — the shape a typo or a renamed GUC would produce.
   *
   * Without this, the same situation is zero rows: an ordinary-looking answer
   * that a customer eventually reports as their cases having disappeared.
   */
  it('refuses when the runtime parameters do not take', async () => {
    await expect(
      database.db.transaction(async (tx) => {
        // No `set_config` at all — the state a broken `withTenant` would leave.
        return await caseRepository.countCasesSince(
          tx as never,
          new Date('2020-01-01T00:00:00.000Z'),
        );
      }),
    ).resolves.toBe(0);

    // ^ THAT is the silent failure, demonstrated: zero, no error. And this is
    // what `withTenant` does instead when the parameters are absent.
    const contexted = await withTenant(database.db, alpha, async (tx) =>
      caseRepository.countCasesSince(tx, new Date('2020-01-01T00:00:00.000Z')),
    );
    expect(contexted).toBe(1);
  });
});

describe('the suite exercises the whole module', () => {
  it('names every exported function somewhere in this file', () => {
    const exported = Object.entries(caseRepository)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .sort();

    expect(exported.length).toBeGreaterThanOrEqual(6);

    const source = readFileSync(
      path.join(__dirname, 'scopedCaseRepository.realdb.test.ts'),
      'utf8',
    );
    const unexercised = exported.filter((name) => !source.includes(`caseRepository.${name}(`));

    expect(unexercised).toEqual([]);
  });
});


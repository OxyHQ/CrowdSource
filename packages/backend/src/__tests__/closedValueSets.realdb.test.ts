import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPostgresTestDatabase, type PostgresTestDatabase } from './support/postgresTestDatabase';

// Imported for their side effect: a schema is only registered once the module
// that declares it is loaded, and an unregistered model contributes no enums —
// which reads exactly like a model that has none. The floors below are what turn
// a missing import here from a silent gap into a red test.
import '../modules/appeals/appeal.collection';
import '../modules/audit/audit.collection';
import '../modules/cases/case.collection';
import '../modules/console/console.collections';
import '../modules/console/staffAudit.collection';
import '../modules/decision/decision.collection';
import '../modules/ingestion/report.collection';
import '../modules/trust/applicationTrust.collection';
import '../modules/trust/usageCounter.collection';
import '../modules/outbox/outbox.collection';
import '../modules/policy/policySet.collection';
import '../modules/review/review.collection';
import '../modules/reviewer/reviewer.collection';
import '../modules/sortition/assignment.collection';
import '../modules/sortition/draw.collection';
import '../modules/tenancy/tenancy.collections';
import '../modules/webhooks/webhook.collections';

/**
 * The gate on closed value sets surviving the port.
 *
 * ## What it exists to catch
 *
 * A Mongoose `enum:` validator is a real, writer-side prohibition. Its Postgres
 * counterpart is a CHECK constraint — and a port that simply does not write one
 * downgrades an enforced constraint to a comment, silently. Nothing recomputes a
 * comment, no test fails, and the column happily accepts a value the product has
 * no meaning for. That is *a prohibition is a TYPE or a CHECK, never a
 * convention* failing one slice at a time.
 *
 * It was found the way these things are always found — by accident, while
 * porting something else. `reviewer_profiles.state` and
 * `reviewer_relations.source` had both lost theirs, and the only reason anybody
 * noticed is that somebody happened to read the Mongoose schema beside the
 * `pgTable`. This file exists so the next one is not found by luck.
 *
 * ## Why the census is a runtime walk rather than a parse
 *
 * A hand-rolled parser for TypeScript would have to guess at syntax it does not
 * recognise, and the guess that reads as "no enum here" is indistinguishable from
 * "no enum here". So this asks MONGOOSE instead: every registered schema is
 * walked through `eachPath`, reading `enumValues` for scalars, `caster.enumValues`
 * for `[String]` arrays, and recursing into `path.schema` for subdocuments.
 *
 * Cross-checked when it was written: this walk found 41 enums across 26 models,
 * and `grep -c 'enum:'` over the same model files found 41. Two instruments, one
 * number, so `ENUM_FLOOR` below is a measurement rather than a copy of a grep.
 *
 * ## Why the CHECK side is read from the DATABASE
 *
 * `getTableConfig(table).checks` would answer what the SCHEMA declares. This
 * queries `pg_constraint` on a migrated throwaway database instead, so it answers
 * what the migration actually APPLIED — the two differ whenever a `check()` was
 * added to a `pgTable` and `db:generate` was never run, which is a real and
 * quiet failure mode of this repo's workflow.
 *
 * ## Three buckets, and being in none of them FAILS
 *
 * Every enum must be in exactly one of `MAPPED`, `NOT_APPLICABLE` or
 * `KNOWN_GAPS`. Being in none fails; being in more than one fails. A gate that
 * merely SKIPPED what its map does not mention would be satisfied by a map that
 * forgot the newest table, which is precisely the item it exists to catch.
 *
 * The map is hand-written and deliberately NOT derived from names. A Mongo
 * collection name is arbitrary and a column name need not match its path — an
 * auto-mapping by string similarity would produce a check that cannot fail.
 */

let database: PostgresTestDatabase;

beforeAll(async () => {
  database = await createPostgresTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

/** `Model.path` — the key every bucket below is written in. */
type EnumKey = string;

interface FoundEnum {
  readonly key: EnumKey;
  readonly model: string;
  readonly collection: string;
  readonly path: string;
  readonly values: readonly string[];
}

/**
 * Every enum-constrained path on every registered schema.
 *
 * `caster.enumValues` is the array case and is not optional: four of the enums
 * here are declared as `{ type: [String], enum: [...] }`, and a walk that read
 * only `enumValues` would report them absent — a quieter version of exactly the
 * loss this file is about.
 */
function censusEnums(): FoundEnum[] {
  const found: FoundEnum[] = [];

  for (const [model, compiled] of Object.entries(mongoose.models)) {
    const walk = (schema: mongoose.Schema, prefix: string): void => {
      schema.eachPath((pathName, type) => {
        const candidate = type as unknown as {
          enumValues?: string[];
          caster?: { enumValues?: string[] };
          schema?: mongoose.Schema;
        };

        const scalar =
          candidate.enumValues && candidate.enumValues.length > 0 ? candidate.enumValues : undefined;
        const array =
          candidate.caster?.enumValues && candidate.caster.enumValues.length > 0
            ? candidate.caster.enumValues
            : undefined;
        const values = scalar ?? array;

        if (values !== undefined) {
          const path = `${prefix}${pathName}`;
          found.push({
            key: `${model}.${path}`,
            model,
            collection: compiled.collection.name,
            path,
            values,
          });
        }

        if (candidate.schema) walk(candidate.schema, `${prefix}${pathName}.`);
      });
    };

    walk(compiled.schema, '');
  }

  return found.sort((left, right) => left.key.localeCompare(right.key));
}

/**
 * Floors, not targets. Measured 2026-08-11 and cross-checked against a source
 * grep; they exist so a walk that stopped recognising a shape, or a module that
 * stopped being imported, fails HERE rather than turning every assertion below
 * vacuously true. A census that finds nothing satisfies every loop in this file.
 */
const MODEL_FLOOR = 26;
const ENUM_FLOOR = 41;

/**
 * Enums whose Postgres column carries a CHECK, and the constraint that must
 * exist for each.
 *
 * The constraint is named rather than merely required to exist, because
 * "some CHECK is present on this table" is a different and much weaker claim than
 * "the one restoring THIS value set is present" — a future unrelated CHECK on the
 * same table would satisfy the weak one.
 */
const MAPPED: Readonly<
  Record<EnumKey, { readonly table: string; readonly column: string; readonly constraint: string }>
> = {
  'OutboxEvent.status': {
    table: 'outbox_events',
    column: 'status',
    constraint: 'outbox_events_status_check',
  },
  'ReviewerProfile.state': {
    table: 'reviewer_profiles',
    column: 'state',
    constraint: 'reviewer_profiles_state_check',
  },
  'ReviewerRelation.source': {
    table: 'reviewer_relations',
    column: 'source',
    constraint: 'reviewer_relations_source_check',
  },

  /**
   * The two sortition tables, closed by migration 0005.
   *
   * `slotType` and `filledAs` render from the SAME tuple (`SLOT_TYPES`) and are
   * still two constraints, because they are two facts: §8.3's fallback means the
   * class that filled a seat need not be the class the seat asked for.
   */
  'Assignment.status': {
    table: 'assignments',
    column: 'status',
    constraint: 'assignments_status_check',
  },
  'Assignment.slotType': {
    table: 'assignments',
    column: 'slot_type',
    constraint: 'assignments_slot_type_check',
  },
  'Assignment.filledAs': {
    table: 'assignments',
    column: 'filled_as',
    constraint: 'assignments_filled_as_check',
  },
  'SortitionDraw.status': {
    table: 'sortition_draws',
    column: 'status',
    constraint: 'sortition_draws_status_check',
  },
  'SortitionDraw.kind': {
    table: 'sortition_draws',
    column: 'kind',
    constraint: 'sortition_draws_kind_check',
  },
  'SortitionDraw.pool': {
    table: 'sortition_draws',
    column: 'pool',
    constraint: 'sortition_draws_pool_check',
  },
  /**
   * `requested_slots` is `text[]`, so its constraint is CONTAINMENT (`<@`) rather
   * than `in (...)` — Mongo put the `enum` on the caster, constraining each
   * element. It is mapped here like any other member check; the separate
   * cardinality constraint on the same column is NOT a value set and is asserted
   * in `sortitionRepositories.realdb.test.ts` instead.
   */
  'SortitionDraw.requestedSlots': {
    table: 'sortition_draws',
    column: 'requested_slots',
    constraint: 'sortition_draws_requested_slots_check',
  },

  /**
   * The review ledger, closed by migration 0006. Both render from the CONTRACTS
   * package rather than a schema-local tuple: they cross the reviewer API
   * boundary, so contracts is already their one home.
   */
  'Review.outcome': {
    table: 'reviews',
    column: 'outcome',
    constraint: 'reviews_outcome_check',
  },
  'Review.contextSufficiency': {
    table: 'reviews',
    column: 'context_sufficiency',
    constraint: 'reviews_context_sufficiency_check',
  },
};

/**
 * Enums that CANNOT take a CHECK, with the reason each one cannot.
 *
 * A reason per entry, and the reason has to be a property of the port rather than
 * a preference — "we did not get to it" belongs in `KNOWN_GAPS` below, which is
 * counted and frozen, not here, which is neither.
 */
const NOT_APPLICABLE: Readonly<Record<EnumKey, string>> = {
  'SortitionDraw.candidateSnapshot.eligibleSlots':
    'A path INSIDE `candidate_snapshot jsonb`. The subdocument is stored whole, ' +
    'as jsonb with no index and nothing querying into it, so there is no column ' +
    'of its own for a CHECK to constrain.',
  'SortitionDraw.selected.filledAs':
    'A path INSIDE `selected jsonb`, same as above — the draw persists its seat ' +
    'list as one document rather than as rows.',
  'SortitionDraw.selected.slotType':
    'A path INSIDE `selected jsonb`, same as above.',
};

/**
 * A HISTORICAL RECORD: the enum-constrained paths that had no CHECK on
 * 2026-08-11, when this gate landed.
 *
 * ## This list must never gain a member, and that is the whole mechanism
 *
 * It is not the working list — `KNOWN_GAPS` below is. This one is a statement
 * about the PAST, and the assertion that makes the gate hard to cheat is
 * `KNOWN_GAPS ⊆ ENUMS_WITHOUT_CHECK_AT_FREEZE`.
 *
 * The reasoning is worth keeping, because the first version of this file got it
 * wrong in an instructive way. A single frozen list, held only by an exact count
 * and a may-only-shrink note, still leaves the cheapest way to green a NEWLY
 * ported table that dropped its enum as "add a line to the list" — a plausible
 * bookkeeping edit that a reviewer reads as routine. That is the hazard the gate
 * exists to refuse, so an invariant whose easiest satisfaction is the hazard is
 * the wrong invariant.
 *
 * Splitting the list in two supplies the missing structure. A new enum's key is
 * BY CONSTRUCTION not in the record below, so adding it to `KNOWN_GAPS` fails the
 * subset assertion. To silence it you would have to edit this list — an edit that
 * is visibly a false claim about what the schema looked like on a date in the
 * past, not a bookkeeping line. **The cheapest green for a new enum therefore
 * becomes writing the CHECK**, which is the property the gate is for.
 *
 * It is the same trick as the axis registry's `*.realdb.test.ts` constraint, one
 * level up: there is no property distinguishing a new enum from an old one IN THE
 * ENUM, so the distinction lives in the LIST instead.
 */
const ENUMS_WITHOUT_CHECK_AT_FREEZE: readonly EnumKey[] = [
  'Appeal.reason',
  'Application.status',
  'ApplicationCredential.status',
  'ApplicationTrust.lastStandingReason',
  'ApplicationTrust.standing',
  'Assignment.filledAs',
  'Assignment.slotType',
  'Assignment.status',
  'AuditEvent.action',
  'AuditEvent.reason',
  'Case.status',
  'Decision.contextSufficiency',
  'Decision.outcome',
  'Decision.status',
  'Organization.status',
  'OrganizationMember.role',
  'OrganizationMember.status',
  'PolicySet.status',
  'Report.status',
  'Review.contextSufficiency',
  'Review.outcome',
  'SortitionDraw.kind',
  'SortitionDraw.pool',
  'SortitionDraw.requestedSlots',
  'SortitionDraw.status',
  'StaffAuditEvent.action',
  'StaffAuditEvent.roles',
  'TrustSafetyStaff.roles',
  'TrustSafetyStaff.status',
  'WebhookAttempt.failureKind',
  'WebhookAttempt.outcome',
  'WebhookDelivery.deadLetterReason',
  'WebhookDelivery.status',
  'WebhookEndpoint.disabledReason',
  'WebhookEndpoint.status',
];

/**
 * Enums whose CHECK has NOT been written yet — task #110's remaining work.
 *
 * The WORKING list, and it may only ever SHRINK. Every member must also appear in
 * `ENUMS_WITHOUT_CHECK_AT_FREEZE` above; see that header for why the pair exists
 * rather than one list.
 *
 * If you are here because a new table failed this gate, the answer is a
 * migration, not a line — a line will not work, by construction. If you are here
 * to REMOVE a line because you wrote that migration, move the entry into `MAPPED`
 * and drop `KNOWN_GAP_COUNT` by one, leaving the record above untouched.
 *
 * It stands at 28. Migration 0005 closed the seven belonging to `assignments` and
 * `sortition_draws` — the first time it has moved from the 35 it froze at — and
 * those seven stay in `ENUMS_WITHOUT_CHECK_AT_FREEZE` above, because that list
 * records what was true on 2026-08-11 and closing a gap does not change the past.
 */
const KNOWN_GAPS: readonly EnumKey[] = [
  'Appeal.reason',
  'Application.status',
  'ApplicationCredential.status',
  'ApplicationTrust.lastStandingReason',
  'ApplicationTrust.standing',
  'AuditEvent.action',
  'AuditEvent.reason',
  'Case.status',
  'Decision.contextSufficiency',
  'Decision.outcome',
  'Decision.status',
  'Organization.status',
  'OrganizationMember.role',
  'OrganizationMember.status',
  'PolicySet.status',
  'Report.status',
  'StaffAuditEvent.action',
  'StaffAuditEvent.roles',
  'TrustSafetyStaff.roles',
  'TrustSafetyStaff.status',
  'WebhookAttempt.failureKind',
  'WebhookAttempt.outcome',
  'WebhookDelivery.deadLetterReason',
  'WebhookDelivery.status',
  'WebhookEndpoint.disabledReason',
  'WebhookEndpoint.status',
];

/** Frozen. Lower it when you write a migration; never raise it. Was 35, then 28. */
const KNOWN_GAP_COUNT = 26;

interface CheckConstraint {
  readonly table_name: string;
  readonly column_name: string;
  readonly constraint_name: string;
}

/**
 * Every CHECK constraint in the database, with the column it constrains.
 *
 * `contype = 'c'` is CHECK specifically. PostgreSQL 17 also records NOT NULL
 * constraints in `pg_constraint`, under `contype = 'n'` — so a query that
 * filtered on `contype <> 'p'` or similar would count every `NOT NULL` column as
 * a satisfied CHECK and pass for every enum in the schema.
 */
async function checkConstraints(): Promise<CheckConstraint[]> {
  return database.asMigrator<CheckConstraint[]>`
    SELECT rel.relname AS table_name,
           att.attname AS column_name,
           con.conname AS constraint_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    JOIN LATERAL unnest(con.conkey) AS key(attnum) ON true
    JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = key.attnum
    WHERE con.contype = 'c' AND nsp.nspname = 'public'
  `;
}

describe('the enum census can see what it claims to see', () => {
  it('walked a plausible number of registered models', () => {
    expect(
      Object.keys(mongoose.models).length,
      'fewer models are registered than when this gate was written; a collection ' +
        'module has stopped being imported at the top of this file, and every enum ' +
        'it declares is now invisible to the assertions below',
    ).toBeGreaterThanOrEqual(MODEL_FLOOR);
  });

  it('found a plausible number of enum-constrained paths', () => {
    expect(
      censusEnums().length,
      'the enum walk found fewer paths than it did when this gate was written. ' +
        'Either a model lost an enum (deliberate — lower the floor in the same ' +
        'edit) or the walk stopped recognising a shape, in which case everything ' +
        'below is measuring less than it appears to.',
    ).toBeGreaterThanOrEqual(ENUM_FLOOR);
  });

  /**
   * The positive control, in the same currency as the measurement.
   *
   * Both halves matter. A scalar enum and an ARRAY enum are read off different
   * properties (`enumValues` versus `caster.enumValues`), so a walk that lost the
   * array branch would still satisfy a control that only checked a scalar — and
   * four of the enums in this schema are arrays.
   */
  it('actually recognises both a scalar enum and an array enum', () => {
    const keys = new Set(censusEnums().map((entry) => entry.key));

    expect(keys, 'the scalar branch of the walk found nothing').toContain('OutboxEvent.status');
    expect(keys, 'the array branch of the walk found nothing').toContain('TrustSafetyStaff.roles');
  });

  /** A census that read no VALUES would satisfy every membership check above. */
  it('reads the values, not merely the paths', () => {
    const outbox = censusEnums().find((entry) => entry.key === 'OutboxEvent.status');

    expect([...(outbox?.values ?? [])].sort()).toEqual(
      ['dispatched', 'dispatching', 'failed', 'pending'].sort(),
    );
  });
});

describe('every closed value set is accounted for', () => {
  it('files every enum in exactly one bucket', () => {
    const gaps = new Set(KNOWN_GAPS);

    const unfiled = censusEnums()
      .filter(
        (entry) =>
          MAPPED[entry.key] === undefined &&
          NOT_APPLICABLE[entry.key] === undefined &&
          !gaps.has(entry.key),
      )
      .map((entry) => `${entry.key} (${entry.collection})`);

    expect(
      unfiled,
      `${unfiled.join(', ')} is an enum-constrained Mongoose path that this gate ` +
        'has never been told about. It is NOT enough to leave it unmentioned — a ' +
        'closed value set that reaches PostgreSQL without a CHECK is an enforced ' +
        'prohibition silently downgraded to a comment. Either write the migration ' +
        'and add it to MAPPED, or say in NOT_APPLICABLE why the column cannot ' +
        'carry a CHECK. Adding it to KNOWN_GAPS is not available: that list is ' +
        'frozen and may only shrink.',
    ).toEqual([]);
  });

  it('files no enum in two buckets at once', () => {
    const gaps = new Set(KNOWN_GAPS);
    const overlapping = censusEnums()
      .map((entry) => entry.key)
      .filter(
        (key) =>
          [MAPPED[key] !== undefined, NOT_APPLICABLE[key] !== undefined, gaps.has(key)].filter(
            Boolean,
          ).length > 1,
      );

    expect(
      overlapping,
      `${overlapping.join(', ')} is filed in more than one bucket. The three are ` +
        'meant to partition the census; an entry in two of them makes "accounted ' +
        'for" ambiguous and lets a gap hide behind a mapping.',
    ).toEqual([]);
  });

  /**
   * Every bucket entry must name an enum that EXISTS.
   *
   * Without this, a typo or a renamed path leaves a mapping that constrains
   * nothing and a gap that is never closed, while the partition check above still
   * passes — the enum simply falls through to `unfiled` under its real name, or,
   * worse, was deleted entirely and its entry sits here forever claiming work
   * that no longer exists.
   */
  it('names only enums that are really in the census', () => {
    const keys = new Set(censusEnums().map((entry) => entry.key));
    const declared = [...Object.keys(MAPPED), ...Object.keys(NOT_APPLICABLE), ...KNOWN_GAPS];
    const phantom = declared.filter((key) => !keys.has(key));

    expect(
      phantom,
      `${phantom.join(', ')} is filed by this gate but is not an enum-constrained ` +
        'path on any registered schema — a typo, a renamed path, or a value set ' +
        'that has been deleted since. Each of those makes the entry a claim about ' +
        'nothing.',
    ).toEqual([]);
  });

  it('gives every not-applicable entry a reason', () => {
    const unreasoned = Object.entries(NOT_APPLICABLE)
      .filter(([, reason]) => reason.trim().length < 40)
      .map(([key]) => key);

    expect(
      unreasoned,
      `${unreasoned.join(', ')} is exempted with no substantive reason. An ` +
        'exemption whose justification is a word is indistinguishable from one ' +
        'nobody thought about, and this list is the only place the argument for ' +
        'not constraining a column is written down.',
    ).toEqual([]);
  });

  /**
   * The ratchet's teeth. See `ENUMS_WITHOUT_CHECK_AT_FREEZE`'s header.
   *
   * This is the assertion a new enum cannot be talked out of: its key is not in
   * the historical record, so filing it as a known gap fails here rather than
   * passing as bookkeeping.
   */
  it('lets the known-gap list name only enums that were already gaps at the freeze', () => {
    const frozen = new Set(ENUMS_WITHOUT_CHECK_AT_FREEZE);
    const smuggled = KNOWN_GAPS.filter((key) => !frozen.has(key));

    expect(
      smuggled,
      `${smuggled.join(', ')} is filed as a known gap but was NOT one on ` +
        '2026-08-11, when this gate froze the list. That means it is a value set ' +
        'that lost its CHECK AFTER the gate existed — the exact regression this ' +
        'file is here to refuse. Write the migration. Adding it above cannot ' +
        'work, and editing ENUMS_WITHOUT_CHECK_AT_FREEZE to accommodate it would ' +
        'be a false statement about what the schema looked like on that date.',
    ).toEqual([]);
  });

  it('never lets the historical record grow', () => {
    expect(
      ENUMS_WITHOUT_CHECK_AT_FREEZE.length,
      'ENUMS_WITHOUT_CHECK_AT_FREEZE is a statement about the past and cannot ' +
        'change. If this number moved, something is being backdated.',
    ).toBe(35);
  });

  /**
   * The size ratchet, which the subset assertion above does not replace: without
   * it, an entry could be REMOVED from the working list without its migration
   * being written, quietly dropping a gap off the books.
   */
  it('keeps the known-gap list frozen at its recorded size', () => {
    expect(
      KNOWN_GAPS.length,
      'the known-gap list changed size. It may only SHRINK: it records value sets ' +
        'that lost their CHECK in the port and are waiting on task #110. If you ' +
        'wrote one of those migrations, move the entry to MAPPED and lower ' +
        'KNOWN_GAP_COUNT. If a NEW enum brought you here, the answer is a ' +
        'migration — a table that lands without its CHECK is the failure this ' +
        'whole file exists to refuse.',
    ).toBe(KNOWN_GAP_COUNT);
  });

  it('lists each known gap only once', () => {
    expect(new Set(KNOWN_GAPS).size, 'the known-gap list contains a duplicate').toBe(
      KNOWN_GAPS.length,
    );
  });
});

describe('every mapped value set is enforced by the database', () => {
  /**
   * Existence FIRST and separately, because the constraint query cannot answer
   * it: a table or column that does not exist yields no CHECK rows, which is
   * indistinguishable from one that exists and is unconstrained. A typo in the
   * map would otherwise be reported as a missing CHECK — the right colour for the
   * wrong reason, and the fix a reader would reach for is to write a migration
   * that already exists.
   */
  it('names only columns that exist', async () => {
    const rows = await database.asMigrator<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
    `;

    const missing = Object.entries(MAPPED)
      .filter(
        ([, target]) =>
          !rows.some(
            (row) => row.table_name === target.table && row.column_name === target.column,
          ),
      )
      .map(([key, target]) => `${key} -> ${target.table}.${target.column}`);

    expect(missing, `${missing.join(', ')} names a column that does not exist`).toEqual([]);
  });

  it('has the NAMED check constraint on each of them', async () => {
    const constraints = await checkConstraints();

    const unenforced = Object.entries(MAPPED)
      .filter(
        ([, target]) =>
          !constraints.some(
            (row) =>
              row.table_name === target.table &&
              row.column_name === target.column &&
              row.constraint_name === target.constraint,
          ),
      )
      .map(([key, target]) => `${key} -> ${target.constraint} on ${target.table}.${target.column}`);

    expect(
      unenforced,
      `${unenforced.join(', ')} is mapped to a CHECK the migrated database does ` +
        'not have. Either the migration was never generated after the `check()` ' +
        'was added to the pgTable — `db:generate` reads the schema, and a ' +
        'declaration alone constrains nothing — or the constraint was renamed.',
    ).toEqual([]);
  });

  /**
   * The vacuity floor for the constraint query itself.
   *
   * `checkConstraints()` returning an empty array would make the assertion above
   * fail rather than pass, so this is not protecting that one — it is protecting
   * against the opposite drift, where the query silently starts matching
   * something other than CHECK constraints. `contype = 'c'` is narrow, and
   * PostgreSQL 17 files NOT NULL under `contype = 'n'`; if that filter were ever
   * loosened, this count would jump by roughly the number of NOT NULL columns in
   * the schema, which is in the hundreds.
   *
   * The count is of ROWS, not of constraints, and since 0005 the two differ: the
   * query joins `unnest(con.conkey)`, so a CHECK spanning two columns yields two
   * rows. `sortition_draws_requested_slots_cardinality_check` names both `status`
   * and `requested_slots` — the only multi-column CHECK in the schema — which is
   * why THIRTEEN constraints read as FOURTEEN rows. Said explicitly because
   * thirteen is the number a reader counts in the migrations, and finding fourteen
   * here would otherwise look like a bug.
   *
   * The bound below is deliberately loose. It is not a count of the schema's
   * CHECKs — that number changes with every slice of the port and a tight bound
   * would turn this vacuity floor into a chore. It exists to catch the `contype`
   * filter widening, whose signature is hundreds.
   */
  it('reads CHECK constraints specifically, not every constraint in the catalogue', async () => {
    const constraints = await checkConstraints();

    expect(constraints.length).toBeGreaterThanOrEqual(Object.keys(MAPPED).length);
    expect(
      constraints.length,
      `${constraints.length} constrained-column rows found, from thirteen CHECK ` +
        'constraints across migrations 0003, 0004, 0005 and 0006. A number in the ' +
        'hundreds means the contype filter stopped selecting CHECK constraints ' +
        'specifically and is now counting NOT NULL, which PostgreSQL 17 also ' +
        'records here.',
    ).toBeLessThan(50);
  });
});

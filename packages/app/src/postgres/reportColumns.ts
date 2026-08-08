import { getTableName, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  text,
  varchar,
  type PgColumn,
  type PgTable,
} from 'drizzle-orm/pg-core';
import {
  createdAt,
  generatedId,
  inList,
  textArrayLiteral,
  timestamptz,
  updatedAt,
} from '@oxyhq/db';
import type { ModerationLocalStatus } from '../types.js';

/**
 * The moderation half of an application's report table.
 *
 * The Postgres twin of `moderationReportSchemaFields`, and the split is the same
 * one: the application owns the table — its name, its own extra columns, whatever
 * verdict field it already had — and this package owns the SHAPE of the columns
 * it queries, plus the indexes those queries depend on.
 *
 * ```ts
 * const REPORT_MODERATION = {
 *   reportedTypes: ['listing', 'review'],
 *   categories: ['spam', 'harassment'],
 * } as const;
 *
 * export const reports = pgTable(
 *   'reports',
 *   {
 *     ...moderationReportColumns(REPORT_MODERATION),
 *     // …the application's own columns
 *   },
 *   moderationReportTableExtras(REPORT_MODERATION),
 * );
 * ```
 *
 * **`moderationReportTableExtras` takes the OPTIONS and returns the callback**,
 * rather than taking the built columns directly. It has to: the CHECK on
 * `reported_type` and the containment CHECK on `categories` are built from the
 * same tuples that constrain the columns, and drizzle does not carry those
 * tuples onto the built column (`enumValues` is `undefined` there — measured).
 * Passing one options object to both calls is what keeps the column and its
 * constraint from drifting apart.
 */

/**
 * The local statuses, as the CHECK renders them.
 *
 * Spelled out rather than imported from `src/mongoose/report.js`, which would
 * pull `mongoose` into the Postgres path and undo the optional peer. `satisfies`
 * refuses a value outside the union; `postgresSchema.test.ts` asserts this tuple
 * and `MODERATION_LOCAL_STATUSES` still agree, which is what catches an OMISSION
 * — the direction a type cannot see.
 */
const LOCAL_STATUSES = [
  'received',
  'queued',
  'submitted',
  'delivery_failed',
  'closed',
] as const satisfies readonly ModerationLocalStatus[];

/** Mongo's `detailsMaxLength ?? 2_000`, for the same reason: it bounds free text. */
const DEFAULT_DETAILS_MAX_LENGTH = 2_000;

export interface ModerationReportColumnOptions {
  /**
   * The application's reportable types. Constrains the stored value.
   *
   * This is NOT the set of DELIVERABLE types — a type with no subject provider is
   * still reportable and still stored, it simply never leaves. Registering a
   * provider is what makes a type deliverable, and the two lists are allowed to
   * differ.
   *
   * Omitted, no CHECK is created. Supplying it later is a migration.
   */
  readonly reportedTypes?: readonly string[];
  /** The application's report categories. Omitted, no CHECK is created. */
  readonly categories?: readonly string[];
  /** Maximum length of the reporter's free text. */
  readonly detailsMaxLength?: number;
}

/**
 * The columns this package reads and writes, to spread into the application's
 * own `pgTable`.
 *
 * Every SQL name is written out. Drizzle would derive one from the property, and
 * its derivation mangles digit- and capital-adjacent names — `crowdSourceReportId`
 * becomes `crowd_source_report_id`, which is a working column with a name nobody
 * chose and which no gate would notice.
 */
export function moderationReportColumns(options: ModerationReportColumnOptions = {}) {
  return {
    /**
     * `text`, not `uuid`, and generated in the application.
     *
     * `generatedId()` holds a uuid v7 for a row created here and a 24-character
     * ObjectId hex for every row that existed before a Mongo cutover, so one id
     * space serves both. The consequence that matters downstream: a malformed id
     * matches no rows instead of raising `22P02`, which is exactly the Mongo
     * behaviour the delivery path already handles.
     */
    id: generatedId(),

    reportedType: text('reported_type').notNull(),
    reportedId: text('reported_id').notNull(),
    /**
     * The reporting Oxy user id.
     *
     * The Oxy subject IS the identity binding proof, so there is no separate
     * binding step for an application to implement — but it does mean this
     * column must hold an Oxy user id and not an application-local one.
     */
    reporter: text('reporter').notNull(),
    /**
     * `text[]`, written and read WHOLE.
     *
     * This package sets it at intake and reads it at delivery; it never queries
     * by element, so an array column is the port rather than a join table. A
     * containment CHECK constrains the values when the application declares them.
     */
    categories: text('categories').array().notNull(),
    details: varchar('details', {
      length: options.detailsMaxLength ?? DEFAULT_DETAILS_MAX_LENGTH,
    }),

    localStatus: text('local_status').notNull().default('received'),
    /**
     * Why a report is not going anywhere, in words an operator can read.
     *
     * Stored rather than inferred from a missing outbox row. A missing row is
     * also what a lost write looks like, and the two need to be distinguishable
     * months later without re-deriving which types had providers at the time.
     */
    localStatusReason: varchar('local_status_reason', { length: 300 }),

    crowdSourceReportId: text('crowdsource_report_id'),
    crowdSourceCaseId: text('crowdsource_case_id'),
    crowdSourceMerged: boolean('crowdsource_merged'),
    /** SHA-256 of the exact representation that was reviewed. */
    contentSnapshotHash: text('content_snapshot_hash'),
    submittedAt: timestamptz(),
    lastDeliveryError: varchar('last_delivery_error', { length: 2_000 }),

    decisionId: text('decision_id'),
    /**
     * The revision guard.
     *
     * Compared in the update's WHERE clause, so it is the database that refuses a
     * stale write rather than a read-then-write in the application process.
     */
    decisionRevision: integer('decision_revision'),
    decisionOutcome: text('decision_outcome'),
    decisionStatus: text('decision_status'),
    decidedAt: timestamptz(),
    enforcedAction: text('enforced_action'),
    enforcedAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  };
}

/** The column map, as the adopter's table carries it once built. */
export type ModerationReportColumns = ReturnType<typeof moderationReportColumns>;

/** Every column name the report store queries by. */
export type ModerationReportColumnName = keyof ModerationReportColumns;

/**
 * The built columns, as `pgTable`'s third argument receives them.
 *
 * Deliberately NOT `ModerationReportTable`: drizzle calls that callback with the
 * column map alone, which is not a table, so a parameter typed as one would
 * refuse to be a `pgTable` callback at all.
 */
export type ModerationReportBuiltColumns = Record<ModerationReportColumnName, PgColumn>;

/**
 * A table carrying at least the moderation report columns.
 *
 * Structural on purpose: the adopter's table has its own name and its own extra
 * columns, and a type derived from a concrete `pgTable` would name one table and
 * therefore accept no other. What this asserts is the part that matters — that
 * every column the report store reaches for is present.
 */
export type ModerationReportTable = PgTable & Record<ModerationReportColumnName, PgColumn>;

/** Postgres truncates an identifier at 63 bytes, silently, and then names collide. */
const MAX_IDENTIFIER_BYTES = 63;

function identifier(parts: readonly string[]): string {
  const name = parts.join('_');
  if (Buffer.byteLength(name, 'utf8') > MAX_IDENTIFIER_BYTES) {
    throw new Error(
      `The moderation report index name '${name}' is ${Buffer.byteLength(name, 'utf8')} bytes; ` +
        `Postgres truncates identifiers at ${MAX_IDENTIFIER_BYTES} and two names that differ ` +
        'only past the cut then collide. Give the report table a shorter name.',
    );
  }
  return name;
}

/**
 * The CHECKs and indexes the report table needs, as `pgTable`'s third argument.
 *
 * The three indexes are the same three `applyModerationReportIndexes` creates,
 * and not optional: reconciliation scans `(local_status, created_at)` oldest-first
 * on every sweep, and the decision worker looks a case up by
 * `crowdsource_case_id` on every inbound decision. Without them both become
 * sequential scans that grow with the table.
 *
 * The compound uniqueness of "one report per reporter per object" is the
 * APPLICATION's to declare — some applications allow a reporter to file twice
 * under different categories — so it is not created here. Intake's duplicate
 * check reads `(reporter, reported_id, reported_type)`, so that one is indexed
 * for it either way.
 *
 * Index names are derived from the adopter's own table name and length-checked,
 * because two names that differ only past the 63rd byte are the same name to
 * Postgres.
 */
export function moderationReportTableExtras(options: ModerationReportColumnOptions = {}) {
  return (columns: ModerationReportBuiltColumns) => {
    /**
     * The adopter's table name, read off one of its own columns — `pgTable`
     * calls this with the BUILT columns, each of which carries its table. That
     * is what lets the index names belong to the adopter's table without being
     * passed in a second time and drifting.
     */
    const prefix = getTableName(columns.localStatus.table);

    return [
      check(
        identifier([prefix, 'local_status_check']),
        sql`${columns.localStatus} in (${sql.raw(inList(LOCAL_STATUSES))})`,
      ),
      ...(options.reportedTypes === undefined
        ? []
        : [
            check(
              identifier([prefix, 'reported_type_check']),
              sql`${columns.reportedType} in (${sql.raw(inList(options.reportedTypes))})`,
            ),
          ]),
      ...(options.categories === undefined
        ? []
        : [
            /**
             * Containment, not equality: a report carries a SUBSET of the
             * declared categories, and `<@` is trivially satisfied by an empty
             * array — which the application's own validation refuses before this
             * is ever reached.
             */
            check(
              identifier([prefix, 'categories_check']),
              sql`${columns.categories} <@ ${sql.raw(textArrayLiteral(options.categories))}`,
            ),
          ]),
      index(identifier([prefix, 'local_status_created_at_idx'])).on(
        columns.localStatus,
        columns.createdAt,
      ),
      index(identifier([prefix, 'crowdsource_case_id_idx'])).on(columns.crowdSourceCaseId),
      index(identifier([prefix, 'reporter_object_idx'])).on(
        columns.reporter,
        columns.reportedId,
        columns.reportedType,
      ),
    ];
  };
}

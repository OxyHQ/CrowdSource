import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type {
  ModerationReportDecisionUpdate,
  ModerationReportRef,
  ModerationReportStore,
} from '../../store/types.js';
import type { ModerationReportFields } from '../../types.js';
import type { ModerationReportTable } from '../reportColumns.js';
import type { ModerationPgHandle } from './transaction.js';

/**
 * The application's own report table, in Postgres.
 *
 * The only store that takes a table it did not define, which is what makes the
 * structural type worth having: an adopter who forgets a column this package
 * queries gets a COMPILE ERROR at the `postgresModerationStore(...)` call rather
 * than a runtime failure on the first delivery.
 *
 * `scripts/test-report-table-type.mjs` proves that gate in both directions and
 * records exactly what it does not catch — a column present under the right name
 * but the wrong TYPE passes, because every member of `ModerationReportTable` is a
 * bare `PgColumn`. The DDL and the schema tests are what cover that half.
 *
 * ## Two Mongo hazards that do not exist here
 *
 * **A malformed id is not an error.** `id` is `text`, so an id nothing could have
 * generated simply matches no rows and `findById` answers `null` — which is
 * exactly what the delivery worker already does with "the report is gone".
 * Mongoose raises a `CastError` for the same input and its store has to catch it.
 * There is nothing to catch here, and adding a branch for `22P02` would be
 * writing a handler for an error this column cannot raise.
 *
 * **A bound parameter cannot become a query operator.** `requireIdentifier` in
 * `intake.ts` still runs, and still should — a non-string corrupts data on any
 * backend, and the function is exported for callers with no route validation. But
 * the specific failure it was written for, `{ $ne: null }` arriving as a value and
 * matching an unrelated report, is a Mongo shape: here a parameter is a parameter.
 *
 * ## One thing that is worse, stated plainly
 *
 * Every read hands the caller `TReport`, and no type can prove that: the adopter
 * owns the type AND the table, and the two are only connected by their names. See
 * {@link asReport}.
 */

/**
 * The fields `ModerationReportFields` declares OPTIONAL, computed from the type.
 *
 * Postgres stores an absent value as NULL; Mongo omits the field. Both are the
 * same claim — "this never happened" — and one suite has to be able to assert it
 * once, so the package's own optional fields come back ABSENT from either
 * backend. Two `describe.each` pairs failed on exactly this before it was
 * settled, both reading `expected null to be undefined`, and neither was about
 * behaviour.
 *
 * Only the fields the PORT owns are normalised. An adopter's own nullable column
 * is theirs: `extra` goes in untouched and comes back untouched.
 */
type OptionalReportField = {
  [K in keyof ModerationReportFields]-?: undefined extends ModerationReportFields[K]
    ? K
    : never;
}[keyof ModerationReportFields];

const OPTIONAL_REPORT_FIELDS = [
  'details',
  'localStatusReason',
  'crowdSourceReportId',
  'crowdSourceCaseId',
  'crowdSourceMerged',
  'contentSnapshotHash',
  'submittedAt',
  'lastDeliveryError',
  'decisionId',
  'decisionRevision',
  'decisionOutcome',
  'decisionStatus',
  'decidedAt',
  'enforcedAction',
  'enforcedAt',
] as const satisfies readonly OptionalReportField[];

/** `T` when it is `never`, and a compile error naming the field when it is not. */
type AssertNever<T extends never> = T;

/**
 * The exhaustiveness gate. `satisfies` above refuses a field that is not optional;
 * THIS refuses an optional field that is missing from the list — the direction
 * that would otherwise ship as a backend difference nobody looked for.
 */
export type UncoveredOptionalReportField = AssertNever<
  Exclude<OptionalReportField, (typeof OPTIONAL_REPORT_FIELDS)[number]>
>;

/** Drop the package's own optional fields when the column is NULL. */
function absentWhereNull(row: Record<string, unknown>): Record<string, unknown> {
  const normalised: Record<string, unknown> = { ...row };
  for (const field of OPTIONAL_REPORT_FIELDS) {
    if (normalised[field] === null) delete normalised[field];
  }
  return normalised;
}

/**
 * The row, as the port declares it.
 *
 * An unchecked declaration, not a conversion — the same escape the Mongoose store
 * takes with `.lean<TReport>()`, and for the same reason: a driver cannot know an
 * adopter's row type, and `ModerationReportTable` deliberately erases column types
 * so that any adopter's table is accepted.
 *
 * What bounds it is that both halves are checked elsewhere. Column PRESENCE is a
 * compile error, gated by `scripts/test-report-table-type.mjs`. Column VALUES are
 * asserted by round-trips against a real database in
 * `postgresReportStore.test.ts`. What remains unchecked is a column declared with
 * the wrong TYPE, which the migration and the schema test cover instead.
 */
function asReport<TReport extends ModerationReportFields>(
  row: Record<string, unknown>,
): TReport {
  return absentWhereNull(row) as TReport;
}

export function postgresReportStore<TReport extends ModerationReportFields>(input: {
  db: ModerationPgHandle;
  reportTable: ModerationReportTable;
}): ModerationReportStore<TReport, ModerationPgHandle> {
  const { db } = input;
  const reports = input.reportTable;

  /**
   * `count(*)::int`, and the cast is load-bearing.
   *
   * `count(*)` is `bigint`, which postgres.js hands back as a STRING to avoid
   * losing precision — so `sql<number>` without the cast is an assertion that
   * quietly lies, and the caller's `number` is `'3'`. The `::int` makes the
   * database do the conversion.
   */
  const total = sql<number>`count(*)::int`;

  return {
    async findDuplicate({ reporter, reportedId, reportedType }, tx) {
      const rows = await tx
        .select()
        .from(reports)
        .where(
          and(
            eq(reports.reporter, reporter),
            eq(reports.reportedId, reportedId),
            eq(reports.reportedType, reportedType),
          ),
        )
        .limit(1);
      const [row] = rows;
      return row === undefined ? null : asReport<TReport>(row);
    },

    async insert(report, tx) {
      const rows = await tx
        .insert(reports)
        .values({
          /**
           * The application's own columns FIRST, so a field this package owns can
           * never be overwritten by one it knows nothing about. A report whose
           * `localStatus` came from `extra` would be queued with nothing to
           * deliver it, or received with a delivery event that tries anyway.
           *
           * A key that is not a column raises here — Postgres has no silent
           * discard. Mongoose strict mode drops an undeclared path with no throw
           * and no warning, which is why the Mongo half needs a standing test
           * that every DTO field resolves to a schema path.
           */
          ...report.extra,
          reportedType: report.reportedType,
          reportedId: report.reportedId,
          reporter: report.reporter,
          categories: [...report.categories],
          ...(report.details === undefined ? {} : { details: report.details }),
          localStatus: report.localStatus,
          ...(report.localStatusReason === undefined
            ? {}
            : { localStatusReason: report.localStatusReason }),
        })
        .returning();

      const [row] = rows;
      if (row === undefined) {
        throw new Error('The moderation report insert returned no row.');
      }
      return asReport<TReport>(row);
    },

    async findById(reportId) {
      const rows = await db.select().from(reports).where(eq(reports.id, reportId)).limit(1);
      const [row] = rows;
      return row === undefined ? null : asReport<TReport>(row);
    },

    async findByCaseId(caseId) {
      const rows = await db
        .select({
          id: reports.id,
          reportedType: reports.reportedType,
          reportedId: reports.reportedId,
        })
        .from(reports)
        .where(eq(reports.crowdSourceCaseId, caseId));

      return rows.map(
        (row): ModerationReportRef => ({
          id: String(row.id),
          reportedType: String(row.reportedType),
          reportedId: String(row.reportedId),
        }),
      );
    },

    async applyDecision(reportId, update, maxRevision) {
      const rows = await db
        .update(reports)
        .set(decisionSet(update))
        .where(
          and(
            eq(reports.id, reportId),
            /**
             * The revision guard, in the WHERE clause. It is the DATABASE that
             * refuses a stale write rather than a read-then-write in this
             * process: deliveries overlap — CrowdSource retries for 24 hours, and
             * a correction can arrive while the decision it supersedes is still
             * being applied — and an older revision landing last would otherwise
             * overwrite the current answer.
             *
             * `IS NULL` is the port of Mongo's `$exists: false`, because a report
             * with no decision yet stores NULL rather than omitting the column.
             * `<=` rather than `<` is deliberate: a redelivery of the SAME
             * revision rewrites, which is harmless and keeps a partially-applied
             * decision converging.
             */
            or(
              isNull(reports.decisionRevision),
              lte(reports.decisionRevision, maxRevision),
            ),
          ),
        )
        .returning({ id: reports.id });

      return rows.length === 1;
    },

    async markSubmitted(reportId, submission) {
      await db
        .update(reports)
        .set({
          localStatus: 'submitted',
          crowdSourceReportId: submission.crowdSourceReportId,
          crowdSourceCaseId: submission.crowdSourceCaseId,
          crowdSourceMerged: submission.crowdSourceMerged,
          contentSnapshotHash: submission.contentSnapshotHash,
          submittedAt: submission.submittedAt,
          // A report that has landed carries no failure and no reason it was
          // going nowhere. `null` CLEARS in drizzle; `undefined` would leave the
          // stale value in place, which is the port of Mongo's `$unset`.
          lastDeliveryError: null,
          localStatusReason: null,
        })
        .where(eq(reports.id, reportId));
    },

    async markDeliveryFailed(reportId, lastDeliveryError) {
      await db
        .update(reports)
        .set({ localStatus: 'delivery_failed', lastDeliveryError })
        .where(eq(reports.id, reportId));
    },

    async close(reportId, localStatusReason) {
      await db
        .update(reports)
        .set({ localStatus: 'closed', localStatusReason })
        .where(eq(reports.id, reportId));
    },

    async findPendingOldestFirst(limit) {
      /**
       * `queued` and `delivery_failed` only. `received` is excluded deliberately
       * and the omission is the safety property, not an oversight: those reports
       * have no subject provider, so an event re-derived for one would fail on
       * its first attempt and dead-letter.
       *
       * Oldest first, and ASC needs no explicit NULLS placement: both drizzle and
       * Postgres default ascending to NULLS LAST, so this matches the
       * `(local_status, created_at)` index. A DESCENDING order would need the
       * placement spelled out — see the enforcement store's reversal lookup for
       * what that costs when it is not.
       */
      const rows = await db
        .select({ id: reports.id })
        .from(reports)
        .where(inArray(reports.localStatus, ['queued', 'delivery_failed']))
        .orderBy(asc(reports.createdAt))
        .limit(limit);

      return rows.map((row) => String(row.id));
    },

    async countAwaitingDecision(submittedBefore) {
      const rows = await db
        .select({ total })
        .from(reports)
        .where(
          and(
            eq(reports.localStatus, 'submitted'),
            lt(reports.submittedAt, submittedBefore),
          ),
        );
      return rows[0]?.total ?? 0;
    },

    async countLocalOnly() {
      const rows = await db
        .select({ total })
        .from(reports)
        .where(eq(reports.localStatus, 'received'));
      return rows[0]?.total ?? 0;
    },
  };
}

/**
 * The `$set` a decision writes, as one object.
 *
 * `extra` FIRST, for the same reason it is first on insert: it is the adopter's
 * legacy verdict field, and this package's own fields must win.
 */
function decisionSet(update: ModerationReportDecisionUpdate): Record<string, unknown> {
  return {
    ...update.extra,
    localStatus: update.localStatus,
    decisionId: update.decisionId,
    decisionRevision: update.decisionRevision,
    decisionOutcome: update.decisionOutcome,
    decisionStatus: update.decisionStatus,
    decidedAt: update.decidedAt,
    ...(update.enforcedAction === undefined
      ? {}
      : { enforcedAction: update.enforcedAction }),
    ...(update.enforcedAt === undefined ? {} : { enforcedAt: update.enforcedAt }),
  };
}

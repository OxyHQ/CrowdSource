import { getTableName } from 'drizzle-orm';
import type { Column } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '@oxyhq/db';
import type { ExpirySweepTarget } from '@oxyhq/db/expiry';
import {
  MODERATION_EVENT_RETENTION_SECONDS,
  MODERATION_OUTBOX_RETENTION_SECONDS,
} from '../retention.js';
import type { ModerationReportTable } from './reportColumns.js';
import type { ModerationTables } from './tables.js';

/**
 * The two registry FRAGMENTS an adopter merges into its own gates.
 *
 * `@oxyhq/db` holds the mechanisms — the expiry sweep, the id-column
 * classification gate — and the REGISTRIES belong to the consumer, because they
 * name the consumer's own tables. This package's three tables are in the
 * adopter's database, so the entries for them are the adopter's to declare and
 * this package's to KNOW: it is the only place that can say why
 * `crowdsource_case_id` will never carry a foreign key.
 *
 * So each of these returns a fragment to spread, never a whole registry:
 *
 * ```ts
 * const targets = [...myOwnTargets, ...moderationExpirySweepTargets(moderation)];
 * const violations = findIdColumnViolations({
 *   tables: [...myTables, moderation.outbox, moderation.events, moderation.enforcements],
 *   deferred: myDeferred,
 *   withoutForeignKey: [
 *     ...myOwnUnclassified,
 *     ...moderationIdColumnsWithoutForeignKey({ tables: moderation, reportTable: reports }),
 *   ],
 *   minimumTables: …,
 * });
 * ```
 *
 * Shipping them is what stops the first adopter writing these reasons by
 * guessing — and every one of the eight id columns below would otherwise fail
 * that adopter's inherited gate as `unclassified_id_column` on the day it adopts,
 * with nothing to tell it whether that is a missing constraint or a decision.
 */

/** `<table>.<column>`, in the SQL names the gate compares against. */
function describe(table: PgTable, column: Column): string {
  return `${getTableName(table)}.${sqlColumnName(column)}`;
}

/**
 * The two tables that carried a Mongo TTL index, as sweep targets.
 *
 * **A TTL index is a behaviour of the SOURCE that does not survive the port.**
 * Mongo reaps; Postgres does not. Both tables here were declared
 * `expireAfterSeconds: 0` on an `expiresAt` the WRITER computes, so
 * `retentionSeconds` is 0: the column already IS the deadline, and the retention
 * window lives in `src/retention.ts` where both backends read it.
 *
 * Without an entry, a table grows forever — no error, no failing test, no
 * symptom of any kind until disk. Nothing about it is visible in a diff, because
 * the thing doing the work was never in the consumer's code to be missed.
 *
 * ## What sweeping these two costs, stated because a registry entry with no such
 * note reads as "unconditionally safe"
 *
 * The outbox holds unprocessed WORK. A stalled dispatcher plus this sweep
 * discards moderation work that was never delivered — which is why the retention
 * window is ninety days rather than hours, and why a `dead_letter` row is
 * evidence somebody still has to look at rather than a row to reap quickly.
 * Operational alerts must fire long before this deadline; the sweep is the
 * backstop for a table nobody drained, not a queue policy.
 *
 * The event log holds the audit trail of what a third party told this deployment
 * to do, and the dedupe claim. CrowdSource's retry schedule ends at 24 hours, so
 * deleting a row after ninety days cannot resurrect a duplicate delivery; what it
 * does cost is the answer to "did CrowdSource tell us about this case, and when",
 * which is the first question asked when a report looks stuck.
 *
 * Neither read path depends on a swept row already being gone: the dispatcher
 * claims by `available_at` and the receiver claims by primary key, so an
 * unswept row is stale at worst and never unsafe.
 */
export function moderationExpirySweepTargets(
  tables: ModerationTables,
): readonly ExpirySweepTarget[] {
  return [
    {
      table: tables.outbox,
      column: tables.outbox.expiresAt,
      retentionSeconds: 0,
      reason:
        'Deletes a delivered or dead-lettered moderation outbox event past its ' +
        `${MODERATION_OUTBOX_RETENTION_SECONDS}s retention. A row still pending is ` +
        'moderation work that was never delivered — alert long before this.',
    },
    {
      table: tables.events,
      column: tables.events.expiresAt,
      retentionSeconds: 0,
      reason:
        'Deletes the audit row and dedupe claim for an inbound decision past its ' +
        `${MODERATION_EVENT_RETENTION_SECONDS}s retention, long after CrowdSource's ` +
        '24-hour retry schedule can redeliver it.',
    },
  ];
}

/**
 * Every id-shaped column in this package's tables that will never carry a
 * foreign key, with the reason.
 *
 * Eight entries, and the count is worth stating because the obvious count is
 * six: `findIdColumnViolations` exempts a column only when `column.primary` is
 * set, and a composite primary key declared in a table's extra config does NOT
 * set it on its members — so `moderation_enforcements.decision_id` is scanned
 * despite being part of the key.
 *
 * They fall into two kinds, and neither can be constrained:
 *
 * - **Ids in CrowdSource's database.** A decision, a case, a report as CrowdSource
 *   knows it. There is no local table to point at; the row lives in another
 *   service's store, and this deployment holds a copy of its identifier.
 * - **The adopter's own opaque noun ids.** `subject_id` and `reported_id` name a
 *   post, a listing, a message — whichever table the adopter's subject provider
 *   resolves. The package cannot know which, and a single column cannot reference
 *   several tables, which is precisely why they are stored as opaque text.
 *
 * The report table is passed in rather than assumed: the entries embed the
 * adopter's own table name, and a ledger entry naming a table that is not in the
 * gate's `tables` list is reported as `stale_ledger_entry`.
 */
export function moderationIdColumnsWithoutForeignKey(input: {
  tables: ModerationTables;
  reportTable: ModerationReportTable;
}): readonly { column: string; reason: string }[] {
  const { tables, reportTable } = input;

  return [
    {
      column: describe(tables.events, tables.events.caseId),
      reason: 'Names a case in CrowdSource’s database, not the adopter’s.',
    },
    {
      column: describe(tables.enforcements, tables.enforcements.decisionId),
      reason:
        'Names a decision in CrowdSource’s database. Part of the composite ' +
        'primary key, which does not set `column.primary` on its members.',
    },
    {
      column: describe(tables.enforcements, tables.enforcements.caseId),
      reason: 'Names a case in CrowdSource’s database.',
    },
    {
      column: describe(tables.enforcements, tables.enforcements.subjectId),
      reason:
        'The adopter’s own opaque noun id; the package cannot know which table ' +
        'it points at, and one column cannot reference several.',
    },
    {
      column: describe(reportTable, reportTable.reportedId),
      reason:
        'The adopter’s own opaque noun id — same reason as ' +
        '`moderation_enforcements.subject_id`.',
    },
    {
      column: describe(reportTable, reportTable.crowdSourceReportId),
      reason: 'A report id in CrowdSource’s database.',
    },
    {
      column: describe(reportTable, reportTable.crowdSourceCaseId),
      reason: 'A case id in CrowdSource’s database.',
    },
    {
      column: describe(reportTable, reportTable.decisionId),
      reason: 'A decision id in CrowdSource’s database.',
    },
  ];
}

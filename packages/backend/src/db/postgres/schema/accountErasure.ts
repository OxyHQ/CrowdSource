import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';

import { createdAt, inList, timestamptz, updatedAt } from '@oxy.so/db';

/**
 * Erasing a deleted Oxy account (OxyHQ/Mention#1178,
 * `docs/architecture/account-erasure.md`).
 *
 * Neither table has a tenant dimension. A person's Oxy account is not owned by
 * any application: one deletion reaches their reviewer profile, their console
 * memberships and every tenant's reports and notes that name them, so the
 * record of that work cannot sit behind one tenant's row-security policy.
 */

export const ACCOUNT_ERASURE_SOURCES = ['webhook', 'reconciliation'] as const;
export type AccountErasureSource = (typeof ACCOUNT_ERASURE_SOURCES)[number];

export const ACCOUNT_ERASURE_STATUSES = ['pending', 'running', 'completed', 'failed'] as const;
export type AccountErasureStatus = (typeof ACCOUNT_ERASURE_STATUSES)[number];

/**
 * One row per verified `account.deleted` event: the idempotency ledger AND the
 * durable work record, in the sense `engineering-rules.md` gives the outbox.
 *
 * The primary key is Oxy's event id (`jti`), stable across every webhook retry
 * and the pull feed, so the same event arriving twice — pushed and pulled, or
 * redelivered — finds the row the first arrival wrote. The row commits before
 * the webhook answers `202`, which is what makes that answer a promise.
 *
 * `oxy_user_id` stays after completion: it is the proof the erasure ran, and
 * the id is no longer attached to anything else in this database.
 */
export const accountErasures = pgTable(
  'account_erasures',
  {
    eventId: text('event_id').primaryKey(),
    oxyUserId: text('oxy_user_id').notNull(),
    source: text('source').notNull(),
    occurredAt: timestamptz(),
    retained: boolean('retained').notNull(),

    status: text('status').notNull(),
    attempts: integer('attempts').notNull(),
    /** A run holds the row until this instant; a crashed run's lease lapses. */
    leaseUntil: timestamptz(),
    completedAt: timestamptz(),
    /** Per-category row counts. Never content, never an id. */
    counts: jsonb('counts').$type<Record<string, number>>(),
    /** A classification (an error name or SQLSTATE), never a message. */
    lastError: text('last_error'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('account_erasures_status_lease_until_idx').on(table.status, table.leaseUntil),
    check(
      'account_erasures_source_check',
      sql`${table.source} in (${sql.raw(inList(ACCOUNT_ERASURE_SOURCES))})`,
    ),
    check(
      'account_erasures_status_check',
      sql`${table.status} in (${sql.raw(inList(ACCOUNT_ERASURE_STATUSES))})`,
    ),
    check('account_erasures_attempts_check', sql`${table.attempts} >= 0`),
  ],
);

/**
 * Where the pull feed (`GET /account-events` on Oxy) was last read up to, and
 * which task is reading it.
 *
 * Every task runs the reconciliation timer — this service has no leader
 * election — so the feed is read under a lease on this row: one task at a time,
 * and a task whose lease lapsed cannot move the cursor another task now owns.
 */
export const accountEventCursors = pgTable('account_event_cursors', {
  feed: text('feed').primaryKey(),
  cursor: text('cursor'),
  leaseOwner: text('lease_owner'),
  leaseUntil: timestamptz(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

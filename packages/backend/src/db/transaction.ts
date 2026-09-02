import {
  DEADLOCK_DETECTED,
  SERIALIZATION_FAILURE,
  constraintNameOf,
  isUniqueViolation,
  sqlStateOf,
} from '@oxyhq/db';

import { getPostgresDatabase } from './postgres/database';
import type { PgTransactionHandle } from './postgres/withTenant';

/**
 * Transactions, and the one duplicate-key error the domain treats as an answer
 * rather than a failure.
 *
 * BullMQ runs on a single-node Valkey with no replica, no failover and no
 * snapshots, so a queued job can be lost outright. That is survivable only
 * because a domain write and its outbox row commit TOGETHER: if the queue is
 * wiped, the pending work is still re-derivable by re-reading the outbox. Work
 * enqueued without its outbox row is lost with no trace, and it fails silently
 * until the day a node is replaced.
 *
 * `withTransaction` is therefore not an optimisation. It is the mechanism the
 * durability of moderation work rests on, and every module that writes a domain
 * object and an outbox event goes through it.
 */

/** Runs `operation` inside a transaction and returns its result. */
export async function withTransaction<T>(
  operation: (session: PgTransactionHandle) => Promise<T>,
): Promise<T> {
  const db = getPostgresDatabase();
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.transaction(async (tx) => operation(tx));
    } catch (error: unknown) {
      const state = sqlStateOf(error);
      if (
        attempt >= 3 ||
        (state !== SERIALIZATION_FAILURE && state !== DEADLOCK_DETECTED)
      ) {
        throw error;
      }
      // A PostgreSQL serialization/deadlock failure aborts the whole
      // transaction. Retrying here starts a fresh one; retrying inside the
      // callback would only produce `25P02` from the already-aborted handle.
    }
  }
}

/** The unique index a write collided with. */
export interface DuplicateKeyViolation {
  /** The fields of the offending index, e.g. `['applicationId', 'externalReportId']`. */
  readonly indexFields: readonly string[];
}

/**
 * Classifies a write failure as a unique-index collision, or returns null.
 *
 * This is what lets idempotency be the index rather than application logic. A
 * "read, then decide whether to write" sequence races: two concurrent retries of
 * the same delivery both read nothing and both insert. Inserting first and
 * interpreting the collision cannot race, because the index is the arbiter.
 */
export function duplicateKeyViolation(error: unknown): DuplicateKeyViolation | null {
  if (!isUniqueViolation(error)) return null;

  const constraint = constraintNameOf(error);
  const fieldsByConstraint: Readonly<Record<string, readonly string[]>> = {
    reports_application_external_key: ['applicationId', 'externalReportId'],
    reports_application_idempotency_key: ['applicationId', 'idempotencyKey'],
    cases_application_subject_content_policy_key: [
      'applicationId',
      'externalSubjectId',
      'contentHash',
      'policyVersion',
    ],
    appeals_application_idempotency_key: ['applicationId', 'idempotencyKey'],
    appeals_application_case_revision_key: ['applicationId', 'caseId', 'supersededRevision'],
  };

  return {
    indexFields:
      typeof constraint === 'string' ? (fieldsByConstraint[constraint] ?? []) : [],
  };
}

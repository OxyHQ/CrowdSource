import type { Model } from 'mongoose';
import type {
  ModerationEnforcementKey,
  ModerationEnforcementStore,
} from '../../store/types.js';
import type { ModerationEnforcementDocument } from '../models.js';

/**
 * The enforcement ledger, in Mongo.
 *
 * Every row is claimed before anything happens and addressed afterwards by the
 * key it was claimed under — never by a record id. That is what lets the same
 * three values reach the same row here (through a unique index) and on Postgres
 * (through a composite primary key), and it is why no opaque id crosses the
 * port.
 *
 * Timestamps are the schema's: `timestamps: true` owns `createdAt` and
 * `updatedAt` on this collection, so the `now` the port carries — which a
 * backend without automatic timestamps needs — is deliberately not written here.
 * The outbox store is the exception and says why: there the explicit timestamps
 * are what keep a repeated enqueue a genuine no-op.
 */

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    Number((error as { code?: unknown }).code) === 11000
  );
}

/**
 * The idempotency key, as a filter.
 *
 * `decisionId + revision + action` is a UNIQUE index, so this addresses at most
 * one row — the one the claim inserted.
 */
function keyFilter(key: ModerationEnforcementKey): {
  decisionId: string;
  decisionRevision: number;
  action: string;
} {
  return {
    decisionId: key.decisionId,
    decisionRevision: key.decisionRevision,
    action: key.action,
  };
}

export function mongooseEnforcementStore(input: {
  model: Model<ModerationEnforcementDocument>;
}): ModerationEnforcementStore {
  const { model } = input;

  return {
    /**
     * The claim. The unique index refuses a second row for this
     * `decisionId + revision + action`, so losing this insert is the answer
     * "another delivery already handled it" and not an error.
     */
    async claim(row) {
      try {
        await model.create([
          {
            decisionId: row.decisionId,
            decisionRevision: row.decisionRevision,
            action: row.action,
            caseId: row.caseId,
            subjectType: row.subjectType,
            subjectId: row.subjectId,
            outcome: row.outcome,
            ...(row.recommendedAction === undefined
              ? {}
              : { recommendedAction: row.recommendedAction }),
            reason: row.reason,
            mode: row.mode,
            applied: false,
          },
        ]);
        return true;
      } catch (error: unknown) {
        if (isDuplicateKeyError(error)) return false;
        throw error;
      }
    },

    async markSkipped(key, { skippedReason, recordedAs }) {
      await model.updateOne(keyFilter(key), {
        $set: {
          skippedReason,
          ...(recordedAs === undefined ? {} : { recordedAs }),
        },
      });
    },

    async markApplied(key, { appliedAt, previousState }) {
      await model.updateOne(keyFilter(key), {
        $set: {
          applied: true,
          appliedAt,
          ...(previousState === undefined ? {} : { previousState }),
        },
      });
    },

    async releaseClaim(key) {
      await model.deleteOne(keyFilter(key));
    },

    async latestApplied({ subjectType, subjectId, actions }) {
      /**
       * `applied: true` and the whole `actions` set are both load-bearing, and
       * both are attacked by a proven mutation. A row that was RECORDED carries
       * no `previousState`, so reading it hands a reversal nothing and the
       * application's fallback publishes something its author left in draft;
       * querying only the first declared action reads a stale row whenever a
       * later lever was the one that actually applied.
       */
      const row = await model
        .findOne({
          subjectType,
          subjectId,
          action: { $in: [...actions] },
          applied: true,
        })
        .sort({ createdAt: -1 })
        .select('previousState action')
        .lean<Pick<ModerationEnforcementDocument, 'previousState' | 'action'> | null>();
      if (row === null) return null;
      /**
       * `action` goes back as a bare string. The store has no knowledge of the
       * application's action union, and the executor narrows it THROUGH the
       * declared set rather than asserting it — see `previousStateFor`.
       */
      return {
        action: row.action,
        ...(row.previousState === undefined ? {} : { previousState: row.previousState }),
      };
    },
  };
}

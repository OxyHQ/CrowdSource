import type { ClientSession, Connection, Model } from 'mongoose';
import type { ModerationStore } from '../../store/types.js';
import type { ModerationReportFields } from '../../types.js';
import { registerModerationModels } from '../models.js';
import { mongooseEnforcementStore } from './enforcement.js';
import { mongooseEventStore } from './events.js';
import { mongooseOutboxStore } from './outbox.js';
import { mongooseReportStore } from './reports.js';
import { mongooseTransactionRunner } from './transaction.js';

/**
 * Everything this package writes, in Mongo.
 *
 * One factory rather than five, because the five members must share one
 * connection: a report and its outbox row commit in the SAME transaction, and a
 * store assembled from two connections would type-check perfectly and quietly
 * lose that.
 *
 * The three collections this package owns are registered here rather than by the
 * application. `mongoose.model()` registers on the DEFAULT connection, so a
 * package that used it would put its collections on whichever connection
 * happened to be default; passing one in is also what lets two integrations
 * exist in one test process.
 */
export function mongooseModerationStore<TReport extends ModerationReportFields>(input: {
  connection: Connection;
  /** The application's own model, built from `moderationReportSchemaFields`. */
  reportModel: Model<TReport>;
  /** Constrains the stored `action`, so a row outside the set cannot be written. */
  enforcementActions: readonly string[];
  /**
   * Prefix for the model names registered on the connection. Only needed if the
   * application already has a model called `ModerationOutbox`, `ModerationEvent`
   * or `ModerationEnforcement`.
   */
  modelPrefix?: string;
}): ModerationStore<TReport, ClientSession> {
  const models = registerModerationModels({
    connection: input.connection,
    enforcementActions: input.enforcementActions,
    ...(input.modelPrefix === undefined ? {} : { modelPrefix: input.modelPrefix }),
  });

  return {
    transaction: mongooseTransactionRunner(input.connection),
    outbox: mongooseOutboxStore({ model: models.outbox }),
    events: mongooseEventStore({ model: models.event }),
    enforcement: mongooseEnforcementStore({ model: models.enforcement }),
    reports: mongooseReportStore<TReport>({ model: input.reportModel }),

    /**
     * Build the indexes before the first write.
     *
     * `init()` rather than a hope that Mongoose gets round to it: the unique
     * indexes ARE the mechanism behind every "exactly once" claim in this
     * package — the outbox event id, the webhook dedupe, the enforcement
     * idempotency key — and an index that does not exist yet refuses nothing.
     * The application's own report model is included because its
     * "one report per reporter per object" index is what finally decides a tie
     * that intake's duplicate check cannot.
     */
    async ensureSchema() {
      await Promise.all([
        models.outbox.init(),
        models.event.init(),
        models.enforcement.init(),
        input.reportModel.init(),
      ]);
    },
  };
}

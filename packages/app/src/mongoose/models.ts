import { Schema, type Connection, type Model } from 'mongoose';
import type {
  ModerationEnforcementMode,
  ModerationOutboxKind,
  ModerationOutboxPayload,
  ModerationOutboxStatus,
} from '../types.js';

/**
 * The three collections this package owns, built on the application's own
 * connection.
 *
 * They are built rather than imported for one reason that matters and one that
 * is convenience. The one that matters: `mongoose.model()` registers on the
 * default global connection, so a package that did that would put its
 * collections on whichever connection happened to be default — not necessarily
 * the application's. The convenience: two integrations can exist in one test
 * process without colliding.
 *
 * None of these three knows what the application's nouns are. `subjectType` and
 * `subjectId` are stored as opaque strings precisely so that stays true.
 */

/* ------------------------------------------------------------------------- */
/* Outbox                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * The durable record of moderation work that has to happen but has not happened
 * yet.
 *
 * This collection is what makes the intake guarantee true. A 201 from an
 * application's report route means the report and its outbox event committed in
 * ONE transaction — not that a call to CrowdSource succeeded. Delivery is a
 * separate, retried step, and the user is never made to wait for a third party
 * to be reachable.
 *
 * The same shape carries work in the other direction. A decision arriving over a
 * webhook is answered 2xx as soon as it is recorded here, and applied
 * afterwards. Nothing is enqueued that is not already written down: if the
 * dispatcher, the process or the whole task disappears, every pending piece of
 * moderation work is re-derivable by reading this collection.
 */
export interface ModerationOutboxDocument {
  _id: string;
  kind: ModerationOutboxKind;
  payload: ModerationOutboxPayload;
  status: ModerationOutboxStatus;
  attempts: number;
  availableAt: Date;
  leaseOwner?: string;
  leaseUntil?: Date;
  lastError?: string;
  processedAt?: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const MODERATION_OUTBOX_COLLECTION = 'moderation_outbox';

function outboxSchema(): Schema<ModerationOutboxDocument> {
  const schema = new Schema<ModerationOutboxDocument>(
    {
      _id: { type: String, required: true },
      kind: { type: String, required: true, enum: ['report.submit', 'decision.apply'] },
      payload: {
        reportId: { type: String },
        eventId: { type: String },
        caseId: { type: String },
        decision: { type: Schema.Types.Mixed },
      },
      status: {
        type: String,
        required: true,
        enum: ['pending', 'processing', 'processed', 'dead_letter'],
        default: 'pending',
      },
      attempts: { type: Number, required: true, default: 0 },
      availableAt: { type: Date, required: true, default: Date.now },
      leaseOwner: { type: String },
      leaseUntil: { type: Date },
      lastError: { type: String },
      processedAt: { type: Date },
      expiresAt: { type: Date, required: true },
    },
    { timestamps: true, collection: MODERATION_OUTBOX_COLLECTION },
  );

  // Due work and expired claims are separate bounded scans.
  schema.index({ status: 1, availableAt: 1, createdAt: 1 });
  schema.index({ status: 1, leaseUntil: 1, createdAt: 1 });
  // How this backend enforces MODERATION_OUTBOX_RETENTION_SECONDS: the writer
  // computes `expiresAt`, and the TTL index is what finally removes the row.
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  return schema;
}

/* ------------------------------------------------------------------------- */
/* Inbound events                                                             */
/* ------------------------------------------------------------------------- */

export type ModerationEventState = 'claimed' | 'queued' | 'ignored';

/**
 * Every webhook event CrowdSource has delivered to this deployment.
 *
 * Two jobs, and they are the same document on purpose.
 *
 * **Deduplication.** A receiver must record the processed event id. `_id` IS the
 * event id, so the unique index on it is the dedupe: a redelivery cannot insert
 * a second row, and a claim therefore cannot succeed twice. Doing this in Mongo
 * rather than in the SDK's default in-process store is not optimisation — an
 * application running several tasks behind one load balancer would otherwise
 * dedupe only whichever task happened to receive both copies.
 *
 * **Audit.** What arrived, when, and whether it was acted on. `payload` is the
 * event's `data` exactly as delivered: those payloads are deliberately loose, so
 * projecting them into columns would silently drop whatever a newer CrowdSource
 * added.
 *
 * The stored payload is a decision — an outcome, findings, policy versions, a
 * jury summary. It is not the reported material and must not become a place
 * where reported material is kept: nothing in this collection is read into a log
 * line.
 */
export interface ModerationEventDocument {
  _id: string;
  type?: string;
  caseId?: string;
  payload?: unknown;
  state: ModerationEventState;
  receivedAt: Date;
  queuedAt?: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const MODERATION_EVENT_COLLECTION = 'moderation_events';

function eventSchema(): Schema<ModerationEventDocument> {
  const schema = new Schema<ModerationEventDocument>(
    {
      _id: { type: String, required: true },
      type: { type: String },
      caseId: { type: String, index: true },
      payload: { type: Schema.Types.Mixed },
      state: {
        type: String,
        required: true,
        enum: ['claimed', 'queued', 'ignored'],
        default: 'claimed',
      },
      receivedAt: { type: Date, required: true, default: Date.now },
      queuedAt: { type: Date },
      expiresAt: { type: Date, required: true },
    },
    { timestamps: true, collection: MODERATION_EVENT_COLLECTION },
  );

  // As above: MODERATION_EVENT_RETENTION_SECONDS, enforced by a TTL index.
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  // Operational: what arrived recently, and what never got past `claimed`.
  schema.index({ state: 1, receivedAt: 1 });
  return schema;
}

/* ------------------------------------------------------------------------- */
/* Enforcement                                                                */
/* ------------------------------------------------------------------------- */

/**
 * What the application did about a decision — one row per action, and the
 * reason it is impossible to do twice.
 *
 * The idempotency key is `decisionId + revision + action`. The unique index
 * below IS that key, and it is the whole mechanism: a redelivered webhook, a
 * reclaimed outbox lease and a manual replay all try to insert the same row, and
 * only the first can. Checking "have I done this?" with a read before a write
 * would leave the window between them, which is precisely the window a
 * redelivery arrives in.
 *
 * `revision` is in the key for a reason of its own. A correction is a NEW
 * revision that supersedes the old one, so the restore it asks for is a
 * different action from the removal that came before and must be allowed to
 * happen — while still being impossible to apply twice itself.
 *
 * `previousState` is what makes reversibility real rather than aspirational. It
 * is the application's own opaque record of what an effect replaced, so a
 * restore returns an object to what it WAS and a correction does not silently
 * lift a content warning moderation never set.
 */
export interface ModerationEnforcementDocument {
  decisionId: string;
  decisionRevision: number;
  action: string;

  caseId: string;
  /** The application's own noun. Never a CrowdSource resource id. */
  subjectType: string;
  subjectId: string;

  outcome: string;
  recommendedAction?: string;
  /**
   * What the action amounted to, when the effect said it was not what was
   * planned. The `action` field above stays the PLANNED one — it is half the
   * idempotency key and it is what was decided.
   */
  recordedAs?: string;
  /** Why this action, in words an operator can read. Never reported material. */
  reason: string;

  mode: ModerationEnforcementMode;
  /**
   * Whether the effect was actually carried out.
   *
   * `false` in `observe` mode for every action, which is the point of the mode:
   * the plan is recorded and auditable, and nothing is removed.
   */
  applied: boolean;
  appliedAt?: Date;
  /** Why an action was recorded but not carried out. */
  skippedReason?: string;

  /** What to put back on a reversal. Only set for an action that changed state. */
  previousState?: Record<string, string | number | boolean | null | undefined>;

  createdAt: Date;
  updatedAt: Date;
}

export const MODERATION_ENFORCEMENT_COLLECTION = 'moderation_enforcements';

function enforcementSchema(
  actions: readonly string[],
): Schema<ModerationEnforcementDocument> {
  const schema = new Schema<ModerationEnforcementDocument>(
    {
      decisionId: { type: String, required: true },
      decisionRevision: { type: Number, required: true, min: 1 },
      action: { type: String, required: true, enum: [...actions] },

      caseId: { type: String, required: true, index: true },
      subjectType: { type: String, required: true },
      subjectId: { type: String, required: true },

      outcome: { type: String, required: true },
      recommendedAction: { type: String },
      recordedAs: { type: String, enum: [...actions] },
      reason: { type: String, required: true, maxlength: 500 },

      mode: { type: String, required: true, enum: ['observe', 'manual', 'automatic'] },
      applied: { type: Boolean, required: true, default: false },
      appliedAt: { type: Date },
      skippedReason: { type: String, maxlength: 300 },

      previousState: { type: Schema.Types.Mixed },
    },
    { timestamps: true, collection: MODERATION_ENFORCEMENT_COLLECTION },
  );

  /**
   * The idempotency key. Unique, and load-bearing: without it a redelivered
   * decision removes an object twice, and a redelivered correction restores it
   * twice.
   */
  schema.index({ decisionId: 1, decisionRevision: 1, action: 1 }, { unique: true });
  // Operational: what has been done to this object, newest first.
  schema.index({ subjectType: 1, subjectId: 1, createdAt: -1 });
  // The reversal lookup: the most recent APPLIED row for one action on one object.
  schema.index({ subjectType: 1, subjectId: 1, action: 1, applied: 1, createdAt: -1 });
  return schema;
}

/* ------------------------------------------------------------------------- */
/* Registration                                                               */
/* ------------------------------------------------------------------------- */

export interface ModerationModels {
  outbox: Model<ModerationOutboxDocument>;
  event: Model<ModerationEventDocument>;
  enforcement: Model<ModerationEnforcementDocument>;
}

/**
 * Register (or reuse) the three collections on this connection.
 *
 * Reuse rather than throw when a model name is already taken: the factory is
 * called once per process in production, but a test file that builds two
 * integrations against one connection is doing something reasonable and should
 * not have to tear down mongoose's registry between them. An application whose
 * own models genuinely collide passes `modelPrefix`.
 */
export function registerModerationModels(input: {
  connection: Connection;
  enforcementActions: readonly string[];
  modelPrefix?: string;
}): ModerationModels {
  const prefix = input.modelPrefix ?? '';
  const named = <TDocument>(
    name: string,
    build: () => Schema<TDocument>,
  ): Model<TDocument> => {
    const modelName = `${prefix}${name}`;
    const existing = input.connection.models[modelName];
    if (existing) return existing as Model<TDocument>;
    return input.connection.model<TDocument>(modelName, build());
  };

  return {
    outbox: named<ModerationOutboxDocument>('ModerationOutbox', outboxSchema),
    event: named<ModerationEventDocument>('ModerationEvent', eventSchema),
    enforcement: named<ModerationEnforcementDocument>('ModerationEnforcement', () =>
      enforcementSchema(input.enforcementActions),
    ),
  };
}

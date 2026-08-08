/**
 * The public surface an application implements.
 *
 * Everything in this file is a seam. Nothing in it knows what a post, a listing,
 * a message or a property is — that knowledge belongs to the application and
 * reaches this package through exactly four ports:
 *
 * 1. {@link ModerationSubjectProvider} — "given one of MY nouns and its id,
 *    describe the material".
 * 2. {@link ModerationTaxonomy} — "what my reporters can pick, as universal
 *    allegation codes".
 * 3. {@link ModerationEnforcementConfig} — "what I can do about a decision, and
 *    how to do and undo it".
 * 4. The application's own report model, its Mongoose connection, and its
 *    configuration.
 *
 * Everything else — the outbox, the transaction coupling, delivery, the webhook
 * receiver, deduplication, decision application, enforcement idempotency and
 * reversibility, reconciliation — is identical in every application and is
 * imported, not written.
 */

import type { Connection, Model } from 'mongoose';
import type { ContextInput, ReportSubjectInput, ResourceInput } from '@oxyhq/crowdsource';
import type {
  Decision,
  RecommendedAction,
  Severity,
  TaxonomyCode,
} from '@oxyhq/crowdsource-contracts';

/* ------------------------------------------------------------------------- */
/* Subjects — the application's nouns, as universal material                  */
/* ------------------------------------------------------------------------- */

/**
 * The SDK's resource descriptions, unchanged.
 *
 * Aliased so a provider imports its vocabulary from one place, but these ARE the
 * SDK's types rather than a local restatement: a resource type added to the
 * contract becomes available to every provider the moment the dependency is
 * bumped.
 */
export type ModerationResource = ResourceInput;
export type ModerationContextResource = ContextInput;

/**
 * One reported object, described.
 *
 * `content` is required because a report with no material is a question a jury
 * cannot answer. An application that cannot produce the material for one of its
 * nouns should not register a provider for it — a reported type with no provider
 * is still accepted and stored, it simply never leaves.
 */
export interface ModerationSubjectSnapshot {
  /** Identity, type and author of the reported object. */
  readonly subject: ReportSubjectInput;
  /** The reported material itself. A string is shorthand for plain text. */
  readonly content: string | ModerationResource;
  /** Media carried BY the subject. */
  readonly attachments?: readonly ModerationResource[];
  /**
   * Surrounding material a jury needs to judge fairly — the parent of a reply,
   * the listing a review is about. Context, not extra exposure.
   */
  readonly context?: readonly ModerationContextResource[];
}

/**
 * Translates one of the application's nouns into universal material.
 *
 * `subjectType` is declared on the provider rather than returned per snapshot
 * because it is a property of the noun: every Mention post is a `social.post`,
 * every Mercaria product a `commerce.listing`. Keeping it here means the registry
 * can answer "what does this application report?" without loading an object.
 *
 * Two rules keep the seam working, and both are load-bearing rather than
 * stylistic:
 *
 * 1. **A provider returns a DESCRIPTION, never an envelope.** The SDK composes
 *    the Case Envelope — resource ids, digests, relations, principal refs, the
 *    binding proof, the policy version, the idempotency key — and the case dedup
 *    key is computed over exactly those. An application that composed its own
 *    envelope would be the reason two reporters about one object opened two
 *    cases, and "one penalty per incident" would fail in production with nothing
 *    failing in a test.
 * 2. **A provider is pure translation with reads.** It fetches its own object and
 *    returns. It does not decide whether to deliver, what the allegation is, or
 *    what happens to the report.
 */
export interface ModerationSubjectProvider {
  /** The application's own name for the noun, as it arrives on a report. */
  readonly reportedType: string;
  /**
   * The namespaced universal subject type, or `custom.<org>.<object_type>`.
   *
   * ## Reporting an ACCOUNT has a tenancy consequence worth knowing first
   *
   * `applicationId` is read off the service credential, so a report this
   * application submits opens a case in ITS tenant. For an object the
   * application owns that is exactly right. For an Oxy IDENTITY it is not: the
   * case names a principal only Oxy can act on, and when a second Oxy
   * application reports the same person under its own credential the dedup key
   * (`applicationId + subject external id + content hash + policy version`)
   * differs by tenant — so one person yields two cases, two juries and two
   * consequences, breaking "one penalty per incident" at a layer nothing inside
   * either application can repair.
   *
   * That is an argument for care, not a prohibition: `identity.profile` is a
   * legitimate subject type, and an application whose own surfaces are what a
   * jury would judge may well register one. What it is not is a way to have
   * somebody's Oxy account sanctioned — an application can never move a
   * reputation figure directly, and cross-application hand-off is a design
   * question the contract does not answer yet. Registering no provider for a
   * reported account is a supported answer: the report is still stored, and
   * still counted, it simply never leaves.
   *
   * Credit: `mercaria` surfaced this while deciding not to give `seller` a
   * provider, and it is app-independent enough to belong here.
   */
  readonly subjectType: string;
  /**
   * Describes the object, or returns `null` when it no longer exists.
   *
   * `null` is not a failure. Content deleted between the report and its delivery
   * is ordinary, and the caller decides what that means — a provider that threw
   * would make deletion look like an outage and be retried for days.
   */
  snapshot(reportedId: string): Promise<ModerationSubjectSnapshot | null>;
}

/* ------------------------------------------------------------------------- */
/* Taxonomy — the application's categories, as allegations                    */
/* ------------------------------------------------------------------------- */

/**
 * What a reporter picked, translated into what is being ALLEGED.
 *
 * Versioned because a decision records the policy version it was decided under
 * and this mapping is upstream of that: change what `spam` means and two reports
 * filed a month apart are no longer the same allegation. The version is stamped
 * into the report metadata so a case can be read back against the mapping that
 * produced it. Bump it in the same change that alters a row.
 */
export interface ModerationTaxonomy {
  readonly version: string;
  /**
   * The allegation codes for a report's categories.
   *
   * MUST be deterministic and stably ordered for a given input set. Ingress
   * fingerprints the whole envelope to detect "same external id, different
   * body", so a list whose order depended on how a client happened to send its
   * categories turns a legitimate outbox retry into a permanent 409 — days
   * later, as a report silently stuck in a queue. Sort the result.
   *
   * MUST NOT return an empty array: a report with no allegation is not a report.
   * Map anything unrecognised to `other.unclassifiable`.
   */
  allegationsFor(categories: readonly string[]): readonly TaxonomyCode[];
}

/* ------------------------------------------------------------------------- */
/* Enforcement — what the application does about a decision                   */
/* ------------------------------------------------------------------------- */

/**
 * How much of a plan a deployment is allowed to carry out.
 *
 * `observe` runs everything except the effect — the plan, the idempotency claim
 * and the audit row are identical to production, so what the mode proves is
 * exactly what will happen when it is switched off.
 */
export type ModerationEnforcementMode = 'observe' | 'manual' | 'automatic';

/** One thing the application decided to do, and why. */
export interface PlannedEnforcementAction<TAction extends string> {
  readonly action: TAction;
  /** Why, in words an operator reads. Never reported material. */
  readonly reason: string;
  /** The recommendation this came from, when it came from one. */
  readonly recommendedAction?: RecommendedAction;
}

/**
 * What an effect changed, so a later revision can put it back.
 *
 * Opaque to this package and owned by the application: it is written on the
 * enforcement row when an action is applied and handed back to
 * {@link ModerationEnforcementConfig.apply} when a superseding revision reverses
 * it. Keep it small, flat and JSON-serialisable — it is stored in Mongo, and it
 * must never contain reported material.
 */
export type EnforcementPreviousState = Readonly<
  Record<string, string | number | boolean | null | undefined>
>;

/** The object an enforcement action is about, in the application's own terms. */
export interface EnforcementSubject {
  /** The application's own noun (`post`, `listing`, …). Never a resource id. */
  readonly type: string;
  readonly id: string;
}

/**
 * The result of carrying out one action.
 *
 * `changed: false` is not a failure — the object is already gone, or there was
 * no restriction to undo. It is recorded with its reason, which is how "we
 * checked and there was nothing to do" stays distinguishable from "we never
 * looked". Throw only for a real failure; the claim is then released so a retry
 * can try again.
 */
export type EnforcementEffect<TAction extends string = string> =
  | { readonly changed: true; readonly previousState?: EnforcementPreviousState }
  | {
      readonly changed: false;
      readonly reason: string;
      /**
       * What this action actually amounted to, when that is not the action that
       * was planned.
       *
       * The plan is computed before `apply` runs and is deliberately
       * subject-blind, so it can name an action that cannot apply to THIS
       * object. An application whose restore only exists for some of its subject
       * types is the clearest case: a decision clearing a customer plans
       * `reinstate_courier`, because the tables cannot know the subject — and a
       * report then reads "decided: reinstate_courier" about somebody who was
       * never suspended.
       *
       * Setting `recordedAs` corrects the label at the only point that knows:
       * `apply` is the sole place aware that this object has no such lever. The
       * enforcement row keeps the PLANNED action, because that is the
       * idempotency key and what was actually decided, and additionally records
       * this; the report's `enforcedAction` uses this.
       *
       * Only meaningful when nothing changed — an effect that happened is the
       * action that was planned. Must be one of `actions`.
       *
       * Credit: `noted-moovo`, from Moovo's courier/customer asymmetry, where
       * two of three subject types have no suspendable state.
       */
      readonly recordedAs?: TAction;
    };

/**
 * The application's half of enforcement: its actions, its mapping, its effects.
 *
 * The idempotency claim, the mode gate, the audit row, the reversal lookup and
 * the release-on-failure are this package's and are not configurable — they are
 * the invariants, not the policy.
 */
export interface ModerationEnforcementConfig<TAction extends string> {
  /** Every action this application can plan. Used for the stored enum. */
  readonly actions: readonly TAction[];

  /**
   * The action meaning "deliberately nothing".
   *
   * Never survives beside another action, and is what an otherwise-empty plan
   * becomes: a row saying "we decided to do nothing, and why" is evidence, and
   * an absent row is a question.
   */
  readonly noneAction: TAction;

  /**
   * The action meaning "a human looks at this".
   *
   * Always survives a collapse, and is where an unmapped recommendation, an
   * unrecognised outcome and an unrecognised severity all go. Dropping it
   * because something else was also done is how a `suspend_user` recommendation
   * gets lost.
   */
  readonly reviewAction: TAction;

  /**
   * The actions that DO the undoing — `['restore', 'unlabel_sensitive']`, NEVER
   * `['restrict', 'label_sensitive']` — or `null` when there is nothing to undo.
   *
   * **Direction first, because everything below describes the opposite one.**
   * This field holds what the planner EMITS on `no_violation`; `reverses` is the
   * separate map saying what each of those undoes. The rest of this comment
   * necessarily talks about the levers a correction must REVERSE, and a reader
   * arriving from that prose fills in the targets instead of the actors — a
   * mistake two people made within an hour, including the author of the field.
   *
   * It matters more than a naming slip because an inverted value **does not
   * fail**. It type-checks, it plans, and it applies a restriction and a label
   * on an accepted appeal: the correction carrying out the punishment it was
   * correcting, on the one path in the system whose whole purpose is to give
   * something back.
   *
   * **Required, and `null` is a real answer.** Naming an action makes
   * `no_violation` ALWAYS plan it, and that is load-bearing: a correction is a
   * new revision whose outcome is `no_violation` and whose recommendation is
   * frequently `no_action` — which means "take no NEW action", not "leave what
   * you already did in place". Mapping that straight through plans nothing, and
   * the object an earlier revision removed stays removed forever: the appeal
   * succeeded, the case says the content was fine, and nothing ever puts it
   * back. No error, no log line, no failing test.
   *
   * It is required rather than optional because an ABSENT key cannot be told
   * apart from a forgotten one, and forgetting is exactly the silent bug above.
   * `null` says an application considered it and has no restriction to lift —
   * true of an application with no sanction primitive at all, and the compiler
   * makes saying so a deliberate act.
   *
   * **A LIST when more than one action is reversible, and this is the shape most
   * applications actually need.** An application whose levers are "hide it" and
   * "label it" has TWO things a correction must undo, and naming only one leaves
   * the other permanently stuck: the object is un-hidden and stays labelled
   * forever. Every planned restore that finds nothing to undo records
   * `changed: false` with its reason, so listing an action that did not apply
   * costs an audit row rather than a wrong effect — which is the cheap side of
   * the trade.
   *
   * Credit: `mention-finish`, who found `unlabel_sensitive` fully implemented,
   * mode-gated, and reachable from nothing in Mention — the correction fix
   * applied to one of two reversible actions. This package had the same gap.
   */
  readonly restoreAction: TAction | readonly TAction[] | null;

  /**
   * What each recommendation becomes. Anything unmapped becomes
   * {@link reviewAction}.
   *
   * Optional, because an empty table and an absent one mean the same thing: a
   * recommendation this application has no action for goes to a human, recorded
   * with the recommendation that produced it. An application with no sanction
   * primitive omits it entirely.
   */
  readonly recommendationToAction?: Partial<Record<RecommendedAction, TAction>>;

  /**
   * What a `violation` with NO recommendation becomes, by highest severity.
   *
   * Be cautious at both ends: a `low`-severity violation nobody recommended
   * anything for is not something to remove an object over, and `critical`
   * material is routed to a specialist team under legal protocol — neither is an
   * automatic effect a mapping table should decide.
   *
   * Optional, and any severity left unmapped falls to {@link reviewAction}. An
   * application with nothing to enforce can omit it entirely; the cautious
   * default is the only honest one when a table says nothing.
   */
  readonly severityFallback?: Partial<Readonly<Record<Severity, TAction>>>;

  /**
   * Actions that absorb weaker ones when both are planned.
   *
   * `{ restrict: ['label_sensitive', 'none', 'restore'] }` — a removed object
   * does not also need a warning, and recording both would claim two effects
   * where one happened.
   */
  readonly absorb?: Partial<Record<TAction, readonly TAction[]>>;

  /**
   * Strongest first. Decides the ONE action written onto the report when a plan
   * produced several.
   *
   * Optional; defaults to {@link actions}, so listing `actions` strongest-first
   * is enough for most applications.
   */
  readonly precedence?: readonly TAction[];

  /**
   * Actions `manual` mode still applies automatically.
   *
   * The reversible, low-consequence half: giving something BACK. Holding those
   * behind a human means a wrongly-removed object stays removed while somebody
   * reads a queue. Taking content down still waits for a person.
   */
  readonly reversibleActions?: readonly TAction[];

  /**
   * Carry out one action, or say why there was nothing to carry out.
   *
   * Called at most once per `decisionId + revision + action`, and only when the
   * mode allows it. `previousState` is handed back to a later reversal.
   *
   * **Optional.** An application with no sanction primitive at all — nothing to
   * remove, restrict, label or suspend — omits it, and every planned action is
   * recorded as `recorded` with a reason. That is a supported shape rather than
   * an unfinished one: the plan, the idempotency claim and the audit row are
   * still real, so "CrowdSource decided this and we have no way to carry it
   * out" is written down instead of being lost. Omitting `apply` is NOT the same
   * as `observe` mode — the mode is a deployment choice that can be switched
   * off, and this is a property of the application.
   */
  apply?(input: {
    readonly action: TAction;
    readonly subject: EnforcementSubject;
    /**
     * What the most recent APPLIED row for this subject recorded, when there is
     * one. This is how a restore returns an object to what it WAS rather than to
     * a guess — and how a correction knows not to lift a content warning that
     * moderation never set.
     */
    readonly previousState?: EnforcementPreviousState;
    /** The action whose `previousState` was found, when one was. */
    readonly previousAction?: TAction;
    readonly decision: Decision;
  }): Promise<EnforcementEffect<TAction>>;

  /**
   * The action — or actions — whose earlier `previousState` `apply` should be
   * given, per action.
   *
   * `{ restore: 'restrict', unlabel_sensitive: 'label_sensitive' }` — a restore
   * needs to know what the restriction replaced. Omit for an action that undoes
   * nothing.
   *
   * A LIST when one action reverses several, which is the ordinary shape once an
   * application has more than one lever:
   * `{ restore: ['restrict', 'request_changes', 'freeze_transaction'] }`. The
   * lookup takes the most recent APPLIED row across the whole set, so `apply` is
   * handed whatever actually happened last rather than whatever single action
   * was declared — and `previousAction` names the row that was found, not the
   * list it came from.
   *
   * A single value is not merely awkward for such an application: it pushes it
   * into re-querying the ledger itself, which is exactly where the
   * `applied: true` filter lives. Re-implementing that per application is
   * per-application chances to omit it, and omitting it means a reversal reads a
   * row whose effect never happened.
   *
   * Credit: `mercaria`, whose `restore` reverses any of three depending on which
   * one the decision actually applied.
   */
  readonly reverses?: Partial<Record<TAction, TAction | readonly TAction[]>>;
}

/* ------------------------------------------------------------------------- */
/* Reports — the application's own model, with a shared moderation half       */
/* ------------------------------------------------------------------------- */

/**
 * Where a report stands in THIS application, independent of any verdict.
 *
 * Separate from whatever verdict field the application already had, because the
 * two answer different questions: this one is "did it get out of here and come
 * back", and it is the axis every query in this package uses.
 *
 * - `received` — stored, and never going anywhere: the reported type has no
 *   subject provider. Not a failure; a deliberate local-only report.
 * - `queued` — stored with a durable delivery event, in one transaction.
 * - `submitted` — CrowdSource has it; a case exists.
 * - `delivery_failed` — the last delivery attempt failed. The outbox is still
 *   retrying or has dead-lettered it.
 * - `closed` — a final or corrected decision was applied, or the material is
 *   gone and there is nothing to review.
 */
export type ModerationLocalStatus =
  | 'received'
  | 'queued'
  | 'submitted'
  | 'delivery_failed'
  | 'closed';

/**
 * The fields this package reads and writes on an application's report.
 *
 * The application owns the model, the collection, its own enums and any extra
 * fields; it composes the schema from `moderationReportSchemaFields` and passes
 * the resulting model in. Every query that carries a correctness property — the
 * decision-revision guard above all — lives in this package rather than being
 * re-derived seven times.
 */
export interface ModerationReportFields {
  /**
   * The report's own id, as a string.
   *
   * Declared here rather than left to whatever the backend calls its primary
   * key, because the core needs it in exactly one shape and in several places:
   * the delivery event's payload carries it, the deterministic event id is
   * derived from it, and reconciliation re-derives that id from the report. A
   * `String(document._id)` at each of those call sites is how two backends end
   * up disagreeing about what a report id looks like.
   */
  id: string;

  reportedType: string;
  reportedId: string;
  /** The reporting Oxy user id. The Oxy subject IS the binding proof. */
  reporter: string;
  categories: string[];
  details?: string;

  localStatus: ModerationLocalStatus;
  /** Why a report is not going anywhere, in words an operator can read. */
  localStatusReason?: string;

  crowdSourceReportId?: string;
  crowdSourceCaseId?: string;
  crowdSourceMerged?: boolean;
  contentSnapshotHash?: string;
  submittedAt?: Date;
  lastDeliveryError?: string;

  decisionId?: string;
  decisionRevision?: number;
  decisionOutcome?: string;
  decisionStatus?: string;
  decidedAt?: Date;
  enforcedAction?: string;
  enforcedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

/**
 * Extra `$set` fields to write when a decision lands on a report.
 *
 * The escape hatch for an application that already had a verdict field before it
 * adopted CrowdSource and must keep it working. A new application needs none of
 * this: `localStatus` and the `decision*` fields are the whole answer.
 *
 * Two status fields maintained by two call sites is how they drift, so an
 * application that has one derives it HERE, from the decision, and nowhere else.
 */
export type ReportDecisionExtraFields = Readonly<
  Record<string, string | number | boolean | Date>
>;

/* ------------------------------------------------------------------------- */
/* Host services                                                             */
/* ------------------------------------------------------------------------- */

/**
 * The application's logger.
 *
 * Structurally compatible with pino, winston and Mention's own. Nothing in this
 * package logs reported material — the contexts are ids, counts, states and
 * bounded error messages.
 */
export interface ModerationLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/** Optional counters. Labels are bounded; no value is ever user-supplied text. */
export interface ModerationMetrics {
  incrementCounter(name: string, value: number, labels: Record<string, string>): void;
}

/** Everything about talking to CrowdSource, and whether to at all. */
export interface CrowdSourceConnectionConfig {
  /**
   * Gates the DISPATCHER, never the durable record.
   *
   * Reports taken while the integration is off keep their outbox rows and
   * deliver when it is switched on. Running the loop instead would count
   * attempts against a deployment that has nowhere to send anything and
   * dead-letter the backlog it was meant to preserve.
   */
  readonly enabled: boolean;
  /** `applicationId:credentialId:secret`. The only source of `applicationId`. */
  readonly serviceKey?: string;
  readonly baseUrl?: string;
  readonly webhookSecret?: string;
  /** Accepted during a secret rotation. */
  readonly webhookPreviousSecret?: string;
  readonly enforcementMode: ModerationEnforcementMode;
  readonly outboxPollIntervalMs?: number;
  readonly outboxBatchSize?: number;
  /** How long a `submitted` report may wait before it is worth counting. */
  readonly staleSubmittedHours?: number;
  readonly reconciliationIntervalMs?: number;
}

/**
 * Everything the integration needs, in one object.
 *
 * `TReport` is the application's own report document type and must structurally
 * satisfy {@link ModerationReportFields}; `TAction` is the union of its
 * enforcement actions.
 */
export interface ModerationIntegrationConfig<
  TReport extends ModerationReportFields,
  TAction extends string,
> {
  /**
   * The application's Mongoose connection.
   *
   * Passed rather than taken from `mongoose.connection` so the models this
   * package registers cannot land on a different connection than the
   * application's own, and so two integrations can exist in one test process.
   * Transactions require a replica set; a standalone will fail on the first
   * intake rather than at boot, so assert the topology yourself.
   */
  readonly connection: Connection;
  readonly crowdSource: CrowdSourceConnectionConfig;

  /** The application's report model, built from `moderationReportSchemaFields`. */
  readonly reportModel: Model<TReport>;

  /**
   * Every noun this application can send for review.
   *
   * This list decides DELIVERY and nothing else. A reported type WITHOUT a
   * provider is still accepted and still stored — it simply never leaves. Making
   * it an admission gate breaks an application's existing report surfaces on the
   * day it adopts CrowdSource, and incremental adoption one subject type at a
   * time is the property that makes this package adoptable at all.
   */
  readonly subjects: readonly ModerationSubjectProvider[];
  readonly taxonomy: ModerationTaxonomy;
  readonly enforcement: ModerationEnforcementConfig<TAction>;

  readonly logger: ModerationLogger;
  readonly metrics?: ModerationMetrics;

  /** See {@link ReportDecisionExtraFields}. Omit unless you have a legacy field. */
  readonly reportDecisionExtraFields?: (decision: Decision) => ReportDecisionExtraFields;

  /**
   * Prefix for the model names registered on the connection.
   *
   * Only needed if the application already has a model called
   * `ModerationOutbox`, `ModerationEvent` or `ModerationEnforcement`.
   */
  readonly modelPrefix?: string;
}

/* ------------------------------------------------------------------------- */
/* Outbox                                                                     */
/* ------------------------------------------------------------------------- */

export type ModerationOutboxKind = 'report.submit' | 'decision.apply';

export type ModerationOutboxStatus =
  | 'pending'
  | 'processing'
  | 'processed'
  | 'dead_letter';

export interface ModerationOutboxPayload {
  /** The local report id, for `report.submit`. */
  reportId?: string;
  /** The inbound webhook event id, for `decision.apply`. */
  eventId?: string;
  caseId?: string;
  /**
   * The decision exactly as CrowdSource published it.
   *
   * Stored whole and opaque rather than projected into columns: the decision
   * document is deliberately loose, and a projection would silently drop
   * whatever a newer CrowdSource added. Validated against the published contract
   * when it is READ, so an event is never lost to a schema this deployment has
   * not caught up with.
   */
  decision?: unknown;
}

export interface ModerationOutboxEvent {
  /**
   * The deterministic event id — `moderation:report.submit:<reportId>` or
   * `moderation:decision.apply:<eventId>`.
   *
   * It IS the primary key on both backends, which is what makes a repeated
   * enqueue a no-op rather than a second delivery. Handlers key their downstream
   * effects on it, because the contract is at-least-once.
   */
  id: string;
  kind: ModerationOutboxKind;
  payload: ModerationOutboxPayload;
  attempts: number;
  availableAt: Date;
  leaseOwner?: string;
  leaseUntil?: Date;
  expiresAt: Date;
  createdAt: Date;
}

/* ------------------------------------------------------------------------- */
/* Results                                                                    */
/* ------------------------------------------------------------------------- */

export interface CreateReportInput {
  reporter: string;
  reportedType: string;
  reportedId: string;
  categories: readonly string[];
  details?: string;
  /**
   * Extra fields to store on the report document, for application columns this
   * package knows nothing about. Never used in a query filter here.
   */
  extra?: Readonly<Record<string, unknown>>;
}

export interface CreateReportResult<TReport> {
  report: TReport;
  /**
   * The durable delivery event.
   *
   * Absent exactly when the reported type has no subject provider — the report
   * was stored and there is nothing to deliver it, by design rather than by
   * failure.
   */
  outboxEventId?: string;
}

export interface ModerationDispatchResult {
  processed: number;
  failed: number;
  deadLettered: number;
}

export interface ModerationReconciliationResult {
  /** Reports that had no delivery event and now have one. */
  requeued: number;
  /** Reports whose delivery event is dead-lettered. Needs a human. */
  deadLettered: number;
  /** Reports submitted long ago with no decision yet. */
  awaitingDecision: number;
  /** Reports stored with no route to review at all. Never re-queued. */
  localOnly: number;
}

export interface EnforcementOutcome<TAction extends string> {
  /** The action that was PLANNED and claimed. Never rewritten. */
  action: TAction;
  /** What it amounted to, when `apply` said so. See {@link EnforcementEffect}. */
  recordedAs?: TAction;
  /**
   * `applied` — the effect happened. `recorded` — claimed and deliberately not
   * carried out (observe/manual mode, or nothing to do). `duplicate` — another
   * delivery of this same decision revision already handled it.
   */
  result: 'applied' | 'recorded' | 'duplicate';
}

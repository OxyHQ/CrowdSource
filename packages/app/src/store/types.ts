/**
 * The storage port: everything this package writes down, as a contract.
 *
 * INTERNAL, and deliberately so. An adopting application never implements any
 * of this — it imports the PostgreSQL subpath and the implementation ships with
 * the package. The port keeps storage mechanics out of policy code; it is not a
 * seam an application is invited to fill:
 * a port with this many members handed to seven applications would be seven
 * chances to get the revision guard, the lease ownership check or the
 * insert-if-absent wrong, each in a way nothing fails on.
 *
 * Which is why every member below carries the correctness property it has to
 * preserve. The comments are not documentation of an obvious signature; they
 * are the reason the implementation can be audited. A method whose
 * comment says `true` means THIS call took the claim cannot be implemented as
 * "row exists" without the difference being visible.
 *
 * Two rules shape the whole shape:
 *
 * 1. **The store applies transitions; it never decides them.** `fail` takes the
 *    status and the next attempt time already computed, `claim` takes an
 *    already-computed `leaseUntil`. Backoff, the retry ceiling, the lease-length
 *    floor and the retryable/permanent classification live in the shared half,
 *    outside the PostgreSQL query implementation.
 * 2. **No opaque record id crosses the port.** An enforcement row is addressed
 *    by the natural triple it is keyed on, so the same three values reach the
 *    same row through its PostgreSQL composite primary key.
 */

import type {
  EnforcementPreviousState,
  ModerationEnforcementMode,
  ModerationLocalStatus,
  ModerationOutboxEvent,
  ModerationOutboxKind,
  ModerationOutboxPayload,
  ModerationOutboxStatus,
  ModerationReportFields,
  ReportDecisionExtraFields,
} from '../types.js';

/* ------------------------------------------------------------------------- */
/* Transactions                                                               */
/* ------------------------------------------------------------------------- */

/**
 * The transaction a domain write and its outbox row commit inside.
 *
 * The core cannot know what a transaction IS — a Mongo `ClientSession` and a
 * drizzle transaction handle have nothing in common but the fact that carrying
 * one is what makes two writes atomic — so `TTx` is opaque here and is only
 * ever passed back to the store that produced it.
 *
 * What the runner owns is the guarantee, and it is the same on both backends:
 * two writes outside one transaction give two silent failure modes. A report
 * with no delivery event (nothing will ever send it, and nobody finds out until
 * somebody asks why a case never opened) or a delivery event with no report (a
 * worker looking up a row that was rolled back). Neither surfaces as an error at
 * the moment it happens, which is why this is atomic rather than carefully
 * ordered.
 */
export interface ModerationTransactionRunner<TTx> {
  /**
   * Run `operation` in one transaction and return its result.
   *
   * A backend may retry the operation on a transient conflict, so it must be
   * safe to run more than once — everything this package enqueues is keyed on a
   * deterministic id for exactly that reason.
   */
  run<T>(operation: (tx: TTx) => Promise<T>): Promise<T>;
}

/* ------------------------------------------------------------------------- */
/* Outbox                                                                     */
/* ------------------------------------------------------------------------- */

export interface ModerationOutboxStore<TTx> {
  /**
   * Insert-if-absent, in the CALLER's transaction. A true no-op for a row that
   * exists.
   *
   * Both halves of that sentence are load-bearing. The transaction is what makes
   * "the report was answered 201 and then vanished" impossible, and an
   * implementation that could write outside one is the single line that
   * reintroduces it — so an implementation MUST refuse a `tx` that is not
   * actually in a transaction, by throwing `ModerationOutboxTransactionError`.
   * A required parameter alone does not give this: a bare Mongo session nobody
   * opened a transaction on type-checks perfectly and commits the row on its
   * own.
   *
   * "A true no-op" is the other half. A repeated enqueue is ORDINARY — a
   * transaction retry, two concurrent duplicate submissions, a reconciliation
   * sweep re-deriving an event — and the dispatcher is concurrently taking,
   * renewing and completing leases on these same rows. An implementation that
   * merely avoids a duplicate ROW, but still writes (a touched `updatedAt`, an
   * `ON CONFLICT DO UPDATE`), conflicts with a live lease and aborts the
   * enclosing transaction. Nothing may be written for an id that already exists.
   *
   * `now`, `availableAt` and `expiresAt` are supplied rather than computed here
   * so that a row's timestamps come from one clock and one retention policy.
   *
   * **Writing a second implementation of this method:** the transaction guard is
   * proven by `scripts/test-invariants.mjs`, which DELETES it and requires the
   * mutated tree to still type-check — a mutation that does not compile is not
   * evidence about a guard. Since `ModerationOutboxTransactionError` is declared
   * in the shared half and IMPORTED by each store, deleting the throw on its own
   * leaves an unused import and fails `noUnusedLocals`. A mutation aimed at a new
   * store has to delete the import with it, which is also what removing the guard
   * actually looks like; the Mongoose one is the worked example.
   */
  enqueue(
    input: {
      eventId: string;
      kind: ModerationOutboxKind;
      payload: ModerationOutboxPayload;
      availableAt: Date;
      expiresAt: Date;
      now: Date;
    },
    tx: TTx,
  ): Promise<void>;

  /**
   * Atomically claim one due event, oldest first. `eventId` narrows to one row.
   *
   * Due means either `pending` and past its `availableAt`, or `processing` with
   * an EXPIRED lease — reclaiming the second is what stops a dead worker from
   * stranding moderation work forever. The read and the write must be one
   * operation: two workers evaluating "what is due" and then writing would both
   * take the same row.
   *
   * Claiming increments `attempts`, which is what the retry ceiling counts, and
   * clears the previous `lastError` so a stale message cannot be read as this
   * attempt's.
   */
  claim(input: {
    leaseOwner: string;
    leaseUntil: Date;
    now: Date;
    eventId?: string;
  }): Promise<ModerationOutboxEvent | null>;

  /**
   * Finish the event, and only under the lease THIS dispatcher owns.
   *
   * `false` means the lease was lost — expired, or taken by another task — and
   * the caller must not treat the delivery as recorded. The owner and expiry
   * checks belong in the write itself; a read-then-write leaves the window a
   * reclaim arrives in.
   */
  complete(input: { eventId: string; leaseOwner: string; now: Date }): Promise<boolean>;

  /**
   * Extend a lease that is still live and still owned. `false` means it is not.
   *
   * A renewal that could revive an EXPIRED lease would let two workers believe
   * they own one event, so `leaseUntil` must still be in the future for this to
   * match.
   */
  renew(input: {
    eventId: string;
    leaseOwner: string;
    leaseUntil: Date;
    now: Date;
  }): Promise<boolean>;

  /**
   * Release a failed claim with the transition the caller already decided.
   *
   * `status` is `pending` for a retry and `dead_letter` for a failure no retry
   * can fix; `availableAt` is the computed backoff. The store writes them and
   * checks the lease, exactly as {@link complete} does — `false` means the lease
   * was lost and the failure was not recorded by this worker.
   */
  fail(input: {
    eventId: string;
    leaseOwner: string;
    status: 'pending' | 'dead_letter';
    availableAt: Date;
    lastError: string;
    now: Date;
  }): Promise<boolean>;

  /**
   * The status of one event, or `null` when there is no such row.
   *
   * Read by reconciliation, where the two answers mean different things: `null`
   * is a report whose delivery event is genuinely missing and must be
   * re-derived, and `dead_letter` is one that must NOT be — it needs a human,
   * and re-queueing it would spin.
   */
  statusOf(eventId: string): Promise<ModerationOutboxStatus | null>;
}

/* ------------------------------------------------------------------------- */
/* Inbound events                                                             */
/* ------------------------------------------------------------------------- */

export interface ModerationEventStore<TTx> {
  /**
   * `true` when THIS call took the claim. Never throws for a duplicate.
   *
   * The insert IS the claim, so a duplicate id is not an error condition to work
   * around — it is the answer "somebody else has this event". Anything that is
   * not a duplicate — a lost connection, a failover — MUST be rethrown: it is
   * not "already processed", and answering `false` would make the receiver
   * answer 2xx and retire a decision nobody ever handled.
   */
  claim(input: { eventId: string; receivedAt: Date; expiresAt: Date }): Promise<boolean>;

  /**
   * Give the claim back so a redelivery can be processed.
   *
   * Called when the handler threw. Keeping the claim would make a transient
   * failure permanent and lose a decision silently.
   */
  release(eventId: string): Promise<void>;

  /**
   * Record a decision-bearing event as queued, in the caller's transaction.
   *
   * The transaction is what makes the dedupe safe: completing this row and
   * queueing the work separately would let a crash between them leave an event
   * that is permanently deduplicated with no work queued.
   */
  markQueued(
    input: { eventId: string; type: string; caseId: string; payload: unknown; now: Date },
    tx: TTx,
  ): Promise<void>;

  /**
   * Record an event there is nothing to do about.
   *
   * No outbox row, because no work — but the row is kept, because "did
   * CrowdSource tell us about this case, and when" is the first question asked
   * when a report looks stuck.
   */
  markIgnored(input: {
    eventId: string;
    type: string;
    caseId?: string;
    now: Date;
  }): Promise<void>;
}

/* ------------------------------------------------------------------------- */
/* Enforcement                                                                */
/* ------------------------------------------------------------------------- */

/**
 * The idempotency key of one enforcement row, and the only way to address one.
 *
 * `decisionId + revision + action`, which both backends can enforce as a
 * uniqueness constraint. `revision` is in the key deliberately: a correction is
 * a NEW revision, so the restore it asks for is a different action from the
 * removal that came before and must be allowed to happen — while still being
 * impossible to apply twice itself.
 */
export interface ModerationEnforcementKey {
  readonly decisionId: string;
  readonly decisionRevision: number;
  readonly action: string;
}

/** The whole row, as it is first written. `action` is the PLANNED action. */
export interface ModerationEnforcementInsert extends ModerationEnforcementKey {
  readonly caseId: string;
  /** The application's own noun. Never a CrowdSource resource id. */
  readonly subjectType: string;
  readonly subjectId: string;

  readonly outcome: string;
  readonly recommendedAction?: string;
  /** Why this action, in words an operator can read. Never reported material. */
  readonly reason: string;

  readonly mode: ModerationEnforcementMode;
  readonly now: Date;
}

export interface ModerationEnforcementStore {
  /**
   * Take the claim for this key. `false` means another delivery already holds
   * it. Not an error.
   *
   * The insert IS the check. Reading "have I done this?" before writing leaves
   * the window between them, which is precisely the window a redelivery arrives
   * in — and the consequence of losing that race is an object removed twice, or
   * an appeal restored twice.
   */
  claim(row: ModerationEnforcementInsert): Promise<boolean>;

  /**
   * Record that the claimed action was deliberately NOT carried out, and why.
   *
   * `recordedAs` corrects the label when the effect says the planned action did
   * not amount to what was planned; `action` itself never changes, because it is
   * half the idempotency key and it is what was decided.
   */
  markSkipped(
    key: ModerationEnforcementKey,
    input: { skippedReason: string; recordedAs?: string; now: Date },
  ): Promise<void>;

  /**
   * Record that the effect actually landed.
   *
   * `previousState` is the application's own opaque record of what the effect
   * replaced, and it is what makes reversibility real rather than aspirational —
   * a later restore returns the object to what it WAS rather than to a guess.
   */
  markApplied(
    key: ModerationEnforcementKey,
    input: { appliedAt: Date; previousState?: EnforcementPreviousState; now: Date },
  ): Promise<void>;

  /**
   * Delete a claim whose effect threw, so a retry can take it again.
   *
   * Without this a transient failure in `apply` would permanently consume the
   * one chance this decision revision had to act.
   */
  releaseClaim(key: ModerationEnforcementKey): Promise<void>;

  /**
   * The most recent APPLIED row across a declared action set, or `null`.
   *
   * Two properties, both proven by mutation rather than by a test that could
   * pass either way. **APPLIED**, because a row that was recorded and never
   * carried out describes a state change that never happened, and reversing to
   * it puts back something nobody removed. **The whole set**, because an
   * application whose `restore` reverses any of three levers needs whichever one
   * actually applied last — querying only the first declared action is silent
   * for every application that exercises its levers one at a time, and wrong
   * exactly when two of them applied.
   *
   * `action` comes back as a bare `string`: the store has no knowledge of the
   * application's action union, and the executor narrows it through the declared
   * set exactly as it does for a planned action.
   */
  latestApplied(input: {
    subjectType: string;
    subjectId: string;
    actions: readonly string[];
  }): Promise<{ action: string; previousState?: EnforcementPreviousState } | null>;
}

/* ------------------------------------------------------------------------- */
/* Reports                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Identity plus the two fields the decision worker needs, without loading a
 * whole report.
 *
 * One subject per case — the dedup key includes the subject's external id — so
 * the first of these names the object every report in the case is about.
 */
export interface ModerationReportRef {
  readonly id: string;
  readonly reportedType: string;
  readonly reportedId: string;
}

/**
 * What intake writes.
 *
 * `localStatus` and `localStatusReason` arrive already decided, from the one
 * fact that decides them both: whether the reported type has a subject provider.
 * A report can never be stored as `queued` with nothing to deliver it, nor as
 * `received` with a delivery event that will try anyway.
 *
 * `extra` is the adopter's own columns, stored as given and NEVER used in a
 * filter here.
 */
export interface ModerationReportInsert {
  readonly reportedType: string;
  readonly reportedId: string;
  readonly reporter: string;
  readonly categories: readonly string[];
  readonly details?: string;
  readonly localStatus: ModerationLocalStatus;
  readonly localStatusReason?: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * What a decision writes onto a report.
 *
 * `enforcedAction` is what the application DECIDED to do and `enforcedAt` is
 * when an effect actually landed; they are separate because they are different
 * claims. An action that was claimed and recorded — observe mode, or an
 * application with no sanction primitive — leaves `enforcedAt` absent while
 * `enforcedAction` still says what was decided.
 */
export interface ModerationReportDecisionUpdate {
  readonly localStatus: ModerationLocalStatus;
  readonly decisionId: string;
  readonly decisionRevision: number;
  readonly decisionOutcome: string;
  readonly decisionStatus: string;
  readonly decidedAt: Date;
  readonly enforcedAction?: string;
  readonly enforcedAt?: Date;
  /** The adopter's legacy verdict field, from `reportDecisionExtraFields`. */
  readonly extra?: ReportDecisionExtraFields;
}

export interface ModerationReportStore<TReport extends ModerationReportFields, TTx> {
  /**
   * The one report this reporter already filed about this object, if any.
   *
   * Read inside the intake transaction. Note what it does NOT promise: neither
   * backend serializes this check against a concurrent insert, so the
   * application's own "one report per reporter per object" unique index is what
   * finally decides a tie. This answers the ordinary case with a readable error
   * rather than a constraint violation.
   */
  findDuplicate(
    input: { reporter: string; reportedId: string; reportedType: string },
    tx: TTx,
  ): Promise<TReport | null>;

  /** Store the report, in the same transaction as its delivery event. */
  insert(input: ModerationReportInsert, tx: TTx): Promise<TReport>;

  /**
   * `null` — never a throw — for an id that does not exist OR is malformed.
   *
   * A delivery event can outlive its report, and an id that no backend can parse
   * is the same answer as an id nothing matches: there is nothing to deliver, so
   * the event completes rather than retrying for days against a row that will
   * never appear.
   */
  findById(reportId: string): Promise<TReport | null>;

  /** Every report that opened or joined this case. Ids and the subject only. */
  findByCaseId(caseId: string): Promise<ModerationReportRef[]>;

  /**
   * Apply a decision, refusing a revision older than the one already stored.
   *
   * The guard belongs in the WHERE clause, so it is the DATABASE that refuses a
   * stale write rather than a read-then-write in this process: deliveries
   * overlap — CrowdSource retries for 24 hours, and a correction can arrive
   * while the decision it supersedes is still being applied — and an older
   * revision landing last would otherwise overwrite the current answer.
   *
   * A report with NO stored revision must match. `<=` rather than `<` is
   * deliberate: a redelivery of the same revision rewrites, which is harmless
   * and keeps a partially-applied decision converging.
   *
   * `true` when one row matched.
   */
  applyDecision(
    reportId: string,
    update: ModerationReportDecisionUpdate,
    maxRevision: number,
  ): Promise<boolean>;

  /** CrowdSource accepted the report: a case exists. Clears any prior error. */
  markSubmitted(
    reportId: string,
    input: {
      crowdSourceReportId: string;
      crowdSourceCaseId: string;
      crowdSourceMerged: boolean;
      contentSnapshotHash: string;
      submittedAt: Date;
    },
  ): Promise<void>;

  /**
   * The last delivery attempt failed.
   *
   * Written on the REPORT, not only on the outbox row: `delivery_failed` is what
   * a reporter's receipt and the reconciliation sweep both read, and leaving the
   * report at `queued` while the outbox quietly backed off hides the problem in
   * a collection nobody looks at.
   */
  markDeliveryFailed(reportId: string, lastDeliveryError: string): Promise<void>;

  /** Close a report there is genuinely nothing left to do about, with a reason. */
  close(reportId: string, localStatusReason: string): Promise<void>;

  /**
   * `queued` + `delivery_failed`, oldest first, bounded. Ids only.
   *
   * `received` is excluded and the omission is the safety property, not an
   * oversight: those reports have no subject provider, so an event re-derived
   * for one would fail on its first attempt and dead-letter.
   */
  findPendingOldestFirst(limit: number): Promise<string[]>;

  /** Reports submitted before this instant with no decision yet. */
  countAwaitingDecision(submittedBefore: Date): Promise<number>;

  /** Reports stored with no route to review at all. Counted, never re-queued. */
  countLocalOnly(): Promise<number>;
}

/* ------------------------------------------------------------------------- */
/* The store                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * One object holding every write this package makes.
 *
 * Built by the PostgreSQL factory and passed in whole, so an application cannot
 * assemble pieces backed by different connections, which would put the report
 * and its outbox row in different transactions and silently undo the intake
 * guarantee.
 */
export interface ModerationStore<TReport extends ModerationReportFields, TTx> {
  readonly transaction: ModerationTransactionRunner<TTx>;
  readonly outbox: ModerationOutboxStore<TTx>;
  readonly events: ModerationEventStore<TTx>;
  readonly enforcement: ModerationEnforcementStore;
  readonly reports: ModerationReportStore<TReport, TTx>;
  /**
   * Asserts that the migrated PostgreSQL schema is present.
   *
   * Called once at wiring time. The unique indexes are the mechanism behind
   * every "exactly once" claim in this package, so they must exist before the
   * first write rather than whenever the driver gets round to it.
   */
  ensureSchema(): Promise<void>;
}

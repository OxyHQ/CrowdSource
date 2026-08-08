# `@oxyhq/crowdsource-app` — PostgreSQL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** give `@oxyhq/crowdsource-app` a PostgreSQL implementation, so an adopting backend chooses its storage by which subpath it imports and gets an identical moderation pipeline either way. Syra's moderation vertical — the last task of its Mongo→Postgres port — is blocked on this.

**Architecture:** an internal store port that **the package implements twice**. The core (intake, delivery, the decision worker, the outbox service, the webhook receiver, reconciliation, enforcement planning and execution) becomes storage-free and takes one `store`. Two subpaths supply one:

```
@oxyhq/crowdsource-app             storage-free core + createModerationIntegration({ store, … })
@oxyhq/crowdsource-app/mongoose    mongooseModerationStore({ connection, reportModel, … })
                                   + moderationReportSchemaFields() + applyModerationReportIndexes()
@oxyhq/crowdsource-app/postgres    postgresModerationStore({ db, reportTable, tables })
                                   + moderationTables({ enforcementActions })
                                   + moderationReportColumns()
                                   + moderationExpirySweepTargets() + moderationIdColumnsWithoutForeignKey()
```

An adopter never writes a store. The rejection recorded at `packages/app/src/models/report.ts:15-19` — *"a store port with ten methods for the application to implement was rejected"* — is about **who implements it**, and stays intact.

**Tech Stack:** `drizzle-orm` 0.45.2, `postgres` 3.4.9, `drizzle-kit` 0.31.10, `@oxyhq/db@^0.1.2`, mongoose 8/9, vitest 4, bun.

**Spec:** [`../specs/2026-08-06-crowdsource-app-postgres-design.md`](../specs/2026-08-06-crowdsource-app-postgres-design.md)

---

## Global Constraints

- **bun only.** Never `npm`, `yarn`, `npx` — use `bunx`. `bun.lock` is committed in the same commit as any `package.json` change; `scripts/check-lockfile-sync.mjs` is a required CI job and will fail otherwise.
- **CrowdSource's own server (`packages/backend`) stays on MongoDB.** That is a recorded owner decision (`AGENTS.md`). Nothing in this plan touches it. The scope is the ADOPTER half only — `packages/app`.
- **The package holds MECHANISMS, the consumer holds REGISTRIES.** `@oxyhq/db` is consumed, never re-implemented; a missing export is a defect to report upstream. The one place this package legitimately names tables is its OWN three — so it exports ready-made `ExpirySweepTarget`s and id-column ledger entries built over them, and the adopter merges those into its own registries.
- **The package ships NO migrations folder in the published tarball.** `@oxyhq/db`'s ledger applies a migration only when its journal timestamp is strictly newer than the newest recorded one (`migrate/ledger.ts:119-132`); two journals against one `drizzle.__drizzle_migrations` table interleave and the loser is skipped **in silence with exit 0**. The package ships table *definitions*; the adopter's own drizzle-kit run produces the SQL in the adopter's own journal. Task 13 gates this against the packed tarball, because §8 of the spec names it "the single recommendation most likely to be reversed by someone trying to be helpful".
- **The drizzle handle type is `PgDatabase<PgQueryResultHKT, Record<string, unknown>, TablesRelationalConfig>`.** Verified by the spec's probe 2: it accepts both a real `PostgresJsDatabase` and the `tx` inside `db.transaction(cb)`, and the full builder API is reachable through it. The obvious narrow spelling (`Record<string, never>` for both schema generics) accepts **neither** — the schema generic is invariant, `TS2345`.
- **`PgTransaction` is a real runtime export of `drizzle-orm/pg-core`** (verified: `typeof === 'function'`, an abstract class extending `PgDatabase`). `tx instanceof PgTransaction` is the direct analogue of `session.inTransaction()`.
- **Postgres transactions run at READ COMMITTED, explicitly** — `db.transaction(cb, { isolationLevel: 'read committed' })`. Not `repeatable read`: neither multi-statement transaction (report insert + outbox upsert; event update + outbox upsert) reads-then-decides in a way snapshot isolation protects, and `repeatable read` imports `40001` serialization failures and a retry loop for no benefit. Intake's duplicate-check-then-insert is **not serialized by either backend** — Mongo's snapshot isolation does not prevent that phantom either, and the "one report per reporter per object" unique index is explicitly the application's (`models/report.ts:134-137`). Both backends are equally advisory here; do not re-discover it as a Postgres defect.
- **`SKIP LOCKED` is load-bearing, not tuning.** The claim is `UPDATE … WHERE id IN (SELECT id … ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING …`. Without it, under READ COMMITTED the subselect is evaluated once, the loser blocks on the head row and then returns **zero rows** — `claim` answers `null`, `dispatch` breaks out of its batch (`outbox/service.ts:456`), and a multi-task deployment silently drains at 1/N the rate with nothing failing.
- **`INSERT … ON CONFLICT (id) DO NOTHING` everywhere an insert-if-absent is needed. Never `DO UPDATE`.** `DO UPDATE` reintroduces the exact bug the Mongo side's `timestamps: false` exists to prevent: a repeated enqueue becomes a real write, which conflicts with a live lease and aborts the enclosing transaction.
- **The revision guard lives in the WHERE clause**: `or(isNull(decisionRevision), lte(decisionRevision, revision))`. `$exists: false` ≡ `IS NULL` because the port stores an absent value as NULL. `<=` not `<` is deliberate — a redelivery of the same revision rewrites.
- **Driver errors are read through `@oxyhq/db`'s predicates, never `error.code`.** drizzle wraps the driver failure, so `code` and `constraint_name` live on `cause`; a hand-written check matches **nothing** and every call site is a `catch` that rethrows. Use `isUniqueViolation(error, constraintName)`, `constraintNameOf`, `describeDriverError`.
- **Never log a driver error object.** postgres.js attaches the failing statement and its bound parameters, and Postgres's `detail` reads `Failing row contains (…)`. `logger.warn(msg, { error })` therefore publishes reported material into a log, which breaks the package's standing invariant that sensitive content never reaches logs. Every catch that logs uses `describeDriverError(error)`.
- **Every Postgres column is named explicitly** — `text('crowdsource_report_id')`, not `crowdSourceReportId: text()`. Drizzle's snake_case derivation mangles digit- and capital-adjacent names (`cacheS3Key` → `cache_s_3_key`), the SQL name must match what the adopter's migration created, and a derived name is a name nobody decided. `DATABASE_CASING` from `@oxyhq/db` is still configured on the handle, because it is what `sqlColumnName`/`qualified` and the adopter's `drizzle.config.ts` read.
- **String bounds are `varchar(n)` AND the existing application-side slices stay.** `reason` 500, `skippedReason` 300, `lastError` 2000, `lastDeliveryError` 2000, `localStatusReason` 300, `details` 2000 (default). Mongoose validators *throw* on overflow and Postgres errors `22001` rather than truncating — the slices at `executor.ts:189`, `:250` and `service.ts:331` are what make both dialects agree. Do not remove them.
- **Closed value sets are `text` + a CHECK built from the same tuple that types the column** (`inList` / `textArrayLiteral` from `@oxyhq/db`), never a Postgres `enum` type. Adding an enforcement action therefore becomes a migration where Mongo only needed a restart. That is the correct trade: a stored action outside the declared set is exactly what the enum exists to refuse.
- **Retention.** `MODERATION_OUTBOX_RETENTION_SECONDS` and `MODERATION_EVENT_RETENTION_SECONDS` are both `90 * 24 * 60 * 60`. Mongo's two TTL indexes (`expireAfterSeconds: 0` on `expiresAt`) have no Postgres counterpart; `@oxyhq/db/expiry` is the replacement and a table ported without a registry entry grows forever with no error and no failing test.
- **No adopters exist.** No committed manifest in `~/Oxy` depends on `@oxyhq/crowdsource-app`. Every breaking change in this plan is a **clean cut**: remove the old identifier entirely, update every call site including comments, ship. No `@deprecated`, no alias, no re-export shim, no migration guide.
- **Mongo stays first-class.** Six of the seven candidate backends declare only `mongoose`. Every task that touches the shared half must leave the Mongo suite green.
- Standing repo rules: no `as any`, no `@ts-ignore`/`@ts-expect-error`, no `!` non-null assertion, no `any` in a signature, no silent `catch {}`, no TODO/FIXME/HACK, no `console.log`, no re-export barrels.
- **`SqlExecutor.execute` is NOT generic** — `execute(query: SQL): Promise<Record<string, unknown>[]>`. Row typing comes from the free function `executeRows<TRow>(executor, query)`, which **rejects named `interface`s**: declare row shapes as `type` aliases or get `TS2344`.
- **Never `git checkout <file>` / `git restore <file>` to undo a mutation** — it restores to the last commit, which mid-task is not your baseline. `scripts/test-invariants.mjs` already keeps an in-memory pristine copy and restores by hash; keep that property in anything you add to it.
- **`scripts/test-invariants.mjs` mutates `src/` in place and this tree is shared with other agents' worktrees.** Run it from an isolated worktree, never concurrently with another session's measurements.

---

## Corrections to the spec, decided here

Five claims in the design do not survive contact with the tree. Each is decided now so no task re-litigates it.

1. **"Not one test body changes" (§4.1) is false.** All five storage test files assert directly against Mongoose models — `harness.moderation.models.outbox.countDocuments({})`, `harness.reports.findById(id).lean()`, `harness.widgets.create({…})`, `new mongoose.Types.ObjectId()` — and `outboxTransactionCoupling.test.ts` additionally drives `connection.startSession()` / `session.withTransaction()` directly and hands the session to `enqueue`. `describe.each` over two backends is impossible until those assertions go through a backend-neutral façade. **Task 5 exists entirely for this** and is the largest single deviation from the spec's sizing.
2. **G13 evaporates, and its "explicit branch" must not be written.** The spec assumes a `uuid`-typed report id, which raises `22P02 invalid_text_representation` on a garbage id. `@oxyhq/db`'s `generatedId()` is **`text`**, deliberately, so ObjectId hex and uuid v7 can coexist in one id space. A malformed id against a `text` column matches no rows and `findById` answers `null` — which is exactly the Mongo behaviour `delivery.ts:88-97` already handles. Use `text`. Keep a test that proves it (Task 10); do not add a branch.
3. **`check:module-format` already enumerates every `exports` subpath** (`Object.entries(manifest.exports)`), so new subpaths are covered the moment they are declared. The spec's worry is misplaced — but its conclusion is right for a different reason: the script's vacuity floor is `entriesChecked < PUBLISHED.length`, a scalar that does not rise, so a manifest that silently *loses* `./postgres` still passes. Task 3 replaces the scalar with a per-package minimum.
4. **The id-column ledger is eight columns, not six (§3).** `findIdColumnViolations` skips a column only when `column.primary` is set, and a composite primary key declared in a table's extra config does **not** set `column.primary` on its members. So `moderation_enforcements.decision_id` is scanned despite being part of the PK. The full set is enumerated in Task 6.
5. **Uncertainty 6 is resolved: `@oxyhq/crowdsource-testing` is storage-free.** `grep -rln 'mongoose\|mongodb' packages/testing/src` returns nothing across `fixtures.ts`, `sandbox.ts`, `webhook-simulator.ts`, `index.ts`. No half-day contingency needed.

Two further public-surface moves the spec's "nothing else in the public surface moves" (§1.2) does not mention, both unavoidable and both clean cuts: `ModerationIntegration` loses `models: ModerationModels` (three Mongoose `Model`s) and `outbox`, neither of which any non-test caller reads; and `moderationReportSchemaFields` / `applyModerationReportIndexes` / the `MODERATION_*_COLLECTION` constants / `Moderation*Document` types move from the root to `/mongoose`.

---

## The store port

Defined once in Task 1, consumed by every later task. Reproduced here in full because each task's implementer sees only its own task.

```ts
// src/store/types.ts

/** The transaction a domain write and its outbox row commit inside. */
export interface ModerationTransactionRunner<TTx> {
  run<T>(operation: (tx: TTx) => Promise<T>): Promise<T>;
}

export interface ModerationOutboxStore<TTx> {
  /** Insert-if-absent, in the CALLER's transaction. A true no-op for a row that exists. */
  enqueue(
    input: { eventId: string; kind: ModerationOutboxKind; payload: ModerationOutboxPayload; availableAt: Date; expiresAt: Date; now: Date },
    tx: TTx,
  ): Promise<void>;
  /** Atomically claim one due event, oldest first. `eventId` narrows to one row. */
  claim(input: { leaseOwner: string; leaseUntil: Date; now: Date; eventId?: string }): Promise<ModerationOutboxEvent | null>;
  complete(input: { eventId: string; leaseOwner: string; now: Date }): Promise<boolean>;
  renew(input: { eventId: string; leaseOwner: string; leaseUntil: Date; now: Date }): Promise<boolean>;
  fail(input: { eventId: string; leaseOwner: string; status: 'pending' | 'dead_letter'; availableAt: Date; lastError: string; now: Date }): Promise<boolean>;
  statusOf(eventId: string): Promise<ModerationOutboxStatus | null>;
}

export interface ModerationEventStore<TTx> {
  /** `true` when THIS call took the claim. Never throws for a duplicate. */
  claim(input: { eventId: string; receivedAt: Date; expiresAt: Date }): Promise<boolean>;
  release(eventId: string): Promise<void>;
  markQueued(input: { eventId: string; type: string; caseId: string; payload: unknown; now: Date }, tx: TTx): Promise<void>;
  markIgnored(input: { eventId: string; type: string; caseId?: string; now: Date }): Promise<void>;
}

export interface ModerationEnforcementKey {
  readonly decisionId: string;
  readonly decisionRevision: number;
  readonly action: string;
}

export interface ModerationEnforcementInsert extends ModerationEnforcementKey {
  readonly caseId: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly outcome: string;
  readonly recommendedAction?: string;
  readonly reason: string;
  readonly mode: ModerationEnforcementMode;
  readonly now: Date;
}

export interface ModerationEnforcementStore {
  /** `false` means another delivery already holds this key. Not an error. */
  claim(row: ModerationEnforcementInsert): Promise<boolean>;
  markSkipped(key: ModerationEnforcementKey, input: { skippedReason: string; recordedAs?: string; now: Date }): Promise<void>;
  markApplied(key: ModerationEnforcementKey, input: { appliedAt: Date; previousState?: EnforcementPreviousState; now: Date }): Promise<void>;
  releaseClaim(key: ModerationEnforcementKey): Promise<void>;
  /** The most recent APPLIED row across a declared action set, or `null`. */
  latestApplied(input: { subjectType: string; subjectId: string; actions: readonly string[] }): Promise<{ action: string; previousState?: EnforcementPreviousState } | null>;
}

/** Identity + the two fields the decision worker needs, without loading a whole report. */
export interface ModerationReportRef {
  readonly id: string;
  readonly reportedType: string;
  readonly reportedId: string;
}

/** What intake writes. `extra` is the adopter's own columns, never used in a filter. */
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

/** The `$set` payload `decision.ts:84-108` builds, as a plain object. */
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
  findDuplicate(input: { reporter: string; reportedId: string; reportedType: string }, tx: TTx): Promise<TReport | null>;
  insert(input: ModerationReportInsert, tx: TTx): Promise<TReport>;
  /** `null` — never a throw — for an id that does not exist OR is malformed. */
  findById(reportId: string): Promise<TReport | null>;
  findByCaseId(caseId: string): Promise<ModerationReportRef[]>;
  /** The revision guard is in the WHERE clause. `true` when one row matched. */
  applyDecision(reportId: string, update: ModerationReportDecisionUpdate, maxRevision: number): Promise<boolean>;
  markSubmitted(reportId: string, input: { crowdSourceReportId: string; crowdSourceCaseId: string; crowdSourceMerged: boolean; contentSnapshotHash: string; submittedAt: Date }): Promise<void>;
  markDeliveryFailed(reportId: string, lastDeliveryError: string): Promise<void>;
  close(reportId: string, localStatusReason: string): Promise<void>;
  /** `queued` + `delivery_failed`, oldest first, bounded. Ids only. */
  findPendingOldestFirst(limit: number): Promise<string[]>;
  countAwaitingDecision(submittedBefore: Date): Promise<number>;
  countLocalOnly(): Promise<number>;
}

export interface ModerationStore<TReport extends ModerationReportFields, TTx> {
  readonly transaction: ModerationTransactionRunner<TTx>;
  readonly outbox: ModerationOutboxStore<TTx>;
  readonly events: ModerationEventStore<TTx>;
  readonly enforcement: ModerationEnforcementStore;
  readonly reports: ModerationReportStore<TReport, TTx>;
  /** Creates indexes (Mongo) or asserts the migrated schema is present (Postgres). */
  ensureSchema(): Promise<void>;
}
```

Three properties of this shape, each deliberate:

- **The store applies transitions; it never decides them.** `fail` takes the already-computed `status` and `availableAt`, `claim` takes an already-computed `leaseUntil`. `MAX_RETRYABLE_ATTEMPTS`, `nextAttemptAt`, `isRetryableDeliveryError` and the lease-length floor stay in the shared half, where they cannot be re-derived differently by two backends.
- **The enforcement key is the natural triple on both backends.** No opaque record id crosses the port, so `markApplied`/`markSkipped`/`releaseClaim` address the same row on Mongo (via its unique index) and on Postgres (via its composite primary key). One fewer type parameter, and the two backends agree by construction.
- **`ModerationReportFields` gains `readonly id: string`** and `ModerationOutboxEvent._id` is renamed `id`. Both stores produce `id`; the Mongoose store maps `_id → id` on every read and insert. This removes `String(created._id)` from the core entirely.

---

### Task 1: The store port, the transaction runner, and the Mongoose outbox store

The highest-risk seam and the one three of the eleven proven mutations attack. It lands first so the port's shape is settled before fourteen more operations are written against it.

**Files:**
- Create: `packages/app/src/store/types.ts`
- Create: `packages/app/src/mongoose/store/outbox.ts`, `packages/app/src/mongoose/store/transaction.ts`
- Modify: `packages/app/src/outbox/service.ts` (becomes storage-free), `packages/app/src/types.ts` (`ModerationOutboxEvent._id` → `id`, add `ModerationReportFields.id`), `packages/app/src/integration.ts` (builds the Mongoose outbox store internally, keeps its `connection` config for now), `packages/app/src/intake.ts`, `packages/app/src/inbound.ts`, `packages/app/src/reconciliation.ts`, `packages/app/src/outbox/dispatcher.ts`, `packages/app/src/index.ts`
- Modify: `packages/app/src/__tests__/outboxTransactionCoupling.test.ts` (the `_id` → `id` rename only)
- Modify: `packages/app/scripts/test-invariants.mjs` (mutations 1, 3 and 4 move to the new file paths)

**Interfaces:**
- Produces: every type in "The store port" above, but only `ModerationTransactionRunner<TTx>` and `ModerationOutboxStore<TTx>` are implemented. `ModerationStore` is declared with all five members; Task 2 fills the other three.
- Produces: `mongooseTransactionRunner(connection: Connection): ModerationTransactionRunner<ClientSession>` and `mongooseOutboxStore(input: { model: Model<ModerationOutboxDocument> }): ModerationOutboxStore<ClientSession>`.
- Later tasks rely on: `ModerationOutboxTransactionError` keeping its exported name and message; `createOutboxService({ store, logger })` replacing `createOutboxService({ model, logger })`; `OutboxService.enqueue(input, tx: TTx)` keeping its required-transaction signature.

- [ ] **Step 1: Write `src/store/types.ts`**

Exactly the port above. Every member carries the doc comment explaining its correctness property, ported from the call site it replaces — those comments are the reason the port is internal.

- [ ] **Step 2: Make `outbox/service.ts` storage-free**

`createOutboxService` takes `{ store: ModerationOutboxStore<TTx>; logger }`. Every Mongoose query moves out; the policy stays. Specifically these stay in `service.ts`: `DEFAULT_LEASE_MS`, `DEFAULT_BATCH_SIZE`, `MAX_BATCH_SIZE`, `MAX_BACKOFF_MS`, `MIN_LEASE_RENEW_INTERVAL_MS`, `MAX_RETRYABLE_ATTEMPTS`, `nextAttemptAt`, `isRetryableDeliveryError`, `reportSubmitEventId`, `decisionApplyEventId`, `startLeaseHeartbeat`, `dispatch`, and the `expiresAt` computation from `MODERATION_OUTBOX_RETENTION_SECONDS`. `claimFilter` moves into the store — it is the query.

The transaction guard moves too: `enqueue` no longer calls `session.inTransaction()`, because the core cannot know what a transaction is. The store's `enqueue` throws `ModerationOutboxTransactionError` instead. The error class stays exported from the core so both stores throw the same one.

- [ ] **Step 3: Write the Mongoose transaction runner and outbox store**

`mongooseTransactionRunner` carries the transaction options verbatim from `intake.ts:36-40`: `{ readPreference: 'primary', readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }`.

`mongooseOutboxStore.enqueue` keeps the `{ upsert: true, session, timestamps: false }` options literal and the explicit `createdAt`/`updatedAt` **exactly as they are today**, including the 60-line comment at `service.ts:347-403` that explains why. That comment documents a shipped total-failure bug and a measured behaviour table; it moves with the code it explains.

`claim`, `complete`, `renew`, `fail`, `statusOf` move verbatim, with `matchedCount`/`modifiedCount` reads unchanged.

- [ ] **Step 4: Update the three transaction call sites**

`intake.ts`, `inbound.ts` and `reconciliation.ts` stop building sessions and call `store.transaction.run(cb)`. Their own `TRANSACTION_OPTIONS` constants and `inTransaction` helpers are deleted, not moved — there is one runner now.

`reconciliation.ts` keeps its comment explaining why a single upsert still runs in a transaction (*"the enqueue requires a session precisely so that no path in this package can write an outbox event outside one"*), rewritten for the runner.

- [ ] **Step 5: Rename `ModerationOutboxEvent._id` to `id`**

Clean cut. Update `types.ts`, `outbox/service.ts`, `outbox/dispatcher.ts`, `delivery.ts`, `decision.ts`, `reconciliation.ts` and the test files that read it. Grep for `event._id` and `\._id` under `src/` and confirm no remaining reference outside `src/mongoose/`.

- [ ] **Step 6: Point the three moved mutations at their new file**

`scripts/test-invariants.mjs` mutations 1, 3 and 4 all target `src/outbox/service.ts`. Mutation 1 (`session.inTransaction()`) now lives in `src/mongoose/store/outbox.ts` and its `find` text changes with the guard's new shape; mutations 3 and 4 (`{ upsert: true, session, timestamps: false }`) move to the same file with their `find`/`absent` markers unchanged.

The script refuses an inexact marker by design (*"the text this mutation replaces is no longer present"*), so a wrong path fails loudly rather than silently skipping.

- [ ] **Step 7: Green, and mutation-proven**

```bash
cd /home/nate/Oxy/CrowdSource
bun run --cwd packages/app lint
bun run --cwd packages/app test:unit
bun run --cwd packages/app test:invariants
```

All 62 tests pass and all 11 mutations are confirmed caught. **Paste the invariant script's final line** — `The guards hold: 11 mutations applied, type-checked, and caught.` A number below 11 is a task failure, not a warning.

- [ ] **Step 8: Commit** — `refactor(app): extract the storage port and the Mongoose outbox store`

---

### Task 2: The Mongoose event, enforcement and report stores

The remaining fourteen operations. Mechanical next to Task 1, but it is where `models/index.ts` and `models/report.ts` finally move and where every remaining Mongoose import leaves the core.

**Files:**
- Create: `packages/app/src/mongoose/store/events.ts`, `store/enforcement.ts`, `store/reports.ts`, `packages/app/src/mongoose/store/index.ts`
- Move: `packages/app/src/models/index.ts` → `packages/app/src/mongoose/models.ts`; `packages/app/src/models/report.ts` → `packages/app/src/mongoose/report.ts`. Delete `src/models/`.
- Modify: `packages/app/src/inbound.ts`, `enforcement/executor.ts`, `decision.ts`, `delivery.ts`, `intake.ts`, `reconciliation.ts`, `integration.ts`, `index.ts`, `types.ts`
- Modify: `packages/app/scripts/test-invariants.mjs` (mutations 6 and 8 move to `src/mongoose/store/enforcement.ts`)

**Interfaces:**
- Consumes: everything Task 1 produced.
- Produces: `mongooseModerationStore(input: { connection: Connection; reportModel: Model<TReport>; enforcementActions: readonly string[]; modelPrefix?: string }): ModerationStore<TReport, ClientSession>` — one factory returning all five members plus `ensureSchema()`, which calls `.init()` on all three registered models and the report model.
- Consumes: `ModerationReportInsert` and `ModerationReportDecisionUpdate`, declared by Task 1 in `src/store/types.ts` and first implemented here.

- [ ] **Step 1: Write the event store**

`claim` keeps the `isDuplicateKeyError` catch and the comment at `inbound.ts:79-86` explaining why everything that is not 11000 is rethrown. `markQueued` takes the transaction. `release` is the delete.

- [ ] **Step 2: Write the enforcement store**

`claim` returns `false` on 11000 and rethrows everything else. `latestApplied` keeps `applied: true` in the filter and the `sort({ createdAt: -1 })`, and takes the whole candidate set (`$in`) — both are attacked by proven mutations 6 and 8, so their exact shape is load-bearing.

Note in the code where the narrowing of `row.action` back to `TAction` now happens: it moves to `executor.ts`, which still owns `config.reverses` and the `candidates.find(...)` narrowing at `executor.ts:155`. The store returns a bare `string`; the executor narrows it through the declared set exactly as it does today. Do not narrow inside the store — it has no `TAction`.

- [ ] **Step 3: Write the report store**

Ten methods. `findById` maps `_id → id` on the returned lean object; so do `insert`, `findDuplicate` and `findByCaseId`. `applyDecision` keeps `$or: [{ decisionRevision: { $exists: false } }, { decisionRevision: { $lte: maxRevision } }]` in the FILTER and returns `matchedCount === 1`.

`findById` must answer `null` rather than throwing for a malformed id: Mongoose raises a `CastError` on a non-ObjectId string. Catch `CastError` specifically (by `error.name`), return `null`, and rethrow anything else. This is the Mongo half of what makes both backends agree about `delivery.ts:88-97`.

- [ ] **Step 4: Rewire the core**

`intake.ts`, `delivery.ts`, `decision.ts`, `reconciliation.ts`, `inbound.ts`, `enforcement/executor.ts` take store members instead of models. `requireIdentifier` in `intake.ts` **stays**, but its doc comment is rewritten rather than copied: in Postgres a bound parameter cannot become a query operator, so the `{ $ne: null }` failure class does not exist there. The guard survives because a non-string still corrupts data and the function is exported for callers with no route validation — but the comment must not assert a hazard the Postgres backend does not have.

- [ ] **Step 5: Confirm the core is storage-free**

```bash
grep -rn "from 'mongoose'" packages/app/src --include=*.ts | grep -v '/mongoose/' | grep -v '__tests__'
```

Expected: no output. **Paste it.** Six files were already storage-free (`webhook.ts`, `client.ts`, `evidence.ts`, `enforcement/planner.ts`, `outbox/dispatcher.ts`, `reportStatus.ts`); this proves the other ten now are too.

- [ ] **Step 6: Green, and mutation-proven** — same three commands as Task 1, same 11/11 requirement.

- [ ] **Step 7: Commit** — `refactor(app): the remaining Mongoose stores; the core no longer imports mongoose`

---

### Task 3: Subpath build machinery, the `/mongoose` subpath, and optional peers

A new export condition is what took a consumer's backend down on 2026-07-30 (`README.md:28-49`). This task lands the mechanism and the guards for it before any second store exists, so the failure mode is proven closed once rather than twice.

**Files:**
- Modify: `packages/app/package.json` (`exports`, `peerDependencies`, `peerDependenciesMeta`, `devDependencies`)
- Create: `packages/app/src/mongoose/index.ts` (the subpath entry)
- Modify: `packages/app/src/index.ts` (root stops exporting the Mongoose surface)
- Modify: `packages/app/scripts/` — none; `packages/app/tsconfig.esm.json` and `tsconfig.json` already emit the whole `src/` tree, so a subdirectory needs no build change. **Verify this rather than assuming it.**
- Modify: `scripts/check-module-format.mjs`, `scripts/test-check-module-format.mjs`
- Modify: `packages/app/README.md`

**Interfaces:**
- Produces: `@oxyhq/crowdsource-app/mongoose` exporting `mongooseModerationStore`, `moderationReportSchemaFields`, `applyModerationReportIndexes`, `MODERATION_LOCAL_STATUSES`, `MODERATION_OUTBOX_COLLECTION`, `MODERATION_EVENT_COLLECTION`, `MODERATION_ENFORCEMENT_COLLECTION`, and the three `Moderation*Document` types plus `ModerationReportSchemaOptions`.
- Root keeps: `createModerationIntegration`, every error class, `MODERATION_OUTBOX_RETENTION_SECONDS`, `MODERATION_EVENT_RETENTION_SECONDS`, the planner exports, `createSubjectRegistry`, `snapshotHash`, `localStatusForDecision`, `createProcessedEventStore`, and every type in `types.ts` and `src/store/types.ts`.

- [ ] **Step 1: Declare the subpath**

```json
"./mongoose": {
  "types": "./dist/mongoose/index.d.ts",
  "import": "./dist/esm/mongoose/index.js",
  "require": "./dist/mongoose/index.js",
  "default": "./dist/mongoose/index.js"
}
```

`dist/esm/package.json` (`{"type":"module"}`) is written by `write-esm-marker.mjs` at the ESM ROOT. At RUNTIME that is correct and sufficient: Node resolves a file's module type from the nearest `package.json` walking **upward**, so `dist/esm/package.json` governs `dist/esm/mongoose/index.js` too. Do not write a second marker per subdirectory.

The CHECK is what breaks. `check-module-format.mjs` looks the marker up as `resolve(packageDir, dirname(esm), 'package.json')`, which for this entry is `dist/esm/mongoose/package.json` — absent, so the check reports a false failure saying the whole ESM half is inert. **Fix the check, not the build**: make the marker lookup walk upward from `dirname(esm)` to the package root and take the first `package.json` it finds, exactly as Node does. Add a case to `scripts/test-check-module-format.mjs` proving both directions — a fixture with the marker only at `dist/esm/` passes, and a fixture with no marker anywhere still fails.

- [ ] **Step 2: Make the peers optional**

```json
"peerDependencies": {
  "@oxyhq/crowdsource-contracts": "^0.4.0",
  "@oxyhq/db": "^0.1.2",
  "drizzle-orm": "^0.45.2",
  "express": ">=4.18.0 <6",
  "mongoose": "^8.0.0 || ^9.0.0",
  "postgres": "^3.4.9"
},
"peerDependenciesMeta": {
  "@oxyhq/db": { "optional": true },
  "drizzle-orm": { "optional": true },
  "mongoose": { "optional": true },
  "postgres": { "optional": true }
}
```

`express` and `@oxyhq/crowdsource-contracts` stay required. `postgres` is listed even though this package never imports it: `@oxyhq/db` peers on it, and an optional peer here makes the transitive requirement visible at install time rather than at first import. Add all four to `devDependencies` — a peer is not installed for you, and `check-peer-contracts.mjs` already enforces that rule for contracts.

- [ ] **Step 3: Raise the module-format vacuity floor**

Replace `entriesChecked < PUBLISHED.length` with a per-package expected minimum. `PUBLISHED` becomes a map: `{ contracts: 1, sdk: 1, "sdk-express": 1, testing: 1, app: 2 }` (3 after Task 11), counted per package rather than in aggregate, so a manifest that loses one subpath fails while its siblings still pass.

**What this must catch:** delete the `./mongoose` entry from `packages/app/package.json` and the check must fail naming `app`. Under the current scalar floor it passes. Add exactly that case to `scripts/test-check-module-format.mjs`, which already drives the check against fixture trees via `bun scripts/check-module-format.mjs <root>`.

- [ ] **Step 4: Prove the packed artifact loads, both ways**

The two manual checks from `README.md:51-75`, now per subpath. They fail differently and only the second catches the 2026-07-30 defect:

```bash
cd /home/nate/Oxy/CrowdSource/packages/app && bun run build && bun pm pack
mkdir -p /tmp/claude-1000/-home-nate-Oxy-Syra/*/scratchpad/esm-check && cd $_
bun add <path>/oxyhq-crowdsource-app-*.tgz @oxyhq/crowdsource-contracts mongoose express
node --input-type=module -e "import('@oxyhq/crowdsource-app/mongoose').then(m => console.log(Object.keys(m).length))"
# then an esbuild ESM consumer of the same subpath, with --external:'@oxyhq/*'
```

**Paste both outputs.** A non-zero key count from the first and a running bundle from the second.

- [ ] **Step 5: `bun run check` at the repository root** — this runs `doctor`, `check:peers`, the build, `check:dist`, `check:schemas`, `check:module-format` and `lint` in one pass.

- [ ] **Step 6: Commit** — `feat(app): the /mongoose subpath, with optional peers and a per-package format floor`

---

### Task 4: The config clean cut — `store` replaces `connection`, `reportModel` and `modelPrefix`

The public API change. Free, because nothing consumes it: seven candidate backends pin the *client* packages at `0.3.0` and hand-roll the adopter half, and the only `crowdsource-app` reference anywhere is an unmerged branch pointing at a local tarball.

**Files:**
- Modify: `packages/app/src/types.ts` (`ModerationIntegrationConfig`), `packages/app/src/integration.ts`, `packages/app/src/index.ts`
- Modify: `packages/app/src/__tests__/support/harness.ts`, `packages/app/src/__tests__/reviewOnlyApplication.test.ts`
- Modify: `packages/app/README.md`

**Interfaces:**
- `ModerationIntegrationConfig<TReport, TAction, TTx>` loses `connection`, `reportModel`, `modelPrefix` and gains `readonly store: ModerationStore<TReport, TTx>`. Everything else — `crowdSource`, `subjects`, `taxonomy`, `enforcement`, `logger`, `metrics`, `reportDecisionExtraFields` — is unchanged.
- **`ModerationIntegration<TReport, TAction>` keeps exactly two type parameters, and loses two members: `models` and `outbox`.** `TTx` appears only on the config, is inferred from `store`, and is used only inside the factory. That is what keeps the returned interface — and therefore `Harness` in Task 5 — free of a type parameter whose value differs per backend, which a single `describe.each` over both cannot tolerate. `models` and `outbox` were reached only from test bodies (verified: no non-test file outside `integration.ts` reads either); Task 5 gives the harness what those tests actually needed. `ModerationModels` moves to `/mongoose`; `OutboxService` stays exported as a type.
- **`createModerationIntegration` is called with no explicit type arguments.** All three infer from the config object — `TReport` and `TTx` from `store`, `TAction` from `enforcement`. TypeScript has no partial explicit type arguments, so the existing two-argument call sites (`harness.ts:290`, `reviewOnlyApplication.test.ts:105`) drop theirs rather than growing a third.

- [ ] **Step 1: Cut the config**

Delete `modelPrefix` outright — its whole purpose was a Mongoose model-registry collision, and `mongooseModerationStore` still accepts it for that reason. It has no place in the integration config once the store is built outside.

- [ ] **Step 2: Update the harness and the one test that wires its own integration**

`createHarness` builds `mongooseModerationStore({ connection, reportModel: reports, enforcementActions: TEST_ACTIONS })` and passes it as `store`. The three `moderation.models.*.init()` calls become one `await store.ensureSchema()`. Same in `wireReviewOnlyApp`.

- [ ] **Step 3: Update the README's four-things example** to show the store being built and passed. The example at `src/index.ts:16-33` and the README's own must not diverge.

- [ ] **Step 4: Green, and mutation-proven** — 62 tests, 11/11 mutations.

- [ ] **Step 5: Commit** — `feat(app)!: createModerationIntegration takes one store`

---

### Task 5: The harness becomes backend-neutral

**This task exists because the spec is wrong about it.** `describe.each([mongoHarness, postgresHarness])` is impossible while test bodies call `harness.moderation.models.outbox.countDocuments({})`, `harness.reports.findById(id).lean()`, `harness.widgets.create({…})`, `new mongoose.Types.ObjectId()` and `connection.startSession()`. All five storage test files do. This task adds the façade and rewrites the assertions, still Mongo-only and still green — so the diff a reviewer reads is *only* the façade, with no second backend confusing it.

**Files:**
- Create: `packages/app/src/__tests__/support/backend.ts` (the `ModerationBackend` interface and the `Harness` façade types)
- Modify: `packages/app/src/__tests__/support/harness.ts`
- Modify: all five storage test files: `outboxTransactionCoupling.test.ts`, `reviewOnlyApplication.test.ts`, `webhookRawBody.test.ts`, `enforcementReversal.test.ts`, `fullLoop.test.ts`
- Modify: `packages/app/scripts/test-invariants.mjs` if any mutation's `expects` string names a renamed test

**Interfaces:**
- Produces `Harness`, extended with a storage façade. Every member is backend-neutral; Task 11 adds a second implementation of exactly this shape.

```ts
export interface HarnessOutboxRow {
  id: string; kind: ModerationOutboxKind; status: ModerationOutboxStatus;
  attempts: number; availableAt: Date; leaseOwner: string | null;
  leaseUntil: Date | null; lastError: string | null;
  expiresAt: Date; createdAt: Date; updatedAt: Date;
}
export interface HarnessEnforcementRow {
  decisionId: string; decisionRevision: number; action: string;
  recordedAs: string | null; applied: boolean; appliedAt: Date | null;
  skippedReason: string | null; previousState: EnforcementPreviousState | null;
  mode: ModerationEnforcementMode; createdAt: Date;
}
/** Enqueue an outbox event on whatever transaction handle is currently open. */
export type HarnessEnqueue = (input: {
  eventId: string;
  kind: ModerationOutboxKind;
  payload: ModerationOutboxPayload;
}) => Promise<void>;

export interface Harness {
  moderation: ModerationIntegration<TestReport, TestAction>;
  logs: { level: string; message: string; context?: Record<string, unknown> }[];

  /** The fictional application's own state. */
  app: {
    createWidget(input: { body: string; ownerId: string }): Promise<string>;
    readWidget(id: string): Promise<{ status: string; flagged: boolean } | null>;
    readReport(id: string): Promise<TestReport | null>;
    countReports(): Promise<number>;
    /** A well-formed id for a row that does not exist. ObjectId hex on Mongo. */
    absentId(): string;
  };

  outbox: {
    count(filter?: { kind?: ModerationOutboxKind; status?: ModerationOutboxStatus }): Promise<number>;
    read(eventId: string): Promise<HarnessOutboxRow | null>;
    /** Overwrite the lease owner out of band, to simulate another task. */
    stealLease(eventId: string, leaseOwner: string): Promise<void>;
  };
  events: { count(filter?: { state?: 'claimed' | 'queued' | 'ignored' }): Promise<number> };
  enforcement: { rows(): Promise<HarnessEnforcementRow[]> };  // createdAt ascending

  /**
   * Run a callback inside a REAL transaction on this backend, handing it an
   * enqueue already bound to that transaction's handle.
   *
   * The handle itself never crosses this boundary. A mongoose `ClientSession`
   * and a drizzle `PgTransaction` are different types, and one `Harness` type
   * cannot name both without a type parameter — which `describe.each` over two
   * backends cannot tolerate. Binding the enqueue is what removes the need.
   */
  transaction: { run(operation: (enqueue: HarnessEnqueue) => Promise<void>): Promise<void> };

  /**
   * An enqueue bound to a handle that is NOT in a transaction — a bare mongoose
   * session, or the Postgres pool handle. The negative case for the enqueue
   * guard, and the only reason this is on the harness at all.
   */
  detachedEnqueue(): Promise<{ enqueue: HarnessEnqueue; dispose(): Promise<void> }>;

  close(): Promise<void>;
}
/** Unchanged from today's `createHarness` parameter (`harness.ts:241-248`). */
export interface HarnessOptions {
  enabled?: boolean;
  serviceKey?: string;
  baseUrl?: string;
  webhookSecret?: string;
  enforcementMode?: 'observe' | 'manual' | 'automatic';
  subjects?: readonly ModerationSubjectProvider[];
}
export interface ModerationBackend {
  readonly name: 'mongoose' | 'postgres';
  createHarness(options?: HarnessOptions): Promise<Harness>;
}
```

- [ ] **Step 1: Add the façade to `createHarness`, implemented over the existing models**

`connection`, `widgets` and `reports` stop being exported on `Harness`. Anything a test still needs goes through the façade or is added to it — do not leave an escape hatch, because an escape hatch is what the Postgres harness cannot implement.

- [ ] **Step 2: Rewrite the assertions in all five files**

Mechanical. The three shapes:
- `harness.moderation.models.X.countDocuments(f)` → `harness.outbox.count(f)` / `harness.events.count(f)` / `(await harness.enforcement.rows()).length`
- `harness.reports.findById(id).lean()` → `harness.app.readReport(id)`
- `new mongoose.Types.ObjectId()` → `harness.app.absentId()`

- [ ] **Step 3: Rewrite `outboxTransactionCoupling.test.ts`'s transaction handling**

The nine tests in this file drive `connection.startSession()` directly. Two shapes:
- The positive cases (`session.withTransaction(cb)` then `enqueue(input, session)`) become `harness.transaction.run(async (enqueue) => { await enqueue(input); })`.
- The negative case (a bare `startSession()` with no transaction open) becomes `harness.detachedEnqueue()`. Its assertion is unchanged: the enqueue rejects with `ModerationOutboxTransactionError`.

The two tests that assert a transaction ROLLS BACK (`:168`, `:336` — "leaves neither the report nor the outbox row") throw from inside the callback, which `harness.transaction.run` must propagate rather than swallow.

**What the negative case must catch:** it is the target of proven mutation 1. After this rewrite, re-run `bun run --cwd packages/app test:invariants` and confirm mutation 1 is still caught **and still names `throws ModerationOutboxTransactionError for a session with no transaction open`**. If the test's title changed, update the mutation's `expects` string in the same commit — the script asserts the output NAMES the test, so a stale `expects` reports "something else broke and the guard is still unproven" rather than passing silently.

- [ ] **Step 4: Prove the façade is complete**

```bash
grep -rn "mongoose\|\.lean(\|countDocuments\|findById\|\.models\." packages/app/src/__tests__/*.test.ts
```

Expected: no output. **Paste it.** `enforcementPlanner.test.ts` and `configTypeErgonomics.test.ts` never had any; the other five must now have none either. A single remaining match is a member the Postgres harness will be unable to provide, discovered in Task 11 instead of here.

- [ ] **Step 5: Green, and mutation-proven** — 62 tests, 11/11.

- [ ] **Step 6: Commit** — `test(app): a backend-neutral harness façade, ahead of the second backend`

---

### Task 6: The Postgres tables, report columns, expiry targets and id-column ledger

The schema half. No store yet — this task's deliverable is DDL that a real `drizzle-kit generate` produces from these definitions and a real Postgres accepts, plus the two registry fragments an adopter merges into its own gates.

**Files:**
- Create: `packages/app/src/postgres/tables.ts`, `reportColumns.ts`, `registries.ts`
- Create: `packages/app/src/__tests__/support/postgres/schema.ts` (the fictional application's drizzle schema: `widgets` + the report table + `moderationTables()`)
- Create: `packages/app/drizzle.config.ts` (points at the TEST schema only)
- Create: `packages/app/src/__tests__/support/postgres/migrations/` (drizzle-kit output — **test-only, never published**)
- Create: `packages/app/src/__tests__/postgresSchema.test.ts`
- Modify: `packages/app/package.json` (devDeps `drizzle-orm`, `postgres`, `drizzle-kit`, `@oxyhq/db`; scripts `db:generate`)
- Create: `docker-compose.postgres.yml` at the repository root
- Modify: `packages/app/vitest.globalSetup.ts`

**Interfaces:**
- Consumes: `timestamptz`, `createdAt`, `updatedAt`, `generatedId`, `inList`, `textArrayLiteral`, `DATABASE_CASING`, `sqlColumnName` from `@oxyhq/db`; `ExpirySweepTarget` from `@oxyhq/db/expiry`; `createTestDatabase`, `dropTestDatabase` from `@oxyhq/db/testing`.
- Produces:
  - `moderationTables(options: { enforcementActions: readonly string[] }): ModerationTables` and `export type ModerationTables = ReturnType<typeof moderationTables>` with members `outbox`, `events`, `enforcements`.
  - `moderationReportColumns(options?: { reportedTypes?: readonly string[]; categories?: readonly string[]; detailsMaxLength?: number })` returning the column map to spread into the adopter's `pgTable`, plus a second return channel for the table-level CHECKs and indexes: `moderationReportTableExtras(columns)` returning the array a `pgTable`'s third argument takes.
  - `moderationExpirySweepTargets(tables: ModerationTables): readonly ExpirySweepTarget[]`
  - `moderationIdColumnsWithoutForeignKey(input: { tables: ModerationTables; reportTable: ModerationReportTable }): readonly { column: string; reason: string }[]`
  - `export type ModerationReportTable` — the structural type naming every column the report store queries. Used by Task 10.

**The three tables.** Names match the Mongo collection constants: `moderation_outbox`, `moderation_events`, `moderation_enforcements`.

| table | columns |
|---|---|
| `moderation_outbox` | `id text primary key` · `kind text not null` + CHECK `('report.submit','decision.apply')` · `payload jsonb not null` · `status text not null default 'pending'` + CHECK `('pending','processing','processed','dead_letter')` · `attempts integer not null default 0` · `available_at timestamptz not null` · `lease_owner text` · `lease_until timestamptz` · `last_error varchar(2000)` · `processed_at timestamptz` · `expires_at timestamptz not null` · `created_at` · `updated_at` |
| `moderation_events` | `id text primary key` · `type text` · `case_id text` · `payload jsonb` · `state text not null default 'claimed'` + CHECK `('claimed','queued','ignored')` · `received_at timestamptz not null` · `queued_at timestamptz` · `expires_at timestamptz not null` · `created_at` · `updated_at` |
| `moderation_enforcements` | `decision_id text not null` · `decision_revision integer not null` + CHECK `>= 1` · `action text not null` + CHECK over the declared actions · **composite PK `(decision_id, decision_revision, action)`** · `case_id text not null` · `subject_type text not null` · `subject_id text not null` · `outcome text not null` · `recommended_action text` · `recorded_as text` + CHECK `is null or in (…)` · `reason varchar(500) not null` · `mode text not null` + CHECK `('observe','manual','automatic')` · `applied boolean not null default false` · `applied_at timestamptz` · `skipped_reason varchar(300)` · `previous_state jsonb` · `created_at` · `updated_at` |

Indexes, each a direct port of a Mongo one:

- outbox `(status, available_at, created_at)` ← `models/index.ts:98`; `(status, lease_until, created_at)` ← `:99`; `(expires_at)` ← `:100` (the TTL index becomes an index plus a sweep target)
- events `(case_id)` ← `:161`; `(state, received_at)` ← `:178`; `(expires_at)` ← `:176`
- enforcements `(case_id)` ← `:258`; `(subject_type, subject_id, created_at DESC)` ← `:284`; `(subject_type, subject_id, action, applied, created_at DESC)` ← `:286`

The unique index at `:282` has no counterpart because it **is** the composite primary key. The unique constraint and the PK become the same object, there is no surrogate id to keep in step, and `@oxyhq/db`'s `missing_primary_key` invariant is satisfied by the thing that already had to exist.

**The report columns.** `id` uses `generatedId()` from `@oxyhq/db` — `text` primary key with a uuid v7 `$defaultFn`, **not** `uuid`. Explicit SQL names throughout, notably `crowdsource_report_id` and `crowdsource_case_id` (drizzle's derivation from `crowdSourceReportId` would give `crowd_source_report_id`, which is not what the spec's registries name). `categories` is `text('categories').array().notNull()` — this package writes it whole at intake and reads it whole at delivery, never by element — with a `<@ array[…]::text[]` CHECK when `options.categories` is supplied. `details varchar(n)` with `detailsMaxLength ?? 2000`. Indexes: `(local_status, created_at)`, `(crowdsource_case_id)`, `(reporter, reported_id, reported_type)` — the same three `applyModerationReportIndexes` creates, and for the same reasons its doc comment gives.

**The id-column ledger is eight entries, not the spec's six.** `findIdColumnViolations` exempts a column only when `column.primary` is set, and a composite PK declared in a table's extra config does not set it on its members:

| column | reason |
|---|---|
| `moderation_enforcements.decision_id` | Names a decision in CrowdSource's database, not the adopter's. |
| `moderation_enforcements.case_id` | Names a case in CrowdSource's database. |
| `moderation_enforcements.subject_id` | The adopter's own opaque noun id; the package cannot know which table it points at. |
| `moderation_events.case_id` | Names a case in CrowdSource's database. |
| `<report>.reported_id` | The adopter's own opaque noun id — same reason as `subject_id`. |
| `<report>.crowdsource_report_id` | A report id in CrowdSource's database. |
| `<report>.crowdsource_case_id` | A case id in CrowdSource's database. |
| `<report>.decision_id` | A decision id in CrowdSource's database. |

None of them can carry a foreign key, and every one of them would fail an adopter's inherited `findIdColumnViolations` gate as `unclassified_id_column` on the day it adopts. Shipping the fragment is what stops the first adopter writing these reasons by guessing.

- [ ] **Step 1: Install the drivers as devDependencies**

```bash
cd /home/nate/Oxy/CrowdSource
bun add --cwd packages/app --dev drizzle-orm@0.45.2 postgres@3.4.9 drizzle-kit@0.31.10 @oxyhq/db@^0.1.2
bun install
cat node_modules/@oxyhq/db/package.json | grep '"version"'
```

Expected: `0.1.2`. Commit `bun.lock` in the same commit.

- [ ] **Step 2: Write `docker-compose.postgres.yml`**

`postgres:17` — **not** a PostGIS image. Nothing in the moderation tables needs PostGIS, and pinning a heavier image would imply otherwise. Model it on `Mention/docker-compose.postgres.yml`: loopback-only port binding, a `pg_isready` healthcheck, a named volume, and a header comment saying CI pins the same image so a developer's database and CI's cannot disagree. Bind a port neither `oxy-api` (5432) nor Mention (5433) already uses.

- [ ] **Step 3: Write the failing schema test**

`src/__tests__/postgresSchema.test.ts` creates a throwaway database with `createTestDatabase({ adminUrl, migrate })` and asserts, against the real catalogue:

- `findSchemaInvariantViolations(db, { minimumTables, minimumColumns })` returns `[]`. The floors are the counts this task lands — 5 tables (3 package + report + widgets) and the real column count. **These floors rise in no later task**, so state them as exact counts, not lower bounds pulled from the air.
- `findIdColumnViolations({ tables, deferred: [], withoutForeignKey: moderationIdColumnsWithoutForeignKey({…}), minimumTables: 5 })` returns `[]`.
- `findUnsupportedExpiryColumns(db, moderationExpirySweepTargets(tables))` returns `[]` — this one must run against a REAL database, since a fake cannot validate a `pg_index` query.

**What each must catch, stated so nothing here is decoration:**
- Drop the `(expires_at)` index from `moderation_outbox` → `findUnsupportedExpiryColumns` must report `expiry_column_without_index` naming `moderation_outbox.expires_at`.
- Remove one entry from `moderationIdColumnsWithoutForeignKey` → `findIdColumnViolations` must report `unclassified_id_column` naming that exact column.
- Remove the composite `primaryKey()` from `moderation_enforcements` → `findSchemaInvariantViolations` must report `missing_primary_key`.

Run each of those three mutations by hand, paste the violation each produced, then revert. A gate that has never been seen to fail is not a gate.

- [ ] **Step 4: Write the tables, the report columns and the registries**

Read `packages/app/src/mongoose/models.ts` field by field. Every doc comment on a Mongo field — the retention argument at `:60-65`, the dedupe/audit argument at `:110-131`, the idempotency-key argument at `:186-206` — belongs on the corresponding Postgres column, because those comments are the design and are not Mongo-specific.

- [ ] **Step 5: Generate and apply the DDL**

```bash
cd packages/app && bun run db:generate
```

Inspect the emitted SQL before applying it. If drizzle-kit wants to emit anything you did not intend, stop: that means a table declaration says something other than what the Mongo model says.

- [ ] **Step 6: Prove the migrations folder is test-only**

```bash
cd packages/app && bun pm pack
tar -tzf oxyhq-crowdsource-app-*.tgz | grep -i migration
```

Expected: no output — `"files"` is `["dist/**/*", "src/**/*", "!src/**/__tests__/**"]` and the folder lives under `src/__tests__/`. **Paste it.** Add this as a permanent assertion in Task 13; §8 names shipping a migrations folder as the recommendation most likely to be reversed by someone trying to help, and it fails silently with exit 0.

- [ ] **Step 7: Commit** — `feat(app): the three Postgres tables, the report columns and the two registry fragments`

---

### Task 7: The Postgres outbox store

Written first among the four stores, deliberately: it is the answer to the spec's uncertainty 1 (whether the builder-API handle type survives ~600 lines rather than a 40-line probe), and it carries G1, G2, G5 and G6. If the handle type fails, it fails here, cheaply, and the fallback — `SqlExecutor` plus `sql` templates — is already proven in-tree by `@oxyhq/db`'s own expiry sweep.

**Files:**
- Create: `packages/app/src/postgres/store/transaction.ts`, `store/outbox.ts`
- Create: `packages/app/src/__tests__/support/postgres/database.ts` (throwaway-database helper wrapping `createTestDatabase`/`dropTestDatabase`)
- Create: `packages/app/src/__tests__/postgresOutboxStore.test.ts`

**Interfaces:**
- Consumes: `ModerationOutboxStore<TTx>`, `ModerationTransactionRunner<TTx>`, `ModerationOutboxTransactionError`, `ModerationOutboxEvent` from the core; `ModerationTables` from Task 6.
- Produces: `type ModerationPgHandle = PgDatabase<PgQueryResultHKT, Record<string, unknown>, TablesRelationalConfig>`; `postgresTransactionRunner(db: ModerationPgHandle): ModerationTransactionRunner<ModerationPgHandle>`; `postgresOutboxStore(input: { db: ModerationPgHandle; tables: ModerationTables }): ModerationOutboxStore<ModerationPgHandle>`.

**The four guarantees this store carries:**

- **G1.** The runner is `db.transaction(cb, { isolationLevel: 'read committed' })`. The new failure mode is that a store call inside the callback receives `db` instead of `tx` — which silently runs on a *different* pooled connection and commits independently, the identical silent failure the Mongo side guards with `session.inTransaction()`. `enqueue` therefore begins with `if (!(tx instanceof PgTransaction)) throw new ModerationOutboxTransactionError(eventId)`.
- **G2.** `enqueue` is `insert(outbox).values({…}).onConflictDoNothing({ target: outbox.id })`. It writes nothing and takes no row lock on an already-committed conflicting row, so a repeated enqueue is a no-op by construction rather than by suppressing an ORM's timestamp behaviour. One behavioural difference to state in the code: if a *concurrent uncommitted* transaction holds the same key, Postgres **waits** and then proceeds, where Mongo raises `WriteConflict` (code 112) and aborts. Waiting is the better outcome.
- **G5.** Every lease transition carries `leaseOwner` and `leaseUntil > now` in the WHERE, plus `.returning({ id })`, and answers `rows.length === 1`. Write down, at the store, that this deliberately collapses a semantic difference: Mongo's `complete` and `fail` read `modifiedCount` while `renew` reads `matchedCount`, and `RETURNING` counts **matched** rows for all three. It is equivalent here because both transitions always change `status` — but that is an argument, not a test, and it belongs next to the code it justifies.
- **G6.** `claim` is `update(outbox).set({…}).where(inArray(outbox.id, db.select({ id: outbox.id }).from(outbox).where(dueOrExpired).orderBy(asc(outbox.createdAt)).limit(1).for('update', { skipLocked: true }))).returning(…)`. `skipLocked: true` is a `LockConfig` field verified present in drizzle 0.45.2.

- [ ] **Step 1: Write the throwaway-database helper**

One database per test file, created with `createTestDatabase({ adminUrl: process.env.CROWDSOURCE_APP_TEST_POSTGRES_URL, migrate })` where `migrate` applies the committed test DDL from Task 6. Dropped with `dropTestDatabase` in `afterAll`. The Postgres harness cannot reuse `createHarness`'s per-suite counter trick (a fresh `dbName` on one connection) — Postgres needs a real database.

Set `statement_timeout` on the pool the store uses (2 seconds is enough). This is not tuning: the SKIP LOCKED mutation in Task 12 has a *block* as its natural failure mode, and a mutation whose failure mode is a timeout carries no information. The bound is what makes it fail fast and named, exactly as the Mongo lock-contention guard needed `maxTimeMS`.

- [ ] **Step 2: Write the failing store test, then the store**

The tests here address the store directly, not through an integration — the harness does not exist until Task 11. Each assertion below names the mutation it must catch; write none that cannot name one.

| assertion | the change it must catch |
|---|---|
| A second `enqueue` of an existing event id leaves every column byte-identical, including `updated_at` | `onConflictDoNothing` → `onConflictDoUpdate` |
| `enqueue` with the pool handle rather than a `tx` throws `ModerationOutboxTransactionError` | deleting the `instanceof PgTransaction` guard |
| A transaction whose body enqueues and then throws leaves zero outbox rows | passing `db` instead of `tx` inside the callback |
| Two due events, claimed twice, come back oldest-first | dropping `orderBy(asc(createdAt))` |
| With one due row locked `FOR UPDATE` by a second connection, `claim` returns `null` **within the statement timeout** | dropping `skipLocked: true` — without it this rejects with `57014` instead |
| `complete`/`renew`/`fail` with the wrong `leaseOwner` return `false` and change nothing | dropping `leaseOwner` from any of the three WHERE clauses |
| `renew` against a lease whose `leaseUntil` is already past returns `false` | dropping `gt(leaseUntil, now)` |
| A `processing` row whose lease expired is reclaimable by a new owner | dropping the second arm of the due-or-expired predicate |

The SKIP LOCKED test's shape, because getting it wrong produces a test that cannot fail: open a second postgres.js connection, `BEGIN` and `SELECT id FROM moderation_outbox WHERE id = $1 FOR UPDATE` to hold the only due row, then call `claim` on the store's own connection and assert it resolves `null`. Roll back the holder in a `finally`. Assert the elapsed time is under the statement timeout, so "returned null promptly" and "was cancelled after two seconds" cannot both read as a pass.

- [ ] **Step 3: Type-check before anything else is built**

```bash
bun run --cwd packages/app lint
```

This is the settlement of uncertainty 1. If `PgDatabase<PgQueryResultHKT, Record<string, unknown>, TablesRelationalConfig>` does not carry a query shape this store needs, **stop and report it** — do not reach for `as`. The fallback is `SqlExecutor` + `sql` templates + `executeRows<TRow>` with `type` aliases, and it is a cost question rather than a feasibility one.

- [ ] **Step 4: Run the store tests against a real Postgres and commit**

```bash
docker compose -f docker-compose.postgres.yml up -d postgres
bun run --cwd packages/app test:unit src/__tests__/postgresOutboxStore.test.ts
git add packages/app && git commit -m "feat(app): the Postgres outbox store — SKIP LOCKED claim, ON CONFLICT DO NOTHING enqueue"
```

---

### Task 8: The Postgres event store

G3. Small, and the one place where the Postgres implementation is *structurally* better than the Mongo one rather than merely equivalent.

**Files:**
- Create: `packages/app/src/postgres/store/events.ts`
- Create: `packages/app/src/__tests__/postgresEventStore.test.ts`

**Interfaces:**
- Consumes: `ModerationEventStore<TTx>` from the core, `ModerationTables` from Task 6, `ModerationPgHandle` from Task 7.
- Produces: `postgresEventStore(input: { db: ModerationPgHandle; tables: ModerationTables }): ModerationEventStore<ModerationPgHandle>`.

**G3 in full.** Mongo claims by inserting and reading `code === 11000`, rethrowing everything else so a lost connection answers non-2xx and the sender retries (`inbound.ts:81-86`). Postgres claims with `insert(...).onConflictDoNothing({ target: events.id }).returning({ id: events.id })`, and zero rows means somebody else holds it. **This is better than porting the catch**: it never throws at all, so there is no predicate to widen and no way to accidentally swallow a connection failure as "already processed". The property at `:81-86` is preserved by *not catching*, which is unbreakable rather than merely correct.

Record that in the code, and record its consequence: there is nothing to delete here, so this guarantee produces a mutation with nothing to remove on the *insert* side. The mutation that does exist attacks the *read* — see Task 12.

- [ ] **Step 1: Write the failing test, then the store**

| assertion | the change it must catch |
|---|---|
| Two concurrent `claim`s of one event id: exactly one returns `true` | `rows.length === 1` → `true`, or dropping `.returning()` |
| `release` then `claim` again returns `true` | `release` deleting nothing |
| `markQueued` inside a rolled-back transaction leaves the row at `claimed` | using `db` instead of `tx` |
| `markIgnored` with no `caseId` leaves `case_id` NULL rather than writing `'undefined'` | spreading an undefined into the update object |

- [ ] **Step 2: Green against a real Postgres, then commit** — `feat(app): the Postgres event store — a lost insert is the answer, not an error`

---

### Task 9: The Postgres enforcement store

G4 and G8. Two of the eleven proven mutations attack the reversal lookup, so its predicate is the most load-bearing SQL in this task.

**Files:**
- Create: `packages/app/src/postgres/store/enforcement.ts`
- Create: `packages/app/src/__tests__/postgresEnforcementStore.test.ts`

**Interfaces:**
- Consumes: `ModerationEnforcementStore`, `ModerationEnforcementKey`, `ModerationEnforcementInsert`, `EnforcementPreviousState` from the core; `ModerationTables`; `ModerationPgHandle`.
- Produces: `postgresEnforcementStore(input: { db: ModerationPgHandle; tables: ModerationTables }): ModerationEnforcementStore`.

**G4.** `claim` is `insert(enforcements).values({…}).onConflictDoNothing().returning({ decisionId })`, and zero rows is `false` — the caller turns that into `result: 'duplicate'`. Because the idempotency key IS the primary key, `onConflictDoNothing()` needs no explicit `target`.

**G8.** `latestApplied` is `select(...).from(enforcements).where(and(eq(subjectType, …), eq(subjectId, …), inArray(action, [...candidates]), eq(applied, true))).orderBy(desc(createdAt)).limit(1)`. Both `eq(applied, true)` and `inArray` are the direct ports of the two predicates proven mutations 6 and 8 remove; the supporting index `(subject_type, subject_id, action, applied, created_at DESC)` landed in Task 6.

- [ ] **Step 1: Write the failing test, then the store**

| assertion | the change it must catch |
|---|---|
| A second `claim` with the same `(decisionId, revision, action)` returns `false` and does not overwrite the first row's `reason` | `onConflictDoNothing` → `onConflictDoUpdate` |
| A third `claim` with the same id and action but revision + 1 returns `true` | dropping `decision_revision` from the primary key |
| With a newer `applied: false` row and an older `applied: true` row on one subject/action, `latestApplied` returns the older one | dropping `eq(applied, true)` |
| With two declared candidate actions each having an applied row, `latestApplied` returns whichever is newer — not whichever is first in the array | `inArray(action, candidates)` → `eq(action, candidates[0])` |
| `releaseClaim` lets the same key be claimed again | `releaseClaim` addressing the wrong columns |
| `markApplied` with a `previousState` round-trips it unchanged through `jsonb` | writing it as `text` |

Note on the third assertion: give the two rows `created_at` values that differ by more than a millisecond. `@oxyhq/db`'s `createdAt` default is `date_trunc('milliseconds', now())`, so two rows inserted in one tight loop can share a timestamp and the ordering becomes arbitrary — which would make the test pass or fail on timing rather than on the predicate. Set `created_at` explicitly in the fixtures.

- [ ] **Step 2: Green against a real Postgres, then commit** — `feat(app): the Postgres enforcement store — the idempotency key is the primary key`

---

### Task 10: The Postgres report store, and the report-table type gate

The store whose table the ADOPTER owns, so it is the only one that takes a table it did not define. That is what makes the structural type worth gating: an adopter who forgets a column gets a compile error at the `postgresModerationStore(...)` call — strictly better than the Mongoose side, where `Model<TReport>` checks the TypeScript type and not the schema paths.

**Files:**
- Create: `packages/app/src/postgres/store/reports.ts`
- Create: `packages/app/src/__tests__/postgresReportStore.test.ts`
- Create: `packages/app/scripts/test-report-table-type.mjs`
- Modify: `packages/app/package.json` (a `test:table-type` script; chain it into `test`)

**Interfaces:**
- Consumes: `ModerationReportStore<TReport, TTx>`, `ModerationReportInsert`, `ModerationReportDecisionUpdate`, `ModerationReportRef`, `ModerationReportFields`; `ModerationReportTable` from Task 6; `ModerationPgHandle`.
- Produces: `postgresReportStore<TReport extends ModerationReportFields>(input: { db: ModerationPgHandle; reportTable: ModerationReportTable }): ModerationReportStore<TReport, ModerationPgHandle>`.

**G7.** `applyDecision`'s WHERE is `and(eq(reportTable.id, reportId), or(isNull(reportTable.decisionRevision), lte(reportTable.decisionRevision, maxRevision)))`, with `.returning({ id })` and `rows.length === 1`. It is the DATABASE that refuses a stale write, not a read-then-write in this process.

**G13 does not apply.** `id` is `text`, so a malformed report id matches no rows and `findById` answers `null` — the same behaviour `delivery.ts:88-97` already relies on. Do not add an error branch for `22P02`; there is nothing to catch.

**G12's justification changes.** `requireIdentifier` stays (Task 2 already rewrote its comment), but note at the store that a bound parameter cannot become a query operator here, so the Mongo failure class it was written for does not exist on this backend.

- [ ] **Step 1: Write the failing test, then the store**

| assertion | the change it must catch |
|---|---|
| `applyDecision` at revision 2, then at revision 1, leaves revision 2's values in place and answers `false` the second time | dropping the `lte(decisionRevision, maxRevision)` arm |
| `applyDecision` on a report with a NULL `decision_revision` succeeds | dropping the `isNull(decisionRevision)` arm |
| `applyDecision` twice at the SAME revision succeeds both times | `lte` → `lt` |
| `findById('not-an-id-at-all')` resolves `null` and does not reject | any change that makes a malformed id throw |
| `findPendingOldestFirst(2)` on four reports across `queued`, `delivery_failed`, `received` and `submitted` returns exactly the two oldest of the first two statuses | adding `received` to the status set, or dropping the `ORDER BY created_at` |
| `countLocalOnly` counts `received` only, and `countAwaitingDecision(t)` counts `submitted` rows with `submitted_at < t` only | swapping either predicate |
| `insert` with an `extra` field the table does not declare raises rather than silently dropping it | — this is Postgres's own behaviour, and the assertion is what proves it differs from Mongoose strict mode, which drops it with no throw and no warning |

The last row is worth its own note: Syra maintains `src/models/zodPathsExistInMongoose.test.ts` precisely because a Mongoose `$set` on an undeclared path is silently discarded. On Postgres the write fails loudly. Assert that once, here, so the difference is recorded rather than assumed.

- [ ] **Step 2: Write the report-table type gate**

`scripts/test-report-table-type.mjs`, modelled on the existing `scripts/test-check-*.mjs` pattern. It writes two fixture modules into a temp directory inside the package, runs `tsc --noEmit` against a minimal tsconfig for each, and asserts:

1. a table composed from `moderationReportColumns()` compiles clean (exit 0);
2. a table with `decisionRevision` removed **fails**, and the compiler output names that fixture file.

`@ts-expect-error` is forbidden by the repo rules, which is why this is a script rather than a type test. Both halves are required: (1) alone passes when the type is `any`-shaped and checks nothing, and (2) alone passes when the fixture is broken for an unrelated reason — which is why the check reads the compiler's output rather than only its exit code.

Clean the temp directory in a `finally`, and verify by counting entries before and after two consecutive runs with no manual clearing.

- [ ] **Step 3: Green, then commit** — `feat(app): the Postgres report store, and a gate on the adopter's table shape`

---

### Task 11: The `/postgres` subpath, the Postgres harness, and `describe.each`

Everything converges. 62 tests become 99: 25 storage-free tests run once, 37 run twice.

**Files:**
- Create: `packages/app/src/postgres/store/index.ts`, `packages/app/src/postgres/index.ts` (the subpath entry)
- Create: `packages/app/src/__tests__/support/postgresHarness.ts`
- Modify: `packages/app/package.json` (`exports` gains `./postgres`), `scripts/check-module-format.mjs` (`app: 3`)
- Modify: `packages/app/src/__tests__/support/backend.ts`, `support/harness.ts`
- Modify: all five storage test files (wrap in `describe.each(BACKENDS)`)
- Modify: `packages/app/vitest.globalSetup.ts`

**Interfaces:**
- Produces: `postgresModerationStore(input: { db: ModerationPgHandle; reportTable: ModerationReportTable; tables: ModerationTables }): ModerationStore<TReport, ModerationPgHandle>` — composes the four stores from Tasks 7–10 plus the runner, with `ensureSchema()` asserting the three tables and the report table exist (it does not create them; the adopter's migration did).
- `@oxyhq/crowdsource-app/postgres` exports `postgresModerationStore`, `moderationTables`, `moderationReportColumns`, `moderationReportTableExtras`, `moderationExpirySweepTargets`, `moderationIdColumnsWithoutForeignKey`, and the types `ModerationTables`, `ModerationReportTable`, `ModerationPgHandle`.
- Produces: `BACKENDS: readonly ModerationBackend[]` in `support/backend.ts`.

- [ ] **Step 1: Compose the store and declare the subpath**

Mirror Task 3's exports block for `./postgres`, and raise `check-module-format.mjs`'s per-package minimum for `app` to 3. Re-run the two manual load checks from Task 3 Step 4 against `@oxyhq/crowdsource-app/postgres` — a subpath declared is not a subpath loadable, and the two forms of "loadable" are not the same question.

- [ ] **Step 2: Write the Postgres harness**

Same fictional application, second implementation. `widgets` becomes a drizzle table in the test schema from Task 6; the widget subject provider and `testEnforcement`'s `apply` lose their `mongoose.isValidObjectId` guards (a `text` id needs none) and read/write through the handle. `absentId()` returns a uuid v7 from `@oxyhq/db`'s `uuidv7()`. `transaction.run` wraps `db.transaction(cb, { isolationLevel: 'read committed' })` and binds the enqueue to `tx`; `detachedEnqueue()` binds it to the POOL handle instead, with a no-op `dispose`.

Every member of the `Harness` façade from Task 5 must be implementable. If one is not, the façade is wrong — fix the façade, do not add a backend conditional to a test body.

- [ ] **Step 3: Wire `BACKENDS` and gate its selection**

`CROWDSOURCE_APP_TEST_BACKEND` narrows `BACKENDS` to one entry; unset means both. **An unrecognised value must throw**, not yield an empty list: an empty `describe.each` runs zero tests, vitest exits 0, and Task 12's mutation script would read that as a caught mutation. This is the same false-green shape the invariant script's own header warns about.

`vitest.globalSetup.ts` starts the Mongo replica set as it does today and additionally requires `CROWDSOURCE_APP_TEST_POSTGRES_URL`. If it is unset, **throw** with a message naming `docker-compose.postgres.yml` — a silent skip is exactly the vacuity the CI floor exists to prevent.

- [ ] **Step 4: Wrap the five storage files in `describe.each(BACKENDS)`**

The describe title carries the backend name so vitest's verbose reporter prints `mongoose > <test>` and `postgres > <test>` — Task 12's mutation script matches on the leaf test name, so the leaf names must not change.

`reviewOnlyApplication.test.ts` needs the most work: it builds its own connection, schema and integration inline (`:83-152`) rather than using `createHarness`. Extract that into a `ModerationBackend`-shaped factory alongside the main harness, sharing the throwaway-database and replica-set plumbing.

- [ ] **Step 5: Classify the 37 — this is the settlement of the spec's uncertainty 2**

The 25/37 split was made by reading imports. Some of the 37 may assert package LOGIC that merely needs a database rather than a storage GUARANTEE. Walk each of the 37 and record which §2 guarantee it exercises, or `logic`. Report the counts. If a meaningful number are `logic`, say so and propose which could run once — but **do not act on it in this task**; a test that runs twice is never wrong, and shrinking the matrix is a separate decision with its own reviewer.

- [ ] **Step 6: Green on both backends**

```bash
bun run --cwd packages/app test:unit
```

Expected: 99 tests. **Paste the count.** Then run each backend alone (`CROWDSOURCE_APP_TEST_BACKEND=postgres`, then `=mongoose`) and paste both counts — 62 and 62. If either is 25, the `describe.each` did not take.

- [ ] **Step 7: Commit** — `feat(app): the /postgres subpath and a backend-parameterised suite`

---

### Task 12: `test-invariants.mjs` grows a backend axis

Eleven mutations become eighteen. The vacuity floor becomes per-backend, because `checked !== MUTATIONS.length` is satisfied by a run where the Postgres harness silently fell back to Mongo.

**Files:**
- Modify: `packages/app/scripts/test-invariants.mjs`
- Modify: `.github/workflows/ci.yml` if the script's runtime needs a longer job timeout

**Interfaces:**
- Each mutation gains `backend: 'shared' | 'mongoose' | 'postgres'`. A non-`shared` mutation runs its vitest invocation with `CROWDSOURCE_APP_TEST_BACKEND` set to that backend.
- The floor becomes `EXPECTED_BY_BACKEND = { shared: 6, mongoose: 5, postgres: 7 }` and every bucket is asserted separately.

**The eighteen:**

| # | backend | mutation | caught by |
|---|---|---|---|
| 1 | mongoose | `session.inTransaction()` removed | `throws ModerationOutboxTransactionError for a handle with no transaction open` |
| 2 | shared | webhook router mounted behind `express.json()` | `reaches the moderation router with req.body still undefined` |
| 3 | mongoose | `{ upsert: true, session, timestamps: false }` → `{ upsert: true, session }` | `stores both when the reported type has a subject provider` |
| 4 | mongoose | explicit timestamps dropped AND Mongoose's own restored | `leaves an existing row completely untouched on a repeated enqueue` |
| 5 | shared | `enforcedAt` stamped for a recorded-only action | `records the decision, and never claims an effect it did not have` |
| 6 | mongoose | reversal drops `applied: true` | `reads the applied row, not the newer recorded-only one` |
| 7 | shared | report records the planned action, not the effective one | `uses the effective action for a subject no lever can act on` |
| 8 | mongoose | reversal `$in: [...candidates]` → `candidates[0]` | `reads the most recent applied row across the whole declared set` |
| 9 | shared | a correction plans only the first declared restore | `lifts a label as well as a restriction` |
| 10 | shared | restore dedup suppresses the whole set | `still adds the other reversal when one is already recommended` |
| 11 | shared | inverted `restoreAction` accepted at construction | `throws when restoreAction names the actions being undone` |
| 12 | postgres | `tx instanceof PgTransaction` guard removed | mutation 1's twin, same test name, `=postgres` |
| 13 | postgres | `onConflictDoNothing` → `onConflictDoUpdate` on the outbox enqueue | mutation 4's twin |
| 14 | postgres | `eq(applied, true)` removed from `latestApplied` | mutation 6's twin |
| 15 | postgres | `inArray(action, candidates)` → `eq(action, candidates[0])` | mutation 8's twin |
| 16 | postgres | `skipLocked: true` removed from the claim's `.for('update', …)` | a second claimer must observe zero claims **within the statement timeout** |
| 17 | postgres | `tx` → `db` inside the transaction callback | the atomicity test goes red |
| 18 | postgres | the event store's `rows.length === 1` → `true` | the webhook-dedupe test goes red |

**Mutation 3 has no Postgres twin, and that is information rather than a gap.** Its failure is a Mongoose-specific update-operator conflict (`ConflictingUpdateOperators`, code 40) between `$set` and `$setOnInsert` on one path; nothing in the Postgres path can produce it. Record the reason in the script's header rather than inventing a mutation that proves nothing. The spec's uncertainty 4 anticipated exactly this shape for G2 and G3 — in the event, both DO have twins (13 and 18); mutation 3 is the one that does not.

- [ ] **Step 1: Add the `backend` field and route the vitest invocation**

The existing `run(['node', '../../node_modules/vitest/vitest.mjs', 'run', mutation.test, '--reporter=verbose'])` gains the environment variable for a non-`shared` mutation. Keep `env: process.env` spread rather than replaced, or the Mongo URI and the Postgres URL both vanish.

- [ ] **Step 2: Make the floor per-backend**

```js
if (checkedByBackend[name] !== EXPECTED_BY_BACKEND[name]) { … }
```
plus the existing total. **What this must catch:** set `CROWDSOURCE_APP_TEST_BACKEND` to a value that yields no Postgres tests and confirm the run fails naming `postgres`, rather than passing on the total. Under the current scalar floor a Postgres bucket of zero would pass if six shared mutations happened to run twice.

- [ ] **Step 3: Write the seven new mutations, each with an exact `find`/`replace`/`absent`**

The script punishes an inexact marker by design. For each, confirm the three checks in order: the edit landed and the `absent` marker is really gone; the mutated tree still type-checks (`bun run lint`); the named test fails. Mutation 16 additionally must fail **fast** — if it takes longer than the statement timeout the bound is not in place and the mutation carries no information.

- [ ] **Step 4: One timed run on an isolated worktree — the settlement of uncertainty 3**

The script mutates `src/` in place and this tree is shared with other agents. Run it from a dedicated worktree and report the wall time before and after the split, so the CI budget is committed against a measurement rather than an estimate.

```bash
bun run --cwd packages/app test:invariants
```

Expected final line: `The guards hold: 18 mutations applied, type-checked, and caught.` **Paste it.**

- [ ] **Step 5: Commit** — `test(app): eighteen mutations across two backends, with a per-backend vacuity floor`

---

### Task 13: CI, documentation and the publish gates

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `packages/app/README.md`
- Modify: `AGENTS.md` (the stale README reference)
- Modify: `scripts/check-dist-orphans.mjs` — only if Tasks 3 and 11 revealed it needs to know about subpath output; verify rather than assume
- Create: a packed-tarball assertion, wired into `bun run check`

- [ ] **Step 1: Add the Postgres service to the `tests` job**

`postgres:17`, pinned identically to `docker-compose.postgres.yml`, with `CROWDSOURCE_APP_TEST_POSTGRES_URL` in the job `env`. A `services:` block is job-level and the `tests` job is a matrix, so a container starts for all nine entries including the two frontends. Mention hit the same constraint and documented it (`Mention/.github/workflows/ci.yml:164-167`): a `services:` block cannot be conditional on a matrix value, and an empty `image` is a hard error. The cost is one container start on entries that never connect. Copy that comment's reasoning, not its wording.

- [ ] **Step 2: Raise the app test floor from 48 to 85**

62 → 99, so 85 sits a few below current. The floor is sized to catch a **collapse**, not a single deleted test: one deletion is a deliberate act a reviewer sees; a traversal breaking to near-zero is the invisible failure. Say so in the comment beside it, matching the convention the other seven matrix entries already follow.

Note that the `app` matrix entry runs `test:unit` **and** `test:invariants` in one command, so the invariant script now needs Postgres in the same job — which the service block provides.

- [ ] **Step 3: Assert the packed tarball ships no migrations**

Wire Task 6 Step 6's check in permanently: pack the package and fail if any entry matches `migration`. §8 names this as the recommendation most likely to be reversed by someone trying to be helpful, and it fails silently with exit 0 — a helpful person moving the folder out of `__tests__/` breaks nothing until an adopter's second journal skips a migration.

**What it must catch:** move the migrations folder to `packages/app/src/postgres/migrations/` and confirm the check fails. Revert.

- [ ] **Step 4: Rewrite the README's requirements and integration sections**

- The **Requirements** section currently says "MongoDB must be a replica set or a sharded cluster". That is now the Mongo backend's requirement only. On Postgres the replica-set precondition disappears entirely — one `BEGIN…COMMIT` on one pooled connection — and a boot-time topology assertion becomes unnecessary. Say both.
- The four-things table gains its Postgres column: the report model becomes `moderationReportColumns()` spread into a drizzle `pgTable`, and the three package tables become **explicit** — `moderationTables()` returns drizzle tables the adopter re-exports from its schema, and the adopter's drizzle-kit run produces the DDL. That last row is the only genuinely new obligation and it is unavoidable: Mongo creates a collection on first write; Postgres needs DDL, and DDL needs a migration.
- **The outbox is a TTL'd table that holds unprocessed work**, so `@oxyhq/db/expiry`'s own warning applies with force: document what a stalled dispatcher plus a sweep does to the backlog. The 90-day retention is long enough that this is a documented consequence rather than a hazard, and `dead_letter` rows — the ones a human still has to look at — are inside the same window. A registry entry with no such note reads as "unconditionally safe to sweep".
- Document the adopter's obligation to merge `moderationExpirySweepTargets()` into its own `EXPIRY_SWEEP_TARGETS` and `moderationIdColumnsWithoutForeignKey()` into its own `ID_COLUMNS_WITHOUT_FOREIGN_KEY`. Neither is optional; the first is silent (a table that grows forever) and the second fails the adopter's own gate on day one.
- The "Before publishing" checklist gains the two new subpaths for both manual load checks.

- [ ] **Step 5: Fix the stale AGENTS.md reference**

`AGENTS.md` cites `packages/app/README.md` § "Writing a check that can actually fail". **That section does not exist** — the README's only headings are *Dynamic require*, *Before publishing*, *Requirements*, *Testing your integration*, *What you do not write*, *License*. The content it describes lives in `scripts/test-invariants.mjs`'s own header comment (`:1-24`). Repoint the citation. This is the class of stale claim `~/Oxy/AGENTS.md` §(D) warns about: docs are the one place a wrong statement persists indefinitely, because no consumer ever trips over it.

While there, update the same bullet's mutation count from eleven to eighteen and note that the suite now runs against a real Postgres as well as a real replica set.

- [ ] **Step 6: Full green**

```bash
cd /home/nate/Oxy/CrowdSource
bun run check
bun run --cwd packages/app test
```

- [ ] **Step 7: Commit** — `ci(app): Postgres in CI, a raised test floor, and the docs for two backends`

---

## Self-Review

**Spec coverage, section by section.**

- §0's facts: the ten mongoose importers → Tasks 1–2; the six storage-free files → untouched, confirmed by Task 2 Step 5; the three collections → Task 6; the 62/48 counts → Tasks 11 and 13; the eleven mutations → Task 12.
- §0's doc correction → Task 13 Step 5.
- §0's four type probes: probe 2 (the handle type) → Task 7 Step 3; probe 3 (query shapes) → Tasks 7–10; probe 4 (the structural table type) → Task 10 Step 2; probe 5 (`PgTransaction`) → Task 7, and re-verified in this document.
- §1.1's 25 operations → the store port, all 26 methods.
- §1.2's subpath layout and optional peers → Tasks 3 and 11. The three rejected alternatives are not re-litigated.
- §1.3's "the package must not ship a migrations folder" → Global Constraints + Task 6 Step 6 + Task 13 Step 3.
- §2's fourteen guarantees: G1 → Task 7; G2 → Task 7; G3 → Task 8; G4, G8 → Task 9; G5, G6 → Task 7; G7, G11, G12 → Task 10 (G11's slices in Global Constraints); G9 → Task 6 + Task 13 Step 4; G10 → Task 6; G13 → **decided not to apply**, with its reason, in Corrections; G14 → Global Constraints.
- §3's `@oxyhq/db` consumption list → Task 6 (columns, casing, expiry, testing, assert) and Task 7 (`SqlExecutor` as the named fallback). The four deliberate non-consumptions — `migrate/*`, `createDatabase`, `ids`/`generatedId` for the outbox and event PKs, `assert/*` as a package dependency — are honoured: the two id columns are deterministic strings, the enforcement PK is the natural triple, and only the report id uses `generatedId()`.
- §4's `pg-mem` rejection → not proposed anywhere. Real Postgres, per-file throwaway databases, Tasks 6–11.
- §4.1's `describe.each` → Task 11, with the correction that test bodies do change.
- §4.2's mutation split and per-backend floor → Task 12.
- §4.3's CI cost → Task 13 Step 1.
- §5's clean cut and the module-format obligation → Tasks 3, 4, 11, 13.
- §6 (Syra's migration path) → **out of scope by construction.** This plan ends at a published `@oxyhq/crowdsource-app` with two backends; Syra's adoption is its own Task 8, unblocked by this work.
- §7's sizing → below.
- §8's four "do not"s → all four are Global Constraints or explicit non-tasks. The `pg` driver is not supported; schema-level table prefixing is not built; no data migration is written.
- §9's six uncertainties: 1 → Task 7 Step 3; 2 → Task 11 Step 5; 3 → Task 12 Step 4; 4 → Task 12's table, which resolves it (both doubted twins exist; a different one does not); 5 → Task 6 Step 3, run against the package's own tables rather than deferred to Syra; 6 → **resolved in Corrections**, `packages/testing` is storage-free.

**One requirement I could not map to a task.** §9's uncertainty 5 says the `withoutForeignKey` obligation should be settled by *"generating the three tables into Syra's schema and running its inherited `@oxyhq/db/assert` suite once"*. Task 6 runs those gates against the package's own test schema instead, which is strictly available here and proves the fragment is complete for these tables. It does **not** prove the fragment composes with a real adopter's registry — a duplicate entry, or a table-name collision with an adopter's own `reports`, would only surface there. That check belongs to Syra's Task 8 and is named as such in this plan's report rather than silently absorbed.

**Placeholder scan.** No "TBD", no "similar to Task N", no "add appropriate error handling", no "write tests for the above". Tasks 8 and 9 are short because their stores are short, not because their content was deferred; each carries its own assertion table naming the change it must catch. Every test is either prose naming a mutation or, where the form is genuinely determined (the SKIP LOCKED holder transaction, the two-fixture type gate), spelled out.

**Every assertion names a breaking change.** The five assertion tables (Tasks 7–10) are two-column by construction, and the third column of Task 12's table is the test that must go red. Task 6's three gate mutations are to be run by hand with their output pasted. Where a guarantee cannot be broken by deleting a line — the event store's insert side, G3 — that is recorded as information rather than papered over with an invented mutation.

**Interface consistency.** `ModerationStore` and its five members are declared once in "The store port" and referenced by exact name in Tasks 1, 2, 4, 7, 8, 9, 10 and 11. `ModerationPgHandle` is produced in Task 7 and consumed in 8, 9, 10, 11. `ModerationTables` and `ModerationReportTable` are produced in Task 6 and consumed in 7–11. `ModerationEnforcementKey` carries the same three fields at every use. The `Harness` façade is declared in Task 5 and implemented a second time in Task 11 with no additions.

**Order dependencies.** 1 → 2 (the port must exist). 2 → 3 (the subpath needs a store to export). 3 → 4 (the config cut imports from the subpath). 4 → 5 (the harness builds a store). 6 → 7 → {8, 9, 10} (the tables and the handle type). {5, 7, 8, 9, 10} → 11. 11 → 12 (the mutations need both harnesses). 12 → 13. Tasks 8, 9 and 10 are independent of one another and can run in parallel.

**Sizing.** Thirteen tasks, **eight to nine working days for one person**, with the tail in verification. That is the spec's 6–8 plus roughly a day for Task 5, which the spec did not budget because it believed no test body would change. Tasks 1, 2, 5, 7, 11 and 12 are the expensive ones at roughly three-quarters of a day each; 3, 4, 13 at half; 8 at less. Syra's own adoption afterwards remains 1–2 days and is not counted here.

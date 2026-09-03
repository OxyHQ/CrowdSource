# `@oxyhq/crowdsource-app` gains a PostgreSQL backend

> **Archived, superseded design.** The dual-store design below records the
> 2026-08-06 decision process; it is not the current runtime. CrowdSource and
> `@oxyhq/crowdsource-app` now serve only from PostgreSQL. In current operations,
> MongoDB is retained solely inside the pinned, network-isolated archive recovery
> reader; no live-source connector remains.

**Status:** design, 2026-08-06. Not a plan — a shape to argue with, and a size.

**Why this exists.** Syra is porting MongoDB to PostgreSQL, and its moderation
vertical is the adopter half of CrowdSource. Three routes were possible; **Nate
chose route 2 on 2026-08-06** (`Syra/docs/superpowers/specs/2026-08-05-syra-mongo-to-postgres-design.md:238`).
The reason is not a Syra favour: `@oxyhq/crowdsource-app` is multi-tenant
moderation infrastructure, so a Mongo-only adopter half pins **every** backend
that adopts it. Six of the seven candidate backends are Mongo-only today; Mention
runs both. A Postgres backend unblocks the second half of that list without
costing the first half anything.

**Scope.** The ADOPTER half only. CrowdSource's own server
(`packages/backend`) stays on MongoDB — that is a recorded owner decision
(`AGENTS.md:82`) and nothing here touches it.

---

## 0. Facts this design rests on

Every claim below was read out of the tree on 2026-08-06, not inferred.

| Fact | Evidence |
|---|---|
| The package is bound to Mongoose by peer dependency | `packages/app/package.json:71` — `"mongoose": "^8.0.0 \|\| ^9.0.0"` |
| Exactly **ten** source files import mongoose | `decision.ts:1`, `delivery.ts:1`, `inbound.ts:1`, `intake.ts:1`, `models/index.ts:1`, `models/report.ts:1`, `outbox/service.ts:2`, `reconciliation.ts:1`, `types.ts:23`, `enforcement/executor.ts:1` |
| Six source files are already **storage-free** | `webhook.ts`, `client.ts`, `evidence.ts`, `enforcement/planner.ts`, `outbox/dispatcher.ts`, `reportStatus.ts` — zero matches for `model`/`Model`/`mongoose`/`connection` |
| The package owns three collections | `models/index.ts:67`, `:154`, `:247` |
| **Nobody consumes it yet.** No committed manifest in `~/Oxy` depends on `@oxyhq/crowdsource-app` | Seven repos pin `@oxyhq/crowdsource` + `-contracts` + `-express` at `0.3.0`; the only `crowdsource-app` references are the package itself and `.worktrees/mention-crowdsource/packages/backend/package.json:26`, which points at a local `0.3.0` tarball on an unmerged branch |
| Syra hand-rolls the adopter half in **18** files | `packages/backend/src/moderation/` — 15 at the top level plus `subjects/{types,registry,providers}.ts`; four `*.test.ts` files excluded. (The brief's "15" counts the top level only.) |
| `@oxyhq/db` is published at 0.1.2 with a Postgres substrate | `node_modules/@oxyhq/db/package.json` — subpaths `.`, `/migrate`, `/expiry`, `/testing`, `/assert` |
| Mention already runs a real Postgres in CI and per-file throwaway databases | `Mention/.github/workflows/ci.yml:169-186`, `Mention/packages/backend/vitest.globalSetup.ts:43` |
| The app suite is 62 tests behind a floor of 48 | `grep -c 'it('` across `src/__tests__/*.test.ts`; `.github/workflows/ci.yml:122` |
| 11 mutations, each proven to be caught | `scripts/test-invariants.mjs:35-248`, vacuity floor at `:384` |

**One doc correction, unprompted:** `AGENTS.md:51` cites
`packages/app/README.md` § "Writing a check that can actually fail". That
section does not exist — the README's only headings are *Dynamic require*,
*Before publishing*, *Requirements*, *Testing your integration*, *What you do not
write*, *License*. The content it describes lives in `scripts/test-invariants.mjs`'s
own header comment (`:1-24`). This is precisely the class of stale claim
`~/Oxy/AGENTS.md` §(D) warns about — docs are the one place a wrong statement
persists because no consumer ever trips over it.

### Four verified type probes

The three highest-risk typing questions were answered by compiling against the
real `drizzle-orm@0.45.2` in `~/Oxy/.worktrees/syra-postgres/node_modules`, not
by reasoning. All four probes exited 0 under `tsc --strict`:

1. `PgDatabase<PgQueryResultHKT, Record<string, never>, Record<string, never>>`
   accepts **neither** a real handle nor a transaction (`TS2345`, schema generic
   is invariant). The obvious narrow type does not work.
2. `PgDatabase<PgQueryResultHKT, Record<string, unknown>, TablesRelationalConfig>`
   accepts **both** a `PostgresJsDatabase` and the `tx` inside
   `db.transaction(cb)`, and the full builder API (`insert/update/select/delete`)
   is reachable through it. This is the handle type the design uses.
3. Every load-bearing query shape compiles through that handle:
   `onConflictDoNothing({ target: [...] }).returning()`, an
   `UPDATE … WHERE id IN (SELECT … ORDER BY … LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING`,
   an owner-checked `UPDATE … RETURNING`, `inArray` + `desc` + `limit(1)`, and
   the revision guard `or(isNull(col), lte(col, n))`.
4. A structural `ModerationReportTable` type accepts an adopter table composed
   from an exported column factory and **rejects** one missing those columns —
   the `@ts-expect-error` on the negative case was satisfied, so the check is not
   vacuous.
5. `PgTransaction` is a real runtime export of `drizzle-orm/pg-core`
   (`typeof === 'function'`), so `tx instanceof PgTransaction` is available as the
   direct analogue of `session.inTransaction()`.

---

## 1. The abstraction boundary

### 1.1 The operations, enumerated from source

Twenty-six call sites, collapsing into twenty store methods across four stores
plus a transaction runner. This is the whole storage surface of the package.

**Outbox** — `outbox/service.ts`

| # | Operation | Source | Property that must survive |
|---|---|---|---|
| 1 | `enqueue` insert-if-absent, **inside the caller's transaction** | `:404-422` | A true no-op for an existing row |
| 2 | `claim` one due event, oldest first | `:281-297` | Atomic; reclaims expired leases; N dispatchers share |
| 3 | `complete` | `:305-312` | Owner-checked; one row or nothing |
| 4 | `renew` | `:223-232` | Owner-checked; live lease only |
| 5 | `fail` (release with backoff, or dead-letter) | `:325-336` | Owner-checked |
| 6 | `statusOf` | `:432-435` | Read by reconciliation |

**Inbound events** — `inbound.ts`

| # | Operation | Source | Property |
|---|---|---|---|
| 7 | `claim(eventId)` — the dedupe | `:69-87` | Insert-if-absent; duplicate ≠ any other failure |
| 8 | `release(eventId)` | `:91` | Gives the claim back |
| 9 | `recordDecisionEvent` — complete the row **and** enqueue, one transaction | `:150-179` | Both or neither |
| 10 | `recordIgnoredEvent` | `:183-195` | No transaction, no outbox row |

**Enforcement** — `enforcement/executor.ts`

| # | Operation | Source | Property |
|---|---|---|---|
| 11 | Claim the idempotency row | `:177-201` | Losing the insert is the ANSWER, not an error |
| 12 | Mark skipped (+ `recordedAs`) | `:204-214`, `:246-256` | |
| 13 | Mark applied (+ `previousState`) | `:265-276` | |
| 14 | Release the claim on failure | `:285` | Or a transient failure becomes permanent |
| 15 | Reversal lookup | `:139-148` | Newest **APPLIED** row across a declared set |

**The application's own report table**

| # | Operation | Source | Property |
|---|---|---|---|
| 16 | Duplicate check, in the transaction | `intake.ts:149-152` | |
| 17 | Insert, in the transaction | `intake.ts:155-169` | |
| 18 | Reports for a case | `decision.ts:141-144` | |
| 19 | **Revision-guarded** update | `decision.ts:75-111` | The guard is in the WHERE clause, not read-then-write |
| 20 | Read one report | `delivery.ts:88` | |
| 21–23 | Delivery failure / success / close-undeliverable writes | `delivery.ts:144-155`, `:160-173`, `:74-77` | |
| 24 | Reconciliation scan, oldest-first, bounded | `reconciliation.ts:93-98` | |
| 25 | Two counts | `reconciliation.ts:132-138` | |

**Transaction control** — `intake.ts:89-106`, `inbound.ts:135-146`,
`reconciliation.ts:118-129`. Three sites, one shape.

### 1.2 The narrowest interface: a store the PACKAGE implements twice

The package already rejected a store port once, deliberately, and the reason is
worth restating because it decides the shape here
(`models/report.ts:15-19`): *"The alternative — a store port with ten methods for
the application to implement — was rejected. Every one of those methods carries a
correctness property that is invisible when it is wrong… Seven applications
re-deriving those is seven chances to get one subtly wrong."*

That rejection is about **who implements it**, not about whether the seam exists.
The design here keeps the rejection intact:

> **The port is internal. The package ships both implementations. An adopter
> never writes one.**

So the boundary is not "what does the application implement" but "what varies
between two dialects", and the answer is narrow: the twenty operations above,
plus a transaction runner, plus an opaque transaction handle.

```
@oxyhq/crowdsource-app             the storage-free core + createModerationIntegration({ store })
@oxyhq/crowdsource-app/mongoose    mongooseModerationStore({ connection, reportModel, … })
@oxyhq/crowdsource-app/postgres    postgresModerationStore({ db, reportTable, tables })
                                   + moderationTables({ enforcementActions, prefix })
                                   + moderationReportColumns()
```

`createModerationIntegration` loses `connection`, `reportModel` and `modelPrefix`
from its config (`types.ts:580`, `:584`, `:611`) and gains one `store`. Nothing
else in the public surface moves: the subject providers, the taxonomy, the
enforcement config, the logger and the metrics are already storage-free
(`types.ts:1-21` says so explicitly, and it is true).

**Why this rather than the alternatives.**

- *Two packages* (`-app` and `-app-pg`) would duplicate the planner, the decision
  worker, delivery, the webhook receiver and reconciliation — 1,000+ lines whose
  whole reason for being shared is that they carry invisible correctness
  properties (`enforcement/planner.ts:26-33`). Rejected.
- *Three packages* (core + two adapters) solves the peer-dependency question
  cleanly but costs a release dance on every change and an extra import path for
  every adopter. Subpath exports give the same peer isolation for free.
- *A config discriminator* (`{ backend: 'postgres' }`) makes the peer dependency
  un-analysable: both drivers become reachable from the entrypoint, so every
  Mongo adopter's bundler pulls drizzle. Rejected.

**Peer dependencies become optional.** `mongoose`, `drizzle-orm` and `postgres`
all move under `peerDependenciesMeta: { optional: true }`. A subpath is only
resolved when imported, so a Postgres adopter never installs mongoose and a Mongo
adopter never installs drizzle. `express` and `@oxyhq/crowdsource-contracts` stay
required peers.

### 1.3 What the adopter writes, per backend

The four things stay four. Only the third and fourth change shape.

| | Mongo adopter | Postgres adopter |
|---|---|---|
| Subject providers | unchanged | unchanged |
| Taxonomy | unchanged | unchanged |
| Enforcement tables + one `apply` | unchanged | unchanged |
| Its report model | `moderationReportSchemaFields()` spread into a Mongoose schema (`models/report.ts:61`) | `moderationReportColumns()` spread into a drizzle `pgTable` |
| The three package tables | implicit — `registerModerationModels` creates them (`models/index.ts:309`) | **explicit** — `moderationTables()` returns drizzle tables the adopter re-exports from its schema, and drizzle-kit generates the DDL |

That last row is the only genuinely new obligation, and it is unavoidable:
Mongo creates a collection on first write; Postgres needs DDL, and DDL needs a
migration.

**The package must not ship a migrations folder.** `@oxyhq/db`'s ledger applies a
migration only when its journal timestamp is strictly newer than the newest
recorded one (`migrate/ledger.ts:119-132`). Two journals against one
`drizzle.__drizzle_migrations` table interleave, and the loser is skipped **in
silence with exit 0** — the exact defect `UnreachableMigrationError`
(`ledger.ts:141`) exists to name. So the package ships table *definitions*; the
adopter's own drizzle-kit run produces the SQL, in the adopter's own journal.

**Verified typing** (probe 4): the report table is accepted as a structural type
naming the columns the package queries. An adopter who forgets one gets a compile
error at the `postgresModerationStore(...)` call — strictly better than the
Mongoose side, where `Model<TReport>` checks the TypeScript type and not the
schema paths. That is the same class of bug Syra's
`src/models/zodPathsExistInMongoose.test.ts` exists to catch, and here the
compiler catches it for free.

---

## 2. Guarantees Postgres must reproduce, not approximate

Fourteen. Each names how Mongo provides it today and how Postgres provides it.

**G1 — The report and its outbox row commit together.**
Mongo: `session.withTransaction` with `readConcern: snapshot`,
`writeConcern: majority` (`intake.ts:36-40`, `:96-98`), which requires a replica
set (`README.md:77-82`). Postgres: one `BEGIN…COMMIT` on one pooled connection,
via `db.transaction(cb)`. **Stronger** — the replica-set precondition disappears
entirely, and `topology.ts`-style boot assertions become unnecessary for Postgres
adopters.
The new failure mode: every store call inside the callback must receive `tx`, not
`db`. A `db` call inside a transaction callback silently runs on a *different*
pooled connection and commits independently — the identical silent failure the
Mongo side guards with `session.inTransaction()` (`outbox/service.ts:342-344`).
**The guard transfers**: `tx instanceof PgTransaction` (verified reachable,
probe 5), thrown as the same `ModerationOutboxTransactionError`.

**G2 — `enqueue` is a genuine no-op for a row that already exists.**
This is the subtlest guarantee in the package and it has already caused one
total-failure bug and one near-miss (`outbox/service.ts:347-403`). A repeated
enqueue is ordinary — a transaction retry, two concurrent duplicate submissions,
a reconciliation sweep — and the dispatcher is concurrently updating leases on the
same rows, so a *write* there conflicts with a live lease and aborts the enclosing
transaction.
Postgres: `INSERT … ON CONFLICT (id) DO NOTHING`. It writes nothing and takes no
row lock on an already-committed conflicting row, so the property holds by
construction rather than by suppressing an ORM's timestamp behaviour. `DO UPDATE`
would reintroduce exactly the bug, which makes it the natural mutation
(`test-invariants.mjs:89-101` has the Mongo twin).
One behavioural difference to state: if a *concurrent uncommitted* transaction
holds the same key, Postgres **waits** for it and then proceeds, where Mongo
raises `WriteConflict` (code 112) and aborts. Waiting is the better outcome; the
test at `outboxTransactionCoupling.test.ts:242` ("re-enqueues inside a transaction
without blocking a live lease write") is the one that proves it, and it must run
on both backends.

**G3 — Webhook dedupe: an insert that loses is the ANSWER, not an error.**
Mongo: unique `_id` and `code === 11000` (`inbound.ts:33-40`, `:69-87`).
Everything that is not 11000 is rethrown, so a lost connection answers non-2xx
and the sender retries (`:81-86`).
Postgres: `INSERT … ON CONFLICT (id) DO NOTHING RETURNING id`, and zero rows means
"somebody else holds it". **This is better than porting the catch**: it never
throws at all, so there is no way to widen the predicate and accidentally swallow
a connection failure as "already processed". The property at `:81-86` is then
preserved by *not catching*, which is unbreakable rather than merely correct.
If a `catch` shape is kept anywhere, it must use `isUniqueViolation(error, name)`
from `@oxyhq/db` — drizzle wraps the driver error, so `error.code` is on `cause`
and a naive check matches **nothing** (`@oxyhq/db/src/pgErrors.ts:1-21`).

**G4 — The enforcement idempotency claim.**
Mongo: unique index on `(decisionId, decisionRevision, action)`
(`models/index.ts:282`), claimed *before* the effect so a redelivery loses the
insert (`executor.ts:170-201`). Postgres: make that triple the **composite primary
key** — the unique constraint and the PK are then the same object, there is no
surrogate id to keep in step, and `@oxyhq/db`'s "every table has a primary key"
invariant is satisfied by the thing that already had to exist. Claim with
`ON CONFLICT DO NOTHING RETURNING`; zero rows is `result: 'duplicate'`.

**G5 — Every lease transition is owner-checked.**
Mongo filters on `leaseOwner` plus `leaseUntil > now` and reads the count
(`service.ts:224`, `:306`, `:326`). Postgres: the same predicate plus
`RETURNING id`, `rows.length === 1`.
A semantic difference worth naming rather than absorbing: `complete` and `fail`
read `modifiedCount` while `renew` reads `matchedCount` (`:232`, `:312`, `:337`).
`RETURNING` counts **matched** rows for all three. It is equivalent here because
both transitions always change `status`, but that is an argument, not a test, and
it should be written down where the store is implemented.

**G6 — Claim is atomic, ordered oldest-first, and N dispatchers share the work.**
Mongo: `findOneAndUpdate(filter, …, { sort: { createdAt: 1 } })`
(`service.ts:281-297`); a loser re-evaluates the predicate and moves on.
Postgres: `UPDATE … WHERE id IN (SELECT id … ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING …`.
**`SKIP LOCKED` is load-bearing, not tuning.** Without it, under READ COMMITTED
the subselect is evaluated once, the loser blocks on the head row and then
returns **zero rows** — `claim` answers `null`, `dispatch` breaks out of its batch
(`service.ts:456`), and a multi-task deployment silently drains at 1/N the rate
with nothing failing. That makes it a mutation the invariant script must carry.

**G7 — The decision revision guard lives in the WHERE clause.**
Mongo: `$or: [{ decisionRevision: { $exists: false } }, { decisionRevision: { $lte: revision } }]`
(`decision.ts:77-82`) — the *database* refuses a stale write.
Postgres: `or(isNull(decisionRevision), lte(decisionRevision, revision))`,
verified to compile (probe 3). `$exists: false` ≡ `IS NULL` provided the port
stores an absent value as NULL, which it does. `<=` not `<` is deliberate: a
redelivery of the same revision rewrites.

**G8 — A reversal reads the most recent APPLIED row.**
`executor.ts:139-148`, `applied: true` in the filter. Two of the eleven proven
mutations attack this (`test-invariants.mjs:133`, `:173`). Postgres: the same
predicate, plus the supporting index
`(subject_type, subject_id, action, applied, created_at DESC)` — the direct port
of `models/index.ts:286`.

**G9 — Retention. Mongo reaps; Postgres does not.**
Two TTL indexes disappear silently in a port: `models/index.ts:100` (outbox) and
`:176` (events), both `expireAfterSeconds: 0` on `expiresAt`. `@oxyhq/db/expiry`
is the replacement mechanism and its header says exactly why this is the quietest
failure in a Mongo port (`expiry.ts:11-26`).
**The registry belongs to the consumer, but these two tables belong to the
package** — so the package exports two `ExpirySweepTarget`s built over its own
tables and the adopter merges them into its own list. That is not a violation of
the registry rule; it is the rule applied correctly, because the package is the
owner of the tables it names.
`@oxyhq/db`'s own warning applies here with force (`expiry.ts:41-49`): a TTL'd
table holding unprocessed work needs an explicit note about what a stalled
consumer plus a sweep does to the backlog. The outbox is that table. The 90-day
retention (`models/index.ts:66`) is long enough that this is a documented
consequence rather than a hazard, and `dead_letter` rows — the ones a human still
has to look at — are inside the same window. It must be written down.

**G10 — The action enum.**
Mongo builds the enum from the adopter's action list at model-registration time
(`models/index.ts:256`, `:264`). Postgres: a `CHECK` constraint generated by
`moderationTables({ enforcementActions })` (verified to compile, probe 3).
**Consequence to state plainly:** adding an enforcement action becomes a
migration, where in Mongo it is a restart. That is a real ergonomic regression and
it is the correct trade — a stored action outside the declared set is exactly the
thing the enum exists to refuse. A `text` column with no constraint would be
cheaper and would give up the guarantee.

**G11 — Bounded strings.**
`maxlength` on `reason` (500), `skippedReason` (300), `lastError` (2000)
(`models/index.ts:265`, `:270`, `types.ts` report fields). Mongoose validators
*throw* on overflow; the code already slices before every write
(`executor.ts:189`, `:250`; `service.ts:331`). Postgres `varchar(n)` errors
(22001) rather than truncating — equivalent given the slices. Keep the slices;
they are what makes both dialects agree.

**G12 — Non-string identifiers.**
`requireIdentifier` (`intake.ts:67-72`) exists because Mongo would accept
`{ $ne: null }` as a *query operator* and match an unrelated report. **In Postgres
a bound parameter cannot become an operator, so that entire failure class
disappears.** The guard stays — a non-string still corrupts data and the function
is exported for callers with no route validation — but its justification changes,
and the doc comment must be rewritten rather than copied, or it will assert a
hazard the backend does not have.

**G13 — A malformed report id.**
`delivery.ts:88-97` treats a missing report as "nothing to deliver, complete the
event". In Mongo, a garbage id raises a Mongoose `CastError`; in Postgres a
`uuid`-typed column raises `22P02 invalid_text_representation` from the driver —
which the delivery worker does **not** catch, so the event is retried forever
instead of completing. This is a genuine new failure mode created by the port and
it needs an explicit branch. It is the kind of thing that only shows up months
later, on one row.

**G14 — Isolation level, and one hole that already exists.**
Mongo uses `readConcern: snapshot` on all three transactions. Postgres should use
**READ COMMITTED explicitly**, not `repeatable read`: the two multi-statement
transactions are (report insert + outbox upsert) and (event update + outbox
upsert), neither of which reads-then-decides in a way snapshot isolation
protects, and `repeatable read` would import `40001` serialization failures and a
retry loop for no benefit.
The one place a reviewer will object: intake reads a duplicate check and then
inserts (`intake.ts:149-153`), which READ COMMITTED does not serialize. **It is
not a regression** — Mongo's snapshot isolation does not prevent that phantom
either, and the package explicitly leaves the "one report per reporter per
object" unique index to the application (`models/report.ts:134-137`). Both
backends are equally advisory here. Stated so nobody re-discovers it as a
Postgres defect.

---

## 3. Where `@oxyhq/db` fits — and where it does not

`@oxyhq/db` should be a **peer dependency of the `/postgres` subpath**, on the
same reasoning it uses for drizzle itself: three repos sharing types only works
with one installed copy.

**Consumed, and load-bearing:**

- `pgErrors` — `isUniqueViolation`, `constraintNameOf`, `describeDriverError`.
  Non-negotiable: drizzle wraps the driver failure, so a hand-written
  `error.code` check matches nothing and every call site is a `catch` that
  rethrows (`pgErrors.ts:1-21`). `describeDriverError` also solves a real leak —
  postgres.js attaches the statement and its bound parameters, and Postgres's own
  `detail` reads `Failing row contains (…)`, so `logger.warn(msg, { error })`
  publishes reported material into a log. The package's invariant is that
  sensitive content never reaches logs.
- `expiry` — the TTL replacement for the outbox and event tables (G9).
- `testing` — `createTestDatabase` / `dropTestDatabase` for the suite (§4).
- `columns` — `timestamptz`, `createdAt`/`updatedAt` at `date_trunc('milliseconds', now())`
  (`columns.ts:74-94`). That precision choice is a correctness matter, not style:
  Postgres stores microseconds, a JS `Date` holds milliseconds, and a value that
  does not round-trip breaks a `createdAt`-ordered claim.
- `casing` — `DATABASE_CASING`. The package's SQL and the adopter's migration
  must render the same column names; a column interpolated into a `sql` template
  is rendered by drizzle's own renderer with the configured casing
  (`expiry.ts:113-120`).
- `database` — `SqlExecutor` exists for precisely this: something that runs SQL
  and works equally as a pool or a transaction handle (`database.ts:6-16`). It is
  the fallback if the builder-API handle type (probe 2) ever fails.

**Deliberately NOT consumed:**

- **`migrate/*`.** The package ships no migrations and must not. One journal per
  database, or entries are skipped in silence (§1.3, `ledger.ts:119-132`).
- **`createDatabase`.** The adopter owns its pool, its health checks and its
  shutdown ordering. `database.ts:96-116` says as much about its own consumer.
- **`ids.uuidv7` / `generatedId`.** The outbox and event primary keys are
  *deterministic strings* — `moderation:report.submit:<reportId>`
  (`service.ts:52`) and the webhook event id — and that determinism is what makes
  the idempotency work. A generated id would break it. The enforcement table's PK
  is the natural triple (G4). So the package needs no id generator at all.
- **`assert/*` — but the package's tables must PASS the adopter's gates.** This
  is the integration cost most likely to be missed. `findIdColumnViolations`
  requires every `*_id`-shaped column to be classified as a real FK, a deferred
  FK, or declared as permanently carrying none (`assert/idColumns.ts:1-32`). The
  package's tables contribute six such columns — `case_id`, `decision_id`,
  `subject_id`, and the report table's `crowdsource_report_id`,
  `crowdsource_case_id`, plus the outbox payload's `report_id` if it is ever
  promoted to a column. **None of them can carry a foreign key**: they name rows
  in CrowdSource's database, not the adopter's. So the package must export a
  ready-made `withoutForeignKey` fragment with its reasons, or the first adopter's
  convention gate fails on adoption and someone writes those reasons by guessing.
  That fragment is ~10 lines and saves every adopter the same afternoon.

---

## 4. Keeping both backends honest

The current suite runs against a **real** `mongodb-memory-server` replica set
(`vitest.globalSetup.ts:20-27`) for a stated reason: a mock agrees with any claim
about transactions and unique indexes. Every guarantee in §2 is exactly that kind
of claim, so the Postgres side needs the same standard.

**Rejected: `pg-mem`.** It is the direct analogue of the mocked driver this
package already refuses. It does not implement `FOR UPDATE SKIP LOCKED` (G6),
real MVCC concurrency (G2's concurrent-uncommitted case), or advisory locks. A
fake that answers queries cannot validate the queries — the third `@oxyhq/db`
lesson, applied.

**Adopted: a real Postgres, per-file throwaway databases.** This is proven in the
ecosystem, not invented here: Mention runs `postgis/postgis:17-3.5` as a CI
service and creates a fully-migrated throwaway database per test file
(`Mention/.github/workflows/ci.yml:169-186`,
`Mention/packages/backend/vitest.globalSetup.ts:43`). CrowdSource takes the same
shape with plain `postgres:17` — nothing in the moderation tables needs PostGIS.

### 4.1 The suite becomes backend-parameterised

Of 62 tests, **25 are already storage-free** — `enforcementPlanner.test.ts` (17)
and `configTypeErgonomics.test.ts` (8) — and run once. The other **37** across
five files run twice.

| file | tests | runs |
|---|---|---|
| `enforcementPlanner.test.ts` | 17 | once |
| `configTypeErgonomics.test.ts` | 8 | once |
| `outboxTransactionCoupling.test.ts` | 9 | ×2 |
| `reviewOnlyApplication.test.ts` | 13 | ×2 |
| `webhookRawBody.test.ts` | 6 | ×2 |
| `enforcementReversal.test.ts` | 5 | ×2 |
| `fullLoop.test.ts` | 4 | ×2 |

62 → **99**. The CI floor moves from 48 (`ci.yml:122`) to roughly 85.

The mechanism is one `describe.each([mongoHarness, postgresHarness])` over the
existing `createHarness` seam (`__tests__/support/harness.ts:240`). Four of the
five storage files already use it; `reviewOnlyApplication.test.ts` builds its own
connection (`:103`, `:147-152`) and needs the same treatment. **Not one test body
changes** — the harness returns the same `Harness` shape and the assertions are
about behaviour, not storage. That is the property that makes this affordable.

The Postgres harness cannot reuse `createHarness`'s per-suite counter trick
(`harness.ts:238`, a fresh `dbName` on one connection). It calls
`createTestDatabase({ adminUrl, migrate })` per harness, where `migrate` applies
the package's own test schema — the same drizzle tables an adopter would generate,
built once in a fixture.

### 4.2 `test-invariants.mjs` grows a backend axis

Eleven mutations today (`:35-248`). Sorting them by what they attack:

- **Storage-free, run once** (5): the two planner mutations (`:190`, `:213`), the
  inverted-`restoreAction` guard (`:236`), the effective-action mutation
  (`:155`), the webhook mount-order mutation (`:53`).
- **Storage-specific, need a Postgres twin** (6): `session.inTransaction()`
  (`:37`) → `tx instanceof PgTransaction`; the two `timestamps: false` mutations
  (`:72`, `:89`) → `ON CONFLICT DO NOTHING` → `DO UPDATE`; `applied: true`
  (`:133`) and `$in: [...candidates]` (`:173`) → their SQL predicates;
  `enforcedAt` (`:109`) is in `decision.ts`, storage-free logic reached through a
  store call, so it runs once but must be confirmed reachable on both harnesses.
- **New, Postgres-only** (2): remove `SKIP LOCKED` (G6) — a second dispatcher must
  observe zero claims; and `tx` → `db` inside a transaction callback (G1) — the
  atomicity test must go red.

11 → about **17**. Each mutation costs a full `bun run lint` plus one vitest file
run (`:341`, `:353`), so the script's wall time roughly grows by 6/11 plus the
per-run Postgres database creation, which is measured in tens of milliseconds
against a warm server rather than the seconds a replica-set boot costs.

**The vacuity floor at `:384` must become per-backend.** `checked !== MUTATIONS.length`
is satisfied by a run where the Postgres harness silently fell back to Mongo. It
needs to assert a count per backend, and the script needs a `backend` field to
route each mutation to the right harness env.

**One warning from `~/Oxy/AGENTS.md` applies directly here:** a mutation whose
failure mode is a timeout carries no information. The SKIP LOCKED mutation's
natural failure mode is a *block* — one dispatcher waiting on another's row lock.
It must be bounded with `statement_timeout` so it fails fast and named, exactly
as the Mongo lock-contention guard needed `maxTimeMS`.

### 4.3 Cost of running Postgres in CI

A `services:` block is job-level and the `tests` job is a matrix
(`ci.yml:72-128`), so a Postgres container starts for all nine matrix entries
including the two frontends. Mention hit the same constraint and documented it
(`Mention/.github/workflows/ci.yml:164-167`): a `services:` block cannot be
conditional on a matrix value. The cost is one container start on entries that
never connect — accepted there, and acceptable here.

Local developers gain a prerequisite: a running Postgres. A
`docker-compose.postgres.yml` mirroring Mention's, pinned to the same image CI
uses, is the pattern (`Mention/docker-compose.postgres.yml`).

---

## 5. Existing adopters

**There are none.** No committed manifest in `~/Oxy` depends on
`@oxyhq/crowdsource-app`; the seven candidate backends pin the *client* packages
at `0.3.0` and hand-roll the adopter half. The only reference is
`.worktrees/mention-crowdsource/packages/backend/package.json:26`, an unmerged
branch pointing at a local `0.3.0` tarball.

Two consequences, and they are the largest sizing lever in this document:

1. **The config change is free.** Replacing `connection`/`reportModel`/
   `modelPrefix` with a single `store` is a breaking change to an API nobody
   consumes. There is no deprecation path to build, no alias to maintain, no
   migration guide to write. It is a clean cut, which is what the ecosystem rules
   require anyway.
2. **Mongo must stay first-class regardless.** Six of seven candidate backends
   (Homiio, Mercaria, Moovo, Allo, Alia, Syra) declare only `mongoose`; Mention
   declares both. "No existing adopters" is not "no Mongo future".

**Backend selection is by which store factory the adopter imports**, from a
subpath. Not configuration — a string discriminator makes both drivers reachable
from the entrypoint. Not a separate package — that duplicates the shared half.
Not inference from an installed peer — invisible, and untestable.

One concrete risk that must be paid: the 0.4.0 release exists because versions up
to 0.3.0 declared an `import` condition pointing at CommonJS, which took a backend
down on 2026-07-30 (`README.md:28-49`). Every new subpath needs the same dual
build and the same two manual checks the README documents (`:51-75`) — plain-Node
ESM import of the *packed* artifact, and an esbuild ESM consumer. `check:module-format`
must learn about the new subpaths, or the guard silently covers only the root.

---

## 6. Syra's migration path

Syra's `packages/backend/src/moderation/` holds 18 non-test files. Adoption
deletes 13 of them, plus three models.

**Deleted — the package owns these**

| file | replaced by |
|---|---|
| `outbox.ts` (449 lines) | `outbox/service.ts` |
| `dispatcher.ts` | `outbox/dispatcher.ts` |
| `intake.ts` | `intake.ts` |
| `inbound-service.ts` | `inbound.ts` |
| `event-store.ts` | `createProcessedEventStore` |
| `delivery-worker.ts` | `delivery.ts` |
| `decision-worker.ts` | `decision.ts` |
| `enforcement-plan.ts` (275 lines) | `enforcement/planner.ts` |
| `enforcement-service.ts` (409 lines) | `enforcement/executor.ts` + the adopter's `apply` |
| `evidence-snapshot.ts` | `evidence.ts` |
| `report-status.ts` | `reportStatus.ts` |
| `topology.ts` | unnecessary on Postgres (G1) |
| `client.ts` | `client.ts` |
| `subjects/types.ts` | `ModerationSubjectProvider` from the package |
| models `ModerationOutbox.ts`, `ModerationEvent.ts`, `ModerationEnforcement.ts` | `moderationTables()` |

Roughly 2,000 lines of Syra source deleted, including two of the three files the
package's own AGENTS.md names as carrying invisible correctness properties.

**Kept — Syra's four things**

1. `subjects/providers.ts` (434 lines) + `subjects/registry.ts` — its nouns.
2. `report-taxonomy.ts` — its category→allegation mapping.
3. Its enforcement **tables** plus one `apply`, distilled out of
   `enforcement-plan.ts` and `enforcement-service.ts` into a
   `ModerationEnforcementConfig<TAction>` object. The *algorithm* in
   `enforcement-plan.ts` goes; the *tables* inside it stay.
4. Its `Report` model, recomposed from `moderationReportColumns()`.

`config.ts` survives in reduced form: the "enabled + service key + webhook secret
only mean anything together" validation (`config.ts:5-14`) has no counterpart in
the package and is worth keeping. Two routes change one line each —
`routes/reports.routes.ts:3` calls `moderation.createReport`,
`routes/crowdsourceWebhook.routes.ts` mounts `moderation.webhookRouter()`.

Syra also bumps `@oxyhq/crowdsource*` from `0.3.0` to `0.4.x`
(`packages/backend/package.json:24-26`).

**Ordering.** Syra's phase 6 is already scheduled last for exactly this reason
(`Syra/docs/superpowers/specs/2026-08-05-syra-mongo-to-postgres-design.md:256`).
Nothing here changes that. Phases 1–5 and 7–8 do not wait.

---

## 7. Size

**Six to eight working days for one person, with the tail in verification.**
The basis, not a feeling:

| piece | estimate | why |
|---|---|---|
| Extract the store port from 10 files; make the core storage-free | 1–1.5 d | The seam is already 20 operations across 4 stores; 6 of 18 source files need no change at all |
| Mongoose store (a re-shuffle of existing code) | 0.5 d | The queries exist; they move behind an interface |
| Postgres store + `moderationTables()` + `moderationReportColumns()` | 1.5–2 d | Every query shape is pre-verified to compile (probe 3); the CHECK-constraint and composite-PK decisions are made |
| Postgres test harness + `describe.each` parameterisation | 1–1.5 d | Mention's harness is the template; no test body changes |
| `test-invariants.mjs`: 6 twins + 2 new + per-backend vacuity floor | 1 d | Each mutation needs its own exact `find`/`replace`/`absent` marker, and the script punishes an inexact one |
| CI service, `docker-compose.postgres.yml`, module-format guard for new subpaths, README | 0.5 d | |
| Publishing and the two manual load checks | 0.5 d | `README.md:51-75` |

**What makes it *not* larger:** no adopter to migrate, no compatibility surface,
six files that never touch storage, and every risky type question already answered
by a compiling probe rather than left to discovery.

**What could make it larger:** the `describe.each` refactor of
`reviewOnlyApplication.test.ts`, which builds its own connection and models
inline; and the possibility that a mutation twin turns out to be uncatchable on
Postgres because the guarantee is provided structurally rather than by a line of
code — `ON CONFLICT DO NOTHING` (G2, G3) is exactly that shape. **A guarantee that
cannot be broken by deleting a line is a better guarantee, but it produces a
mutation with nothing to delete**, and the honest response is to record why rather
than to invent a mutation that proves nothing.

Syra's own adoption afterwards is **1–2 days**: mostly deletion, plus distilling
two files into one config object.

---

## 8. What to defer, and what not to do

**Do not port the `mongoose` peer to a required `drizzle` peer.** Both optional,
both behind subpaths. Anything else makes one adopter class pay for the other.

**Do not ship a migrations folder.** §1.3. This is the single recommendation most
likely to be reversed by someone trying to be helpful, and it fails silently
(exit 0, migration skipped).

**Defer a `pg` (node-postgres) driver.** `@oxyhq/db` peers on `postgres` (3.4.9)
and every Oxy backend uses it. Supporting a second driver is speculative
generality with a real cost — `isUniqueViolation` walks the `cause` chain for
postgres.js's field names specifically (`pgErrors.ts:88-95`).

**Defer schema-level table prefixing.** `modelPrefix` (`types.ts:611`) exists for
a Mongoose model-registry collision. On Postgres the adopter passes its own table
objects, so a name collision is a compile error in the adopter's own schema file.
A `prefix` option on `moderationTables()` is one line if someone ever needs it;
building it now is guessing.

**Do not attempt a Mongo→Postgres data migration inside the package.** Syra's
moderation tables are empty of anything worth moving (the integration is
`observe`-mode plumbing, and outbox/event rows are 90-day transients). A general
migrator for a package with zero adopters is work for a case that does not exist.
If some adopter later needs one, the outbox is re-derivable from reports by the
reconciliation sweep (`reconciliation.ts:9-39`) — which is the correct mechanism
and already exists.

**Question worth asking before starting:** whether `@oxyhq/crowdsource-app` should
consume `@oxyhq/db` at all, or copy the four helpers it needs. Consuming it means
a published moderation package takes a release dependency on a 0.1.x package with
three consumers, and a bad `@oxyhq/db` publish becomes a moderation outage.
**Recommendation: consume it**, as a peer — the alternative is a second copy of
`isUniqueViolation` and the expiry sweep, which is the exact divergence
`@oxyhq/db` was extracted to end. But the risk is real and belongs in the record.

---

## 9. Uncertainties, and what would settle each

1. **Whether the builder-API handle type survives real use.**
   `PgDatabase<PgQueryResultHKT, Record<string, unknown>, TablesRelationalConfig>`
   compiles for every query in probe 3, but the probes are ~40 lines and the real
   store is ~600. *Settled by:* writing the outbox store first and type-checking
   it before anything else is built. The fallback — `SqlExecutor` plus `sql`
   templates — is already proven in-tree by `@oxyhq/db`'s own expiry sweep, so
   this is a cost question, not a feasibility one.

2. **How much of the current 62-test suite actually needs to run twice.**
   The 25/37 split is by file, from reading imports. Some of the 37 may be
   asserting package logic that happens to need a database rather than asserting
   a storage guarantee. *Settled by:* classifying each of the 37 by which §2
   guarantee it exercises. If a third of them turn out to be logic tests, the
   parameterisation shrinks and so does CI time.

3. **The wall-clock cost of the invariant script after the split.**
   Not measured. `test-invariants.mjs` mutates `src/` in place, and this tree is
   shared with other running agents — running it would have made *their*
   measurements wrong (`~/Oxy/AGENTS.md` on mutation testing corrupting a shared
   tree). *Settled by:* one timed run on an isolated worktree, before the CI
   budget is committed to.

4. **Whether every mutation has a Postgres twin at all.**
   G2 and G3 are provided by `ON CONFLICT DO NOTHING`'s semantics rather than by a
   deletable guard. *Settled by:* attempting each twin during implementation and
   recording the ones that cannot exist, with the reason — a mutation that cannot
   be written is information, not a gap to paper over.

5. **What the adopter's convention gates actually say about the package's tables.**
   The `withoutForeignKey` obligation (§3) is derived from reading
   `assert/idColumns.ts`, not from running a gate over a real migrated schema.
   *Settled by:* generating the three tables into Syra's schema and running its
   inherited `@oxyhq/db/assert` suite once. Cheap, and it either confirms the
   ~10-line fragment or names a second one.

6. **Whether `@oxyhq/crowdsource-testing`'s sandbox is storage-coupled.**
   The full-loop test drives a real sandbox and a signed webhook over a real
   socket (`README.md:83-95`). It was not audited for storage assumptions. *Settled
   by:* reading `packages/testing/src` before the harness work starts. If it is
   storage-free — likely, since it simulates the CrowdSource *server* — this is a
   non-issue; if not, add half a day.

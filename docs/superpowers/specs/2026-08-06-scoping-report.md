# Scoping report — `@oxyhq/crowdsource-app` gains a PostgreSQL backend

**Date:** 2026-08-06. **Design:** `./2026-08-06-crowdsource-app-postgres-design.md`.
**Nothing was modified.** Two documents created; every repository read-only.

---

## 1. The abstraction boundary, and why

**Twenty operations across four stores plus a transaction runner** — enumerated
from source, not guessed:

- **Outbox (6):** `enqueue` (`outbox/service.ts:404-422`), `claim` (`:281-297`),
  `complete` (`:305-312`), `renew` (`:223-232`), `fail` (`:325-336`),
  `statusOf` (`:432-435`).
- **Events (4):** dedupe `claim` (`inbound.ts:69-87`), `release` (`:91`),
  `recordDecisionEvent` (`:150-179`), `recordIgnoredEvent` (`:183-195`).
- **Enforcement (5):** claim the idempotency row (`enforcement/executor.ts:177-201`),
  mark skipped (`:204-214`, `:246-256`), mark applied (`:265-276`), release the
  claim (`:285`), reversal lookup (`:139-148`).
- **The adopter's report table (10):** duplicate check + insert
  (`intake.ts:149-169`), reports-for-a-case (`decision.ts:141-144`), the
  revision-guarded update (`decision.ts:75-111`), read one (`delivery.ts:88`),
  three delivery writes (`delivery.ts:74-77`, `:144-155`, `:160-173`), the
  bounded oldest-first scan and two counts (`reconciliation.ts:93-98`, `:132-138`).
- **Transactions (3 sites, one shape):** `intake.ts:89-106`, `inbound.ts:135-146`,
  `reconciliation.ts:118-129`.

**The port is internal; the package ships both implementations.** That is the
whole design decision. `models/report.ts:15-19` already rejected a store port —
but it rejected *the application implementing one*, because each method carries a
correctness property that is invisible when wrong. Shipping two implementations
inside the package keeps that rejection completely intact: an adopter still writes
only its four things, and still never re-derives a query.

Shape: one package, three subpaths.
`@oxyhq/crowdsource-app` (storage-free core, `createModerationIntegration({ store })`),
`/mongoose`, `/postgres`. `mongoose`, `drizzle-orm` and `postgres` become
**optional** peers, so a Postgres adopter never installs mongoose and vice versa.
Rejected: two packages (duplicates ~1,000 lines whose whole point is being
shared — `enforcement/planner.ts:26-33`), a config discriminator (makes both
drivers reachable from the entrypoint), and inference from an installed peer.

Ten source files import mongoose (`decision.ts:1`, `delivery.ts:1`,
`inbound.ts:1`, `intake.ts:1`, `models/index.ts:1`, `models/report.ts:1`,
`outbox/service.ts:2`, `reconciliation.ts:1`, `types.ts:23`,
`enforcement/executor.ts:1`). **Six are already storage-free** and need no change:
`webhook.ts`, `client.ts`, `evidence.ts`, `enforcement/planner.ts`,
`outbox/dispatcher.ts`, `reportStatus.ts`.

**The one new adopter obligation:** the three package-owned tables need DDL. The
package exports `moderationTables()`; the adopter re-exports them from its own
drizzle schema and generates the migration itself. **The package must not ship a
migrations folder** — `@oxyhq/db`'s ledger applies only entries strictly newer
than the high-water mark (`@oxyhq/db/src/migrate/ledger.ts:119-132`), so a second
journal interleaved with the adopter's is skipped **in silence with exit 0**.

---

## 2. Guarantees Postgres must reproduce

Fourteen, in the design's §2. The ones that decide the work:

- **G1 atomic report+outbox.** Postgres is *stronger* (one `BEGIN…COMMIT`, no
  replica-set precondition — `README.md:77-82` goes away). New silent failure:
  a store call taking `db` instead of `tx` runs on a different pooled connection.
  The guard transfers as `tx instanceof PgTransaction` — verified a real runtime
  export of `drizzle-orm/pg-core`.
- **G2 `enqueue` must be a true no-op for an existing row.**
  `outbox/service.ts:347-403` documents why: a real write conflicts with a live
  lease and aborts the enclosing transaction. `INSERT … ON CONFLICT DO NOTHING`
  gives this by construction. `DO UPDATE` reintroduces it exactly — the natural
  mutation twin for `test-invariants.mjs:89-101`.
- **G3 dedupe.** `ON CONFLICT DO NOTHING RETURNING id` → zero rows means "taken".
  Better than porting the `code === 11000` catch (`inbound.ts:33-40`): it never
  throws, so a connection failure cannot be widened into "already processed"
  (`inbound.ts:81-86`). If any catch survives, it **must** use
  `isUniqueViolation` — drizzle wraps the driver error, so `error.code` matches
  nothing (`@oxyhq/db/src/pgErrors.ts:1-21`).
- **G4 enforcement claim.** Make `(decision_id, decision_revision, action)` the
  composite **primary key** — the Mongo unique index (`models/index.ts:282`) and
  the required PK become one object.
- **G5 owner-checked lease transitions.** `RETURNING` counts *matched* rows;
  `complete`/`fail` currently read `modifiedCount` and `renew` reads
  `matchedCount` (`service.ts:232`, `:312`, `:337`). Equivalent here because both
  always change `status` — an argument, not a test, and it belongs in a comment.
- **G6 `FOR UPDATE SKIP LOCKED` is load-bearing, not tuning.** Without it a loser
  blocks then gets zero rows, `claim` answers `null`, `dispatch` breaks its batch
  (`service.ts:456`), and an N-task deployment silently drains at 1/N with nothing
  failing. New mutation required.
- **G7 revision guard in the WHERE clause** (`decision.ts:77-82`) →
  `or(isNull(col), lte(col, n))`. `$exists: false` ≡ `IS NULL`; `<=` not `<`.
- **G8 reversal reads the newest APPLIED row** (`executor.ts:139-148`) plus the
  supporting index (`models/index.ts:286`). Two proven mutations attack it.
- **G9 Mongo reaps; Postgres does not.** Two TTL indexes vanish silently
  (`models/index.ts:100`, `:176`). `@oxyhq/db/expiry` replaces them, and its own
  header names this as the quietest failure in a Mongo port (`expiry.ts:11-26`).
  The package exports the two targets over its own tables; the adopter merges
  them into its registry. The outbox is exactly the "TTL'd table holding
  unprocessed work" case `expiry.ts:41-49` demands a written note about.
- **G10 the action enum** becomes a generated `CHECK` — so adding an action
  becomes a migration where it used to be a restart. Real regression, correct
  trade, stated rather than absorbed.
- **G13 a malformed report id.** `delivery.ts:88-97` treats "no report" as
  "complete the event". A garbage id against a `uuid` column raises `22P02` from
  the driver, which nothing catches → retried forever. **A new failure mode the
  port creates**, needing an explicit branch.
- **G14 isolation.** READ COMMITTED explicitly; `repeatable read` would import
  `40001` retries for no benefit. The read-then-insert duplicate check
  (`intake.ts:149-153`) is *not* serialized — but Mongo's snapshot isolation does
  not serialize it either, and the package leaves that unique index to the
  application (`models/report.ts:133-137`). Not a regression; recorded so nobody
  re-discovers it as a Postgres defect.
- **G12 a whole failure class disappears.** `requireIdentifier`
  (`intake.ts:67-72`) exists because Mongo accepts `{ $ne: null }` as a *query
  operator*. A bound parameter cannot become one. Keep the guard, rewrite its
  reasoning — copying the comment asserts a hazard Postgres does not have.

---

## 3. Size, and its basis

**Six to eight working days, one person**, with the tail in verification. Not a
feeling — the breakdown is in design §7. The three things that hold it down:

1. **No adopter exists to migrate** (see §5 below), so the config change is a
   clean cut with no compatibility surface.
2. **Six of eighteen source files never touch storage.**
3. **Every risky type question was answered by a compiling probe**, not deferred
   to discovery — see §6.

Syra's own adoption afterwards: **1–2 days**, mostly deletion.

What could push it up: the `describe.each` refactor of
`reviewOnlyApplication.test.ts` (it builds its own connection and models inline —
`:103`, `:147-152`), and the possibility that a mutation twin cannot exist because
the guarantee is structural rather than a deletable line. **`ON CONFLICT DO
NOTHING` is exactly that shape.** A guarantee you cannot break by deleting a line
is a better guarantee — but it yields a mutation with nothing to delete, and the
honest response is to record why, not to invent one that proves nothing.

---

## 4. Keeping both backends honest, and its cost

**`pg-mem` is rejected** — it is the direct analogue of the mocked driver this
package already refuses (`vitest.globalSetup.ts:20-27`). It does not implement
`SKIP LOCKED` (G6), real MVCC concurrency (G2), or advisory locks. A fake that
answers queries cannot validate the queries.

**Adopted: a real Postgres with per-file throwaway databases** —
`@oxyhq/db/testing`'s `createTestDatabase`, proven in-ecosystem by Mention
(`Mention/.github/workflows/ci.yml:169-186`,
`Mention/packages/backend/vitest.globalSetup.ts:43`). Plain `postgres:17`;
nothing here needs PostGIS.

**Concrete cost.** Of 62 tests, **25 are already storage-free**
(`enforcementPlanner.test.ts` 17, `configTypeErgonomics.test.ts` 8) and run once;
**37 across five files run twice**. 62 → **99**, so the CI floor moves from 48
(`ci.yml:122`) to ~85. The mechanism is one `describe.each` over the existing
`createHarness` seam (`__tests__/support/harness.ts:240`) — **no test body
changes**, which is what makes it affordable.

`test-invariants.mjs` goes **11 → ~17**: five mutations stay storage-free, six
need Postgres twins, two are new (SKIP LOCKED; `tx`→`db` inside a transaction).
Two script changes are non-optional: a `backend` field to route each mutation,
and a **per-backend vacuity floor** — the current
`checked !== MUTATIONS.length` (`:384`) is satisfied by a run where the Postgres
harness silently fell back to Mongo. And the SKIP LOCKED mutation's natural
failure mode is a *block*, so it must be bounded with `statement_timeout` — the
`maxTimeMS` lesson, transferred.

CI: a `services:` block is job-level and `tests` is a nine-entry matrix
(`ci.yml:72-128`), so a container starts for entries that never connect. Mention
hit and documented the same constraint (`Mention/.github/workflows/ci.yml:164-167`).
Accepted.

---

## 5. Existing adopters — there are none

**No committed manifest in `~/Oxy` depends on `@oxyhq/crowdsource-app`.** Seven
backends (Mention, Homiio, Mercaria, Moovo, Allo, Alia, Syra) pin the *client*
packages at `0.3.0` and hand-roll the adopter half. The only reference is
`.worktrees/mention-crowdsource/packages/backend/package.json:26` — an unmerged
branch pointing at a local `0.3.0` tarball.

This is the largest sizing lever in the document, and it is a fact rather than an
assumption. Two consequences: replacing `connection`/`reportModel`/`modelPrefix`
with one `store` costs nothing, and **Mongo must still stay first-class** — six of
the seven declare only `mongoose`; Mention declares both.

**Backend selection is by which store factory the adopter imports**, from a
subpath — not configuration, not a separate package, not peer inference.

One cost that must be paid: 0.4.0 exists because ≤0.3.0 declared an `import`
condition pointing at CommonJS and took a backend down on 2026-07-30
(`packages/app/README.md:28-49`). Every new subpath needs the same dual build and
the same two manual load checks (`:51-75`), and `check:module-format`
(`package.json:56`) must learn about them or it silently covers only the root.

---

## 6. What I recommend deferring or not doing

- **Do not ship a migrations folder.** The recommendation most likely to be
  reversed by someone being helpful, and it fails with exit 0.
- **Do not make either driver a required peer.** Both optional, both behind
  subpaths.
- **Defer a `pg` (node-postgres) driver.** Speculative; `isUniqueViolation` walks
  the cause chain for postgres.js's field names specifically
  (`pgErrors.ts:88-95`).
- **Defer table prefixing.** `modelPrefix` (`types.ts:611`) solves a Mongoose
  model-registry collision that does not exist when the adopter passes its own
  table objects.
- **Do not build a Mongo→Postgres data migration.** Outbox and event rows are
  90-day transients, and the outbox is already re-derivable from reports by the
  reconciliation sweep (`reconciliation.ts:9-39`). A general migrator for a
  package with zero adopters is work for a case that does not exist.
- **Worth deciding before starting:** whether the package consumes `@oxyhq/db` at
  all. Consuming it makes a bad `@oxyhq/db` publish a moderation outage.
  Recommendation is **consume it, as a peer** — the alternative is a second copy
  of `isUniqueViolation` and the expiry sweep, the exact divergence `@oxyhq/db`
  was extracted to end — but the risk belongs in the record.

---

## 7. What I could not determine, and what would settle it

1. **Whether the builder-API handle type survives a 600-line store.** Probe 3 is
   ~40 lines. *Settle:* write the outbox store first and type-check before
   anything else. The `SqlExecutor` fallback is already proven in-tree by
   `@oxyhq/db`'s expiry sweep, so this is cost, not feasibility.
2. **How much of the 37 storage-backed tests genuinely needs to run twice.** The
   25/37 split is by file, from imports. *Settle:* classify each by which §2
   guarantee it exercises.
3. **Wall-clock cost of the invariant script after the split.** Not measured —
   deliberately. `test-invariants.mjs` mutates `src/` in place and this tree is
   shared with other running agents; running it would have corrupted *their*
   measurements. *Settle:* one timed run on an isolated worktree.
4. **Whether every mutation has a Postgres twin.** G2 and G3 are structural.
   *Settle:* attempt each during implementation and record the ones that cannot
   exist, with the reason.
5. **What the adopter's `@oxyhq/db/assert` gates say about the package's tables.**
   The `withoutForeignKey` obligation is derived from reading
   `assert/idColumns.ts:1-32`, not from running a gate. Six `*_id` columns
   (`case_id`, `decision_id`, `subject_id`, `crowdsource_report_id`,
   `crowdsource_case_id`, `report_id`) can never carry a foreign key — they name
   rows in CrowdSource's database. Unclassified, the first adopter's gate fails on
   adoption. *Settle:* generate the tables into Syra's schema and run its
   inherited assert suite once.
6. **Whether `@oxyhq/crowdsource-testing`'s sandbox is storage-coupled.** Not
   audited. *Settle:* read `packages/testing/src` (`sandbox.ts`,
   `webhook-simulator.ts`) before harness work. Likely a non-issue — it simulates
   the CrowdSource *server* — but half a day if not.

---

## 8. Verification I did, and one correction

**Five type probes against the real `drizzle-orm@0.45.2`**, compiled with
`tsc --strict` (working files in the session scratchpad, outside every repo):

1. The obvious narrow handle type —
   `PgDatabase<PgQueryResultHKT, Record<string, never>, Record<string, never>>` —
   accepts **neither** a pool nor a transaction (`TS2345`).
2. `PgDatabase<PgQueryResultHKT, Record<string, unknown>, TablesRelationalConfig>`
   accepts **both**, with the full builder API reachable.
3. Every load-bearing query shape compiles through it:
   `onConflictDoNothing({ target }).returning()`, the
   `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING` claim, the
   owner-checked transition, `inArray` + `desc` + `limit(1)`, the revision guard,
   a generated `CHECK`, and a composite unique index.
4. A structural `ModerationReportTable` accepts a table composed from an exported
   column factory and **rejects** one missing those columns — the
   `@ts-expect-error` on the negative case was satisfied, so the check is not
   vacuous. That makes the Postgres side *stronger* than the Mongoose side, where
   `Model<TReport>` checks the TypeScript type and not the schema paths.
5. `PgTransaction` is a real runtime export (`typeof === 'function'`), so
   `tx instanceof PgTransaction` is available as the analogue of
   `session.inTransaction()`.

**Correction, unprompted:** `AGENTS.md:51` cites `packages/app/README.md`
§ "Writing a check that can actually fail". **That section does not exist** — the
README's only headings are *Dynamic require*, *Before publishing*, *Requirements*,
*Testing your integration*, *What you do not write*, *License* (106 lines). The
content it describes lives in `scripts/test-invariants.mjs:1-24`. Exactly the
class of stale claim `~/Oxy/AGENTS.md` §(D) warns about: docs are the one place a
wrong statement persists, because no consumer ever trips over it.

**Also worth noting:** the brief says Syra has 15 non-test files in
`packages/backend/src/moderation/`. That counts the top level; there are **18**
including `subjects/{types,registry,providers}.ts`. It does not change the
conclusion — 13 of the 18 are deleted by adoption, plus three models.

---

## 9. Concerns

- **`ON CONFLICT DO NOTHING` gives two of the strongest guarantees for free, and
  therefore resists mutation-proof.** That is a genuinely good outcome that will
  look like a hole in the discipline. It needs a written verdict at implementation
  time, not a fabricated mutation.
- **The DDL obligation is where an adopter will go wrong.** Mongo creates a
  collection on first write; Postgres does not. An adopter who wires the store and
  forgets the migration gets a `42P01` at the first report — loud, at least. The
  worse version is forgetting the **expiry registry entries** (G9), which is
  silent forever.
- **`@oxyhq/db` at 0.1.2 becomes a release dependency of moderation.** Small
  surface, three consumers, two days old. Recommended anyway, flagged deliberately.
- **CrowdSource's server stays on MongoDB.** After this lands, the same repo ships
  a Mongo server and a package whose reference backend for new adopters is
  Postgres. That is correct — they are different halves — but it will read as
  inconsistent to the next person, and the design says so in its scope line.

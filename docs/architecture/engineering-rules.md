# Engineering rules and the reasoning behind them

> Moved out of `AGENTS.md` unchanged. The one-line rules stay there; this is why
> each of them exists, and the incidents that produced them.

## Architecture, packages and the integration surface

Each package README says what it holds. **Do NOT record per-package build status in this file.** The sentence that used to sit here said the reviewer app was "the foundation without review surfaces" long after `packages/reviewer/app/(app)/review.tsx`, `recuse.tsx`, `history.tsx`, `training.tsx`, `reliability.tsx` and `wellbeing.tsx` had all shipped, so it read as an instruction not to go looking. Read the tree.

**Rebuild `contracts` before believing a red typecheck.** `@oxyhq/crowdsource-contracts` is consumed through its BUILT `dist` — backend, sdk, sdk-express, testing and app all import the published shape, never `src`. After any rebase or checkout that pulls in a contracts change, every other package still compiles against the previous build and reports the newly-landed symbols as missing (`TS2305`) in files nobody touched. It reads exactly like someone else's broken commit. `cd packages/contracts && bun run build` first; only an error that survives that is real.

The four integration packages target **near-zero configuration**, which is a product requirement rather than a nicety: one environment variable and the object being reported. Two consequences bind every change to them.

- **`applicationId` is read off the credential, and there is no surface that can carry one.** The service key an integrator configures is `applicationId:credentialId:secret` — the three values `issueApplicationCredential` already returns, joined — so the client knows its own application without being told. Never add an `applicationId` option, field or parameter; the envelope's copy exists so a mismatch can be DETECTED, and the credential is its only source.
- **A default must be a pinned version, never "whatever is current".** `DEFAULT_POLICY` in `packages/sdk/src/defaults.ts` names an immutable published version and MUST equal `BASELINE_POLICY_SET_ID`/`BASELINE_POLICY_VERSION` in the backend's `policyBaseline.ts`; `sdk/src/__tests__/defaults.test.ts` reads that file and asserts it. A resolved-at-ingress "latest" would move the policy under an application that changed nothing and would split §7.3's dedup key, giving one post two cases.
- **Nothing the client composes may vary between two deliveries of the same report.** Ingress fingerprints the whole `{ externalReportId, envelope }` to detect §10.5's payload conflict, so an invented timestamp, a random id or an unsorted list turns a legitimate outbox retry into a permanent 409 — silently, days later, as moderation work stuck in a queue. This is why resource ids are positional, principal refs are derived from the identity, and `source.submittedAt` has no default.
- **`packages/app` owns the adopter's half, and an adopting application writes only four things**: its subject providers, its category→allegation mapping, its enforcement tables plus one `apply`, and its own report model. Anything an application would otherwise copy — the transactional outbox, delivery, the webhook receiver, cross-instance dedupe, decision application, the enforcement claim and the enforcement PLANNING ALGORITHM — belongs here, not in seven repos. The planner is shared even though its tables are per-app for one reason worth restating: a correction arrives as `no_violation` + `no_action`, meaning "take no NEW action" rather than "leave what you already did in place", and mapping it straight through leaves the removed object removed forever with no error, no log line and no failing test. Its PostgreSQL suite runs against a real server rather than a mocked driver; a fake cannot prove transactions, catalogue constraints or `SKIP LOCKED` concurrency.
- **Every guard in that suite is mutation-proven.** `packages/app/scripts/test-invariants.mjs` deletes each guard in turn, confirms the mutated tree still type-checks, and asserts the SPECIFIC named test goes red — a mutation nobody's test catches is not a guard. The active table contains **thirteen** mutations (6 shared, 7 PostgreSQL), with a per-bucket floor so the storage-specific guards cannot silently stop executing. A mutation whose failure mode is a timeout carries no information; PostgreSQL contention tests therefore use a bounded pool `statement_timeout` and fail fast by name.

### Backend

A **modular monolith**, deliberately — not microservices. Module boundaries are explicit so a module can be extracted later (evidence processing, webhook delivery and sortition first), but nothing is deployed separately.

- `src/app.ts` builds the HTTP application and opens no connections, starts no timers and registers no process handlers. `server.ts` owns all of that. Keep that split: it is what lets the application be tested without a runtime around it.
- Modules mount in `src/app.ts` as they are built: tenancy, ingestion, evidence, cases, policy registry, triage, sortition, review, consensus, decision, webhook delivery, reputation bridge, operations.
- Cross-module communication goes through the **outbox** (see the invariant below). Never call another module's service directly across that boundary.
- Every consumer is at-least-once. Record the processed event id or rely on an equivalent unique index; the domain must tolerate replay.

### BullMQ is dispatch. It is NEVER the durable record.

The plan specified SQS: replicated, durable, with DLQs. What CrowdSource actually runs is a single-node `cache.t4g.micro` Valkey — **no replica, no failover, no snapshots** — shared with six live backends and running `maxmemory-policy=noeviction`. A node replacement (routine AWS maintenance counts) or an out-of-memory condition loses or refuses queued jobs: case ingestion, webhook delivery, consensus recalculation, retention, reputation effects.

That is survivable ONLY because of the outbox, so with this queue the outbox is load-bearing rather than good practice:

- A domain write and its outbox document commit in **ONE MongoDB transaction**. The dispatcher then reads the outbox and enqueues.
- **Never enqueue work that is not already recorded in the outbox.** A job is a hint that work is pending, never the only evidence that it exists. If the queue is wiped, every pending job must be re-derivable by re-reading the outbox.
- A dropped job is therefore a delay. Work enqueued without its outbox row is lost moderation work with no trace — and it fails silently until the day a node is replaced.
- **Nothing in infrastructure enforces this.** It holds only by review, exactly like the tenant-isolation rule above.
- Transactions require a replica set or a sharded cluster. `src/utils/mongoTopology.ts` asserts this at boot and refuses to start on a standalone, because otherwise the first transactional write is where you find out.

BullMQ mechanics on the shared Valkey: queue names and custom job ids cannot contain `:`; connections need `maxRetriesPerRequest: null`; `REDIS_URL` must carry an explicit non-zero database index, or two Oxy backends elect one leader between them and consume each other's jobs — restore that guard in `deploy-aws.yml` with the first queue. Any module-level `setInterval` singleton calls `.unref?.()`.

## Where the plan and the ecosystem disagree, the ecosystem wins

`.plan/PLAN.md` is binding on **product**: the invariants above, the Case Envelope contract, the case lifecycle, sortition and consensus, the privacy model. Its **plumbing** choices were made without context on Oxy and defer to `~/AGENTS.md` and `~/Oxy/AGENTS.md`. Divergences decided so far — each owed an ADR:

| Plan § | Plan says | CrowdSource does |
| --- | --- | --- |
| 12.3 | RDS PostgreSQL | MongoDB + Mongoose, own database in the shared instance |
| 12.3 | SQS + DLQ | BullMQ over the existing Valkey |
| 12.3 | S3 + KMS evidence bucket | `cloud.oxy.so` via `oxyServices.getFileDownloadUrl` |
| 12.4 | sandbox + staging + production | production only, like every other Oxy app |
| 12.7 | Row Level Security | code discipline — the access layer forces the tenant filter |
| 12.7 | relational constraints | unique compound indexes |

Apply the same rule beyond this table. Anything the ecosystem already solves once — session handling, device-first cold boot, media resolution — is consumed from the shared SDK, never reimplemented here, and a bug in `@oxyhq/*` or Bloom is fixed upstream, never patched locally.

### Persistence

**MongoDB is the system of record** for `packages/backend`, the ECS service; files go through the Oxy media chokepoint. Valkey holds nothing that must survive (see the BullMQ invariant above).

`@oxyhq/crowdsource-app` (`packages/app`) is PostgreSQL-only from the 0.7 source line. Its former Mongoose subpath is a breaking, manifest-gated adopter migration; the package no longer installs or publishes that driver. "CrowdSource is on Mongo" remains true of the backend service until its separate cutover and false of the application package; say which one you mean.

**A Postgres cutover for the service is planned, and everything it falsifies is listed in [`docs/architecture/postgres-cutover-claims-ledger.md`](docs/architecture/postgres-cutover-claims-ledger.md).** Work through it in the cutover rather than rediscovering it afterwards — including the two things nothing else in Oxy has (a second database role, and RLS), and the `databaseIdentity.ts` guard, whose failure mode is a Mongo-only `dbName` override and therefore RETIRES rather than porting.

`packages/backend/src/config/databaseIdentity.ts` declares the database name. This is a source constant and NOT configuration on purpose: `mongoose.connect(uri, { dbName })` hands `dbName` to the driver, which does `dbName != null ? client.db(dbName) : client.db()` — it **overrides** the database named in `MONGODB_URI`. A wrong value does not fail to connect; it silently reads and writes another Oxy product's live data. Four things move together, always in the same change: that declaration, `.github/scripts/assert-own-database.sh` (reads it before a release is built), `.github/scripts/test-assert-own-database.sh` (mutation-tests the guard), and `src/__tests__/databaseIdentity.test.ts` (asserts the connection actually uses the declared value, so the guard cannot pass while the runtime ignores it).

### Multi-tenancy — the invariant most likely to be broken

Postgres would have made isolation a property of the database. Mongo does not, so **isolation is a property of this codebase and nothing else enforces it**. `packages/backend/src/db/tenantScope.ts` is that boundary:

- A `TenantContext` is built ONLY by `createTenantContext`, from the authenticated service credential — never from a request body, path parameter, query string or header. A tenant id the caller can choose is not isolation, it is an IDOR.
- Every read and write on a tenant-owned collection goes through `tenantScopedFilter` / `tenantScopedDocument`. No module reaches the Mongoose driver around this layer.
- Supplying a tenant key yourself is rejected with a throw, not silently corrected — the belief that a caller picks the tenant is the bug, and it has to surface in tests.
- Cross-tenant correlation happens ONLY through `Incident`, in a privileged module that never returns another tenant's data to an application-API caller.
- Public ids are ULID or UUID, never sequential.

### Idempotency lives in unique compound indexes

The plan lists these as relational constraints (§12.7); in Mongo they are unique compound indexes, and they are **required** — every one of them is what makes a retry safe rather than duplicating a case, a review or a penalty. Create each with the collection that owns it:

- `applicationId + externalReportId` — a report is delivered once.
- `applicationId + idempotencyKey` — a retry returns the same `reportId`.
- `applicationId + externalSubjectId + contentHash + policyVersion` — the case dedup key.
- `caseId + reviewerId + decisionRevision` — one review per juror per revision.
- `webhookEndpointId + eventId` — one logical delivery, many attempts.
- `incidentId + principalId + effectType + decisionRevision` — one reputation effect per incident and revision.
- Plus operational indexes: case `status + priority + createdAt`, and the reviewer eligibility dimensions (category, language, state, sensitivity).

### Reviewer test isolation is a registry, not a convention

A case belongs to a tenant; a reviewer belongs to none — `candidatePool.ts` has no tenant filter, deliberately, because juries are cross-tenant by design. `fileParallelism: false` in `vitest.config.ts` runs every integration test file one at a time, but all of them share ONE `mongodb-memory-server` replica set for the whole run, so a reviewer profile an earlier file created is still there when a later file draws a panel. The only thing that keeps two files apart is §8.2's eligibility rule: a reviewer must hold BOTH a case's taxonomy family and its language. That used to be a convention stated in a comment. `reviewerAppContract.integration.test.ts` and `appeals.integration.test.ts` each privately claimed `(harassment, ast)`, each comment asserting the pair was unique, and the collision surfaced only as an order-dependent flake once a later file shifted execution order.

It is now `packages/backend/src/__tests__/support/reviewerAxes.ts`: a registry mapping test-file basename → named `(family, language)` cells, gated by `reviewerAxes.test.ts`, which asserts both distinctness AND completeness (every file that seeds reviewer profiles has an entry, behind a minimum-file-count floor). Distinctness alone is nearly worthless — it's trivially satisfied by a registry that forgot a file; completeness is what makes distinctness mean anything. **Take a cell from the registry; never declare a family/language pair inline.**

Two things worth stating plainly, because a reader will otherwise assume the opposite: `hate` is not unclaimed — `sortitionPanel.integration.test.ts` serves it in its own mutation control at the end of the file, and the reservation is against every OTHER file, not that one. And the eligibility match is exact array-contains on the string, so `ast` and `ast-ES` do NOT collide — region variants are not equivalent here.

**If you're checking whether this class of bug is present, assert on the FILE count, not the test count.** A collision manifests as a hook throwing (a `beforeAll` that draws the wrong panel), which Vitest reports as `Test Files 1 failed` while the line most people skim reads `Tests 40 passed | 3 skipped` — zero tests marked `failed`, because a thrown hook skips the tests under it rather than failing them individually. A detection script that greps for `Tests .*failed` reads a run with the bug present as a clean baseline. Verified against this repo's actual Vitest 4 output, not assumed.

### Reviewer app

Expo Router + React Native Web from one codebase. `app/_layout.tsx` is the SOLE authority for the `(auth)` ↔ `(app)` group swap — a child screen must never navigate across that boundary on the same signal.

Case material must never reach device storage, logs or analytics. `utils/storage.ts` is for preferences only; anything the server issues belongs to the SDK's secure session storage.

## AWS deployment

- **Port**: `3000` | **Domain**: `api.crowdsource.oxy.so` | **Reviewer**: Cloudflare Pages project `crowdsource-frontend` | **Console**: Pages project `crowdsource-console` at `console.crowdsource.oxy.so`, whose deploy job is gated on the repository variable `CROWDSOURCE_CONSOLE_PAGES == 'ready'` because it creates a project and writes DNS into the zone that carries every live Oxy backend.
- **ECR**: `237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/crowdsource`
- **Deploy**: `git push origin main` → `.github/workflows/deploy-aws.yml` (backend) + `deploy-frontends.yml` (reviewer), both gated on CI.
- **Secrets**: GitHub Actions secrets → SSM `/oxy/crowdsource/*`. Only what `src/config` actually reads is synced; a parameter nothing consumes never rotates and nothing fails when it goes stale.
- **The migration runner now EXISTS** (`packages/backend/scripts/migrate.ts` → `dist/scripts/migrate.js`, the path `deploy-ecs-image.sh` names), so the old rule "flip `RUN_MIGRATIONS` in the same change that adds the runner" has been overtaken. `RUN_MIGRATIONS` is still `false`, and what gates it now is INFRASTRUCTURE, not code: the `crowdsource` database has to exist with runbook 30 §2A's two roles, and the one-shot needs the MIGRATOR's credential — which the serving task definition must never carry, because that role owns every table and an owner can `DROP POLICY` on its own. ECS container overrides cannot inject a secret, so the migration task needs its own task definition. Flip `RUN_MIGRATIONS` in the change that lands that, and not before: turned on earlier, every deploy fails at the migration step.
- **`DATABASE_URL` is required to boot** (`src/config/index.ts`), which makes it unlike every other secret here: absent, the task exits at start rather than degrading a route. It must be live in the task definition before an image requiring it rolls out. `MIGRATOR_DATABASE_URL` is read only by the migration entrypoint, which deliberately imports no application config — `deployWiring.test.ts` walks the import graph and fails the build if it ever reaches `src/config` again.
- One environment. There is no sandbox or staging deployment; the plan's §12.4 three-environment model is not what Oxy runs. Tenant-facing sandboxing is an application-trust state inside production, not a separate stack.

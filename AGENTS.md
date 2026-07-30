# CrowdSource

> Parent files (`~/AGENTS.md`, `~/Oxy/AGENTS.md`) hold universal standards, the agent team, shared-SDK rules, SDK version targets, Bloom/Expo/expo-router gotchas, and the infra pointer. This file holds ONLY CrowdSource-specific content.

CrowdSource is multi-tenant **participatory moderation infrastructure**: applications send universal reports, randomly drawn juries review them blind, a consensus engine publishes versioned decisions, and webhooks return those decisions to the application. It is a product of its own, not a feature of any app that uses it.

The repository began as a fork of Mention, taken for its Expo/Bloom/monorepo foundation only. Nothing of Mention the product survives. There is no shared data, identity, service or deployment between them, and no code should ever reach back for one.

## Invariants (no change may break these)

These come from the approved product specification. They are not preferences; a change that violates one is wrong even if it passes review.

- **Nobody chooses the case they review.** The server issues an assignment. There is no case search, no shareable case link, no public queue.
- **A reviewer never sees partial votes**, other jurors' identities, the reporter's identity, or anyone's reputation.
- **One qualified person, one vote.** Reputation affects eligibility and selection probability, never the weight of a vote inside a jury.
- **A published decision is never edited, only superseded.** Outcome, findings and policy versions of a published revision are immutable; an appeal creates a new revision that supersedes it.
- **One penalty per incident.** A hundred reports about the same material produce one case and one consequence.
- **Every effect is idempotent, explainable and reversible**, and carries the policy version it was decided under.
- **Sensitive content never reaches logs, metrics or attestations.**
- **Absence of consensus is neither guilt nor innocence.** `inconclusive` is its own outcome and must never collapse into `no_violation`.
- **`applicationId` comes from the credential, never from the request body.**
- **No binding proof, no Oxy Trust effect.** An application can never move a reputation figure directly; it emits a report and CrowdSource emits a decision.

## Architecture

Bun workspaces.

```
packages/
  contracts/      @oxyhq/crowdsource-contracts  Zod + JSON Schema contracts (published)
  backend/        @crowdsource/backend          Express modular monolith
  reviewer/       @crowdsource/reviewer         Expo Router reviewer app (web + native)
  console/        @crowdsource/console          Developer + Trust & Safety console (Expo Router, web only)
  sdk/            @oxyhq/crowdsource            TypeScript client (published)
  sdk-express/    @oxyhq/crowdsource-express    Webhook middleware (published)
  testing/        @oxyhq/crowdsource-testing    Fixtures + webhook simulator (published)
docs/{architecture,api,policies,runbooks}
```

Current state: contracts, sdk, sdk-express and testing are written; the reviewer app is the foundation without review surfaces; the console covers the developer surface and the Trust & Safety trust/delivery surfaces. Each package README says what it holds.

The three integration packages target **near-zero configuration**, which is a product requirement rather than a nicety: one environment variable and the object being reported. Two consequences bind every change to them.

- **`applicationId` is read off the credential, and there is no surface that can carry one.** The service key an integrator configures is `applicationId:credentialId:secret` — the three values `issueApplicationCredential` already returns, joined — so the client knows its own application without being told. Never add an `applicationId` option, field or parameter; the envelope's copy exists so a mismatch can be DETECTED, and the credential is its only source.
- **A default must be a pinned version, never "whatever is current".** `DEFAULT_POLICY` in `packages/sdk/src/defaults.ts` names an immutable published version and MUST equal `BASELINE_POLICY_SET_ID`/`BASELINE_POLICY_VERSION` in the backend's `policyBaseline.ts`; `sdk/src/__tests__/defaults.test.ts` reads that file and asserts it. A resolved-at-ingress "latest" would move the policy under an application that changed nothing and would split §7.3's dedup key, giving one post two cases.
- **Nothing the client composes may vary between two deliveries of the same report.** Ingress fingerprints the whole `{ externalReportId, envelope }` to detect §10.5's payload conflict, so an invented timestamp, a random id or an unsorted list turns a legitimate outbox retry into a permanent 409 — silently, days later, as moderation work stuck in a queue. This is why resource ids are positional, principal refs are derived from the identity, and `source.submittedAt` has no default.

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

**MongoDB is the system of record**; files go through the Oxy media chokepoint. Valkey holds nothing that must survive (see the BullMQ invariant above).

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

### Reviewer app

Expo Router + React Native Web from one codebase. `app/_layout.tsx` is the SOLE authority for the `(auth)` ↔ `(app)` group swap — a child screen must never navigate across that boundary on the same signal.

Case material must never reach device storage, logs or analytics. `utils/storage.ts` is for preferences only; anything the server issues belongs to the SDK's secure session storage.

## Oxy integration

- **Two authentication surfaces, neither bypassing the other.** Reviewer, developer-console and Trust & Safety callers are Oxy sessions, verified with `@oxyhq/core/server` — never an app-local bearer parser or `AuthRequest` type. Session verification is defined ONCE, in `src/modules/identity/oxySession.ts`; a second module-level client with its own failure message is a second, divergent definition of what a valid session is. Application-API callers are service credentials, which are CrowdSource's own and are what `applicationId` is derived from. A service credential must never reach a session route, and an Oxy session must never satisfy an application-API route.
- **THREE authorizations on that one authenticated identity, and they are not interchangeable.** A reviewer profile (`reviewerAuth.ts`), an organization membership (`console/membership.service.ts`) and a Trust & Safety role (`console/consoleAuth.ts`) each mean something different. A verified session by itself grants none of them: every Oxy account in existence authenticates. Staff authority is a further check on a valid session, folded into the SAME middleware array as the session so a route cannot be mounted with one and not the other, and there is deliberately no HTTP route that grants a staff role — `console/staff.service.ts` says why.
- **A console caller names a resource; it never names a tenant.** `/console/applications/{id}` is not an IDOR because `organizationId` is read off the STORED application row and a membership is required before a `TenantContext` is built. The four steps are in `resolveApplicationForMember`, and every console route that touches tenant data starts there. No console handler reads an `organizationId` from a body or query string.
- Security helpers come from the same place: `safeFetch` (SSRF), `createOxyCors` (no hand-rolled wildcard), `verifySecret` (constant-time; never `!==`).
- **Files and media**: `oxyServices.getFileDownloadUrl(id, variant)` plus Bloom's `ImageResolver`, registered once at the app root. Never a per-app URL helper, never a hardcoded host, never an `avatarUrl` field on a DTO.
- **Identity in the app**: one `OxyProvider` in `components/providers/AppProviders.tsx`, web and native alike. No app-local auth routes, token providers or `Authorization` headers.
- **Reputation**: CrowdSource never writes Oxy Trust. It emits an authenticated internal event and Oxy Trust's own consequence engine decides the effect. That direction is one-way and non-negotiable.
- **`EXPO_PUBLIC_OXY_CLIENT_ID` has no default.** No Oxy OAuth client is registered for CrowdSource yet, and hard-coding one would borrow another product's identity. Interactive sign-in stays unavailable until it is configured.

## AWS deployment

- **Port**: `3000` | **Domain**: `api.crowdsource.oxy.so` | **Reviewer**: Cloudflare Pages project `crowdsource-frontend` | **Console**: Pages project `crowdsource-console` at `console.crowdsource.oxy.so`, whose deploy job is gated on the repository variable `CROWDSOURCE_CONSOLE_PAGES == 'ready'` because it creates a project and writes DNS into the zone that carries every live Oxy backend.
- **ECR**: `237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/crowdsource`
- **Deploy**: `git push origin main` → `.github/workflows/deploy-aws.yml` (backend) + `deploy-frontends.yml` (reviewer), both gated on CI.
- **Secrets**: GitHub Actions secrets → SSM `/oxy/crowdsource/*`. Only what `src/config` actually reads is synced; a parameter nothing consumes never rotates and nothing fails when it goes stale.
- `RUN_MIGRATIONS` is `false` until the migration runner exists. Flip it in the same change that adds the runner, never before.
- One environment. There is no sandbox or staging deployment; the plan's §12.4 three-environment model is not what Oxy runs. Tenant-facing sandboxing is an application-trust state inside production, not a separate stack.

## Commands

```bash
bun run dev                 # all packages
bun run dev:backend         # backend watch mode
bun run dev:reviewer        # reviewer app (Expo tunnel)
bun run dev:console         # console (Expo web, web only)
bun run build               # contracts, backend, SDKs
bun run build:reviewer      # reviewer static web export
bun run build:console       # console static web export
bun run check               # doctor + workflows + security audit + build + typecheck + lint
bun run test                # contracts + backend (vitest) + reviewer and console (jest)
```

## Planning

`.plan/` holds the approved specification and the working checklist. It is gitignored, local-only, and must never be deleted or committed.

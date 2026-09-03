# ADR 0001 — Divergence from the specification

- **Status**: superseded by [`postgres-runtime-cut.md`](./postgres-runtime-cut.md)
- **Date**: 2026-07-30
- **Supersedes**: nothing
- **Scope**: infrastructure and persistence only. Product content is unaffected.

> **Historical decision.** This ADR explains the former MongoDB/Mongoose
> runtime. It is not current implementation guidance. CrowdSource now serves
> exclusively from PostgreSQL; in current operations, MongoDB is permitted only
> inside the pinned, network-isolated archive recovery reader described by the
> backend runbook.

## Context

`.plan/PLAN.md` is the approved product specification, and it is binding on
**product**: the invariants in `AGENTS.md`, the Case Envelope contract, the case
lifecycle, sortition and consensus, and the privacy model. Its **plumbing**
choices — §12.3's infrastructure, §12.4's environments, §12.7's constraint
mechanism — were written without context on the Oxy ecosystem. Where those
choices conflict with how the ecosystem already runs, the ecosystem wins.

That rule is cheap to state and expensive to apply honestly, because two of the
six divergences below are **not swaps of equivalent mechanisms**. They are
reductions in guarantee, and the guarantee they remove was doing real work in the
plan. This ADR exists to record the cost, not to justify the choice: the choice
is already made and is not being reopened.

## Decision

| Plan § | Plan says | CrowdSource does |
| --- | --- | --- |
| 12.3 | RDS PostgreSQL as system of record | MongoDB + Mongoose, own database inside the shared Oxy instance |
| 12.3 | SQS with dead-letter queues | BullMQ over the existing Valkey (decided; not yet built) |
| 12.3 | S3 + KMS evidence bucket | `cloud.oxy.so` via `oxyServices.getFileDownloadUrl` |
| 12.4 | sandbox + staging + production | production only, like every other Oxy app |
| 12.7 | PostgreSQL Row Level Security | code discipline — the access layer forces the tenant filter |
| 12.7 | relational unique constraints | unique compound indexes |

Everything below is the reasoning and the price.

---

## 1. MongoDB instead of RDS PostgreSQL

**Why.** Every Oxy backend already runs against one MongoDB 8 instance on EC2.
Adding RDS would mean new spend, a second datastore to operate, back up and
patch, and a second set of credentials to rotate — for a service that has no
query the document model cannot serve.

**What it costs.** Three things, and the first two are the two rows further down
this table: PostgreSQL was also going to supply Row Level Security (§5 below) and
declarative constraints (§6 below). Choosing Mongo is what makes those two rows
necessary, so their costs are consequences of this decision rather than
independent ones.

The third cost is specific to sharing an instance. `mongoose.connect(uri,
{ dbName })` hands `dbName` to the driver, which does
`dbName != null ? client.db(dbName) : client.db()` — **the supplied name
overrides the database in the connection URI**. A wrong value therefore does not
fail to connect. It silently reads and writes another Oxy product's live data. So
the database name is a source constant, not configuration
(`packages/backend/src/config/databaseIdentity.ts`), and four things move
together in any change that touches it: that declaration,
`.github/scripts/assert-own-database.sh` (read before a release is built),
`.github/scripts/test-assert-own-database.sh` (which mutation-tests that guard),
and `packages/backend/src/__tests__/databaseIdentity.test.ts` (which asserts the
runtime connection really uses the declared value, so the build guard cannot pass
while the process ignores it).

A dedicated RDS instance would have made this class of mistake impossible rather
than guarded. That is the trade.

## 2. BullMQ instead of SQS — and the outbox that makes it survivable

**Why.** The ecosystem already runs BullMQ on a shared ElastiCache Valkey. SQS
is a new service, new IAM, and a second queue technology in an ecosystem that has
one.

**What it costs, precisely.** SQS is replicated and durable and has dead-letter
queues. What CrowdSource would run on is a **single-node `cache.t4g.micro`
Valkey — no replica, no failover, no snapshots** — shared with six live backends
at `maxmemory-policy=noeviction`. A node replacement (routine AWS maintenance
counts) or an out-of-memory condition loses or refuses queued jobs. The jobs in
question are case ingestion, webhook delivery, consensus recalculation, retention
and reputation effects: every one of them is moderation work that a person is
waiting on.

This is survivable **only because of the outbox**, which is why in CrowdSource
the outbox is load-bearing rather than good practice:

- A domain write and its outbox document commit in **one MongoDB transaction**
  (`packages/backend/src/db/transaction.ts`,
  `packages/backend/src/modules/outbox/outbox.collection.ts`). The dispatcher
  then reads the outbox.
- **Nothing is ever enqueued that is not already recorded in the outbox.** A job
  is a hint that work is pending, never the only evidence it exists. If the queue
  is wiped, every pending job must be re-derivable by re-reading outbox rows.
- A dropped job is therefore a delay. Work enqueued *without* its outbox row is
  lost moderation work with no trace — and it fails silently until the day a node
  is replaced.
- **Nothing in infrastructure enforces this.** It holds by review, exactly like
  the tenant rule in §5 below.
- Transactions require a replica set or a sharded cluster.
  `packages/backend/src/utils/mongoTopology.ts` asserts the topology at boot and
  refuses to start on a standalone, because otherwise the first transactional
  write is where you find out.

**What is actually built today.** No BullMQ. There is no `bullmq` dependency in
`packages/backend/package.json` and no `REDIS_URL` in
`packages/backend/src/config/index.ts`. Dispatch is an in-process poll over the
outbox collection (`packages/backend/src/modules/outbox/outbox.dispatcher.ts`),
started by `server.ts` and never by `app.ts`. Its own header states the
consequence of that ordering: the queue would be a **latency optimisation over
this loop, not a correctness component**, and `runOnce` would be called by a job
handler instead of a timer without a line of the domain changing.

Two properties of that dispatcher are worth recording here because they are the
outbox guarantee made concrete. Only event types with a registered consumer are
claimed, so an event whose consumer does not exist yet stays `pending` instead of
being marked dispatched by a loop that did nothing with it. And a row that
exhausts `OUTBOX_MAX_ATTEMPTS` becomes a dead letter that is **kept**, not
deleted, so an operator can replay it after the cause is fixed.

The remaining obligation when the queue does land: `REDIS_URL` must carry an
explicit non-zero database index, enforced in `deploy-aws.yml`, or two Oxy
backends elect one leader between them and consume each other's jobs. That guard
lives outside this package and is currently absent.

## 3. `cloud.oxy.so` instead of an S3 + KMS evidence bucket

**Why.** Media in this ecosystem has exactly one chokepoint:
`oxyServices.getFileDownloadUrl(id, variant)` plus Bloom's `ImageResolver`,
registered once at the app root. A per-service bucket would be a second URL
authority, a second signing scheme and a second place a host gets hardcoded. The
reviewer app consumes bare file ids and resolves them through that provider
(`packages/reviewer/components/review/ResourceView.tsx`).

**What it costs.** Evidence handling stops being CrowdSource's to control at the
storage layer. The plan wanted a private bucket with SSE-KMS, per-object keys and
a retention lifecycle that CrowdSource owns; what it gets is a shared media
service whose encryption, lifecycle and access logging are the platform's. §13.6
retention and the "record every access to sensitive media" rule in §13.5
therefore have to be implemented in CrowdSource's own domain, against an object
store that will happily keep serving a file after the case is closed.

**Resolved since this ADR was first written, and in the direction of this
divergence.** `9f577343` ("assets carry an Oxy file id, and Uploads is removed")
finished the choice rather than working around it: `AssetRefSchema` now requires a
bare `fileId` (`OxyFileIdSchema`) and `packages/sdk/src/uploads.ts` is deleted, so
there is no upload API to serve and no second URL authority to build. `url` remains
as an optional record of where the material was found — "recorded, never fetched",
which is the SSRF position §7.2.7 asks for. The earlier draft of this ADR recorded
the absent upload route as a gap; that gap is now closed by removal, and what
replaces it is the ecosystem chokepoint this row is about.

**What remains a gap** is the other half, and it is not about uploads: nothing
copies the bytes into storage CrowdSource controls, and nothing verifies a fetched
stream against the declared `sha256` — see the threat model's
"author editing or deleting evidence" row. A file id resolves to whatever
`cloud.oxy.so` currently serves.

**Historical note.** Before `9f577343` the published SDK called
`POST /v1/uploads` and `POST /v1/uploads/{id}/complete` and no route in
`packages/backend/src/app.ts` served either — a published client calling an
endpoint that had never existed. Removing the client half rather than building the
server half is the right resolution given this row's decision, and it is recorded
because the earlier reading ("the upload route is missing") would send somebody to
build the wrong thing.

What exists of the evidence module either way is the content snapshot and its
canonical hash (`packages/backend/src/modules/evidence/contentSnapshot.ts`).
Inline text resources are snapshotted; binary evidence is referenced and never
fetched.

## 4. One environment instead of sandbox + staging + production

**Why.** No other Oxy app runs a staging deployment. Three stacks is three sets
of secrets, three ECS services and three databases to keep in step, for a team
that would test in exactly one of them.

**What it costs.** There is nowhere to rehearse a destructive change. A migration
runner, an index rebuild or a retention sweep gets exercised for the first time
against real cases. This is why `RUN_MIGRATIONS` is `false` until the runner
exists, and why it must be flipped in the same change that adds the runner rather
than in advance.

**What replaces the tenant-facing half.** Sandboxing becomes an
application-trust state inside production, not a separate stack. The envelope
carries `source.environment` with exactly two values, `production` and
`sandbox` — `staging` is deliberately absent
(`packages/contracts/src/case-envelope.ts`).

**Gap.** The state that was supposed to receive that flag does not exist.
§11.13's `ApplicationModerationTrust` — `standing: sandbox | trusted |
restricted`, `globalReputationEffectsAllowed` and the quality signals around them
— has no field anywhere. `ApplicationDocument`
(`packages/backend/src/modules/tenancy/tenancy.collections.ts`) carries
`status: 'active' | 'suspended'` and nothing else. So today a sandbox report is
labelled and then treated identically to a real one.

## 5. Code discipline instead of Row Level Security — the live cost

PostgreSQL RLS would have made tenant isolation a property of the database: a
query that forgot its tenant predicate would return nothing, regardless of which
developer wrote it or which module it lived in. MongoDB has no equivalent.

**So isolation is a property of this codebase and nothing else enforces it.**
That sentence is the entire content of this row, and it is the single most
consequential divergence in this document: the failure mode is one tenant reading
another tenant's moderation cases, and there is no layer underneath the code that
would stop it.

What carries the property instead:

- `packages/backend/src/db/tenantScope.ts` is the boundary, and it holds **two
  separate properties that are worth naming separately** because they have
  different lifespans.

  **One construction path.** A `TenantContext` is built only by
  `createTenantContext`. That is the durable rule: however many ways a caller may
  come to prove which tenant they are, there is exactly one function that turns a
  proof into a context, so there is exactly one place to audit when asking "can a
  caller influence this?".

  **One source of proof — today.** In the tree as it stands, that proof is the
  authenticated service credential and nothing else, because there is no mapping
  from an Oxy user to an organization anywhere in the codebase. This clause is
  narrower than the rule above and is expected to widen; see *In flight* below.

  What neither clause ever permits: a tenant id taken from a body, path, query or
  header. A tenant id the caller can choose is not isolation, it is an IDOR.
- Supplying a tenant key yourself is **rejected with a throw**, not silently
  corrected. The belief that a caller picks the tenant is the bug, and it has to
  surface in a test rather than be quietly fixed in production where the next
  author copies the pattern.
- `packages/backend/src/db/collections.ts` is what makes following the rule the
  path of least resistance. The Mongoose model is a `#private` field; modules
  export the wrapper, not the model. Tenant-owned writes take a restricted update
  spec rather than a raw `UpdateQuery`, because a raw one accepts
  `$set: { applicationId }` and would move a document between tenants — the same
  mass-assignment hole `tenantScopedDocument` closes on insert, reopened on
  update.
- Collections that genuinely cannot be scoped (organizations, applications,
  credentials, the outbox, and the jury collections whose caller presents an Oxy
  session carrying no tenant) are declared through `defineUnscopedCollection` and
  must state **why** in source.
- There is no unscoped read on `cases`, `reports`, `reviews` or `decisions`. That
  absence is a control, not an oversight: it is why a cross-tenant view has to be
  built deliberately rather than assembled by a caller.

What detects a breach: a source scan.
`packages/backend/src/__tests__/collectionBoundary.test.ts` fails the build when a
module outside the access layer reaches the driver, and — because a check that
cannot fail is worse than no check — verifies it detects each escape it claims to
detect and does not mistake a comment about the rule for a breach of it.

**The two allowlists in that mechanism are not guarded equally, and the weaker one
is about to matter.** The set of tenant-exempt collections is pinned exactly
(`expect([...reasons.keys()].sort()).toEqual([…])`), so a new exemption fails the
build. `DRIVER_ACCESS_ALLOWED` in
`packages/backend/src/db/driverEscapes.ts` is **not** pinned: the test only asserts
that the paths already on the list are not flagged, so adding a directory to it
passes every test in the repository. Widening it is a visible edit to source, which
is the property the module's own comment claims — but it is not an asserted set,
and the difference is invisible until somebody relies on it.

**The residual risk is unchanged by any of that.** A test that scans source is a
build-time guard; RLS was a runtime one. A query written in a way the scanner does
not recognise is isolated by nothing. Every authorization defect in this service
must be treated as a critical incident, because there is no second layer that
would have caught it.

### In flight — do not read the above as final

Two changes to the tenancy model are written but **not committed anywhere**. Status,
checked rather than assumed: `origin/main` is `6457cf63` and contains none of it —
`tenantScope.ts` there is still the credential-only version described above, and
`packages/backend/src/modules/trust/crossTenantReads.ts` does not exist on main. The
code lives as **uncommitted working-tree changes** in
`/home/nate/Oxy/CrowdSource-worktrees/phase9-console` (branch `phase9/console`, zero
commits ahead of `978d31ac`, 61 changed paths of which 32 are untracked).

So nothing below is a guard that exists. What it is: a description **verified against
that working tree**, recorded so the sentences above cannot go quietly false and so
that the day it is committed this section becomes a status edit rather than a
rewrite. Anything a reviewer relies on must be re-checked against whatever actually
merges.

**Two sources of proof, still one construction path.** A membership mapping is being
added, because a developer console's whole authorization story is "which organization
does this Oxy user belong to" and there is no such mapping today. After it lands a
`TenantContext` may be derived either from a service credential or from an Oxy
session plus an organization membership — **two sources of proof, one constructor.**
A second constructor is forbidden, and the doc comment in that worktree's
`tenantScope.ts` says so in those terms ("two sources … not two constructors").

The membership path is the one worth reading closely, because at a glance it looks
like the IDOR the first clause forbids and it is not. The caller **does** name an
application id in the path — but the tenant is not taken from it. The application row
is *read* by that id, `organizationId` comes off the **stored row**, and an active
membership of that organization is required first. The caller therefore selects
*which* row to be checked against; it does not supply the tenant. That distinction is
the whole reason the shape is legitimate, and it is the thing to verify has survived
whenever this lands, because it is one refactor away from becoming the bug.

**A privileged cross-tenant read for Trust & Safety.** §4.3 and §10.4 define
Trust & Safety as the audience that sees across tenants, and the tenant collections
deliberately expose no unscoped read (above). The shape being built is
**specific named queries with the projection baked in**, plus scalars-only
aggregation for §16.4's metrics. Two details verified in that worktree:

- The allowlist entry is a **single file**, `src/modules/trust/crossTenantReads.ts`,
  not a directory — so the escape does not widen as the module grows a second file.
- The projection is a declared constant (`ESCALATED_QUEUE_FIELDS`) applied **in the
  Mongo query itself** (`.select(ESCALATED_QUEUE_FIELDS.join(' '))`), not to a
  document already in memory. That is materially stronger than projecting before
  returning: a forbidden field never enters the process, so no later
  `JSON.stringify` of an intermediate value can leak what was never loaded.

A general `findAcrossTenants(filter)` was rejected, and the reason is the part worth
carrying forward:

> A cross-tenant read of `cases` is a **privacy** boundary as much as a tenancy
> one. Case documents carry reported material, and §11 forbids reporter identity,
> juror identity, individual votes and sensitive material from reaching a
> Trust & Safety view. **A filter parameter controls who may call, not what they
> may ask.** So the projection has to be unreachable from the caller — inside the
> named query, not at the screen — or the tenancy control would be satisfied while
> the privacy one was bypassed by an argument.

**`AGENTS.md`'s `Incident` bullet becomes wrong on both halves, not one.** It says
cross-tenant correlation happens "ONLY through `Incident`, in a privileged module
that never returns another tenant's data to an application-API caller."

- *Correlation via `Incident`* remains absent: there is no `Incident` collection or
  module, and `cases.incidentId` is `null` on every document.
- *Cross-tenant reading* will also happen through the named-query module, so "ONLY
  through `Incident`" stops being true of reading even while staying true of
  correlation.
- "never to an **application-API** caller" is the wrong axis entirely. The new module
  returns cross-tenant data to a **staff session** caller, which is correct and which
  that sentence does not describe at all. Rewriting it to name the caller class it
  actually constrains is the fix; tightening the `Incident` half is not.

**Also owed when this lands.** Three unique indexes belong in §6's list and are not
there yet: `organizationId + oxyUserId` on the membership collection,
`applicationId + day` on the usage counter, and `oxyUserId` on
`trust_safety_staff`. The first is the one with teeth: without it two concurrent
invitations give one person two role rows, and every later permission check answers
whichever Mongo returns first — which presents as an intermittent authorization bug,
not as a duplicate.

## 6. Unique compound indexes instead of relational constraints

**Why.** A direct translation. Mongo expresses the same uniqueness, and the plan
listed these as constraints because it assumed a relational store.

**What it costs.** Two things. Index creation is application code
(`ensureIndexes` in `packages/backend/src/db/collections.ts`) rather than a
schema migration, so a deployment whose indexes were never built **accepts
duplicate reports, duplicate reviews and duplicate reputation effects while
reporting perfect health**. That is why index creation is part of starting up
rather than an operational afterthought, and why `createIndexes` is used rather
than `syncIndexes` — the latter also drops anything absent from the current
schema, which on a rolling deploy means the previous task version loses an index
the new one has not finished building.

The second cost is that Mongo cannot express a foreign key. Nothing in the
database refuses a review whose `caseId` names no case; that is a property of the
services that write them.

The indexes, each of which is what makes a retry safe rather than duplicating
something:

| Index | What it protects |
| --- | --- |
| `applicationId + externalReportId` | a report is delivered once |
| `applicationId + idempotencyKey` | a retry returns the same `reportId` |
| `applicationId + externalSubjectId + contentHash + policyVersion` | the case dedup key — one incident, one case |
| `caseId + reviewerId + decisionRevision` | one review per juror per revision |
| `webhookEndpointId + eventId` | one logical delivery, many attempts |
| `incidentId + principalId + effectType + decisionRevision` | one reputation effect per incident and revision |

## Consequences

1. **Divergence 5 is the one that can become a data breach**, and only review
   enforces it. Every new module that touches tenant-owned data is a review
   against `tenantScope.ts`, not a style question. The two changes in flight are
   both in that category: a second source of tenant proof, and the first
   deliberate cross-tenant read. Each widens the surface that only review guards,
   which is the argument for pinning `DRIVER_ACCESS_ALLOWED` the way the
   tenant-exempt collection set is already pinned.
2. **Divergence 2 is the one that can silently lose moderation work.** Enqueuing
   without an outbox row fails only when a Valkey node is replaced, and then
   there is no trace of what was lost.
3. The boot-time topology assertion means the shared production MongoDB **must**
   be a replica set or a sharded cluster. If it is a standalone the first deploy
   crash-loops — by design, since the alternative is discovering it at the first
   outbox write. Verify with `mongosh --eval 'rs.status().set'` before the first
   rollout.
4. Applying the same rule beyond this table: anything the ecosystem already
   solves once — session handling, device-first cold boot, media resolution — is
   consumed from the shared SDK and never reimplemented here, and a bug in
   `@oxyhq/*` or Bloom is fixed upstream rather than patched locally.

## Gaps recorded by this ADR

- BullMQ is decided and unbuilt; there is no queue, no `REDIS_URL`, and no
  shared-Valkey database-index guard in `deploy-aws.yml`.
- ~~There is no evidence-upload route, though the published SDK calls one.~~
  **Closed by `9f577343`**: uploads were removed from the contract and the SDK, and
  an asset is now a bare Oxy `fileId`. The remaining evidence gap is the asset copy
  and hash verification, not the route — see §3.
- §11.13 application trust standing does not exist, so the `sandbox` source
  environment currently changes nothing about how a report is handled.
- The three-environment model's absence means no migration has ever been
  rehearsed anywhere; `RUN_MIGRATIONS` is `false` and the runner does not exist.
- `DRIVER_ACCESS_ALLOWED` is not pinned to an exact set by any test, unlike
  `unscopedCollectionReasons()`. Adding a directory to it passes the whole suite.
- There is no `Incident` collection or module, so `AGENTS.md`'s "cross-tenant
  correlation happens ONLY through `Incident`" describes a chokepoint that does not
  exist. `cases.incidentId` is a field that is `null` on every document, and the
  `incidentId + principalId + effectType + decisionRevision` index has nothing to
  be built on.
- There is no mapping from an Oxy user to an organization, so the tenant a
  `TenantContext` can be derived from is today the credential's and only the
  credential's. Both of these are being changed — see *In flight* in §5.

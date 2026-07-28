# @crowdsource/backend

CrowdSource's Express service — the modular monolith that will own tenancy,
ingestion, evidence, cases, sortition, review, consensus, decisions, webhook
delivery and the Oxy Trust reputation bridge.

Built so far: **tenancy** (organizations, applications, service credentials,
scopes), **service-credential authentication and tenant context**, the
**ingestion** write path for `POST /v1/reports` with its idempotency indexes, and
the **transactional outbox** row every domain write commits alongside. Evidence,
cases, policy registry, triage, sortition, review, consensus, decision, webhook
delivery and the reputation bridge are not written; modules mount in `src/app.ts`
as they are built.

Two things are deliberately absent rather than stubbed. Full **Case Envelope
validation** (§7.2 steps 2-7) belongs to `@oxyhq/crowdsource-contracts`;
ingestion validates the request and stores the envelope without pretending to
have checked a schema it has never seen. The **outbox dispatcher** is not built
either, so rows accumulate as `pending` — which is the safe direction: the row is
the durable record, and the queue that will read it is only a dispatch hint.

## Surfaces

| Method | Route | Auth | Scope |
| --- | --- | --- | --- |
| GET | `/health/live`, `/health/ready` | none | — |
| POST | `/v1/reports` | service credential | `crowdsource:reports:write` |
| GET | `/v1/reports/{reportId}` | service credential | `crowdsource:reports:read` |

Creating organizations, applications and credentials is a **domain service**
(`src/modules/tenancy/provisioning.service.ts`), not an HTTP surface. The
Developer Console (§4.2) is what will call it, and shipping routes for it before
the console exists would mean unauthenticated tenant creation in production.

## Structure

- `server.ts` — process bootstrap: connect, listen, drain, exit. The only file
  with process-level state. It connects to MongoDB *before* listening, so a task
  never accepts traffic it cannot serve.
- `src/app.ts` — builds the HTTP application. Opens no connections and starts no
  timers, so tests exercise it without a runtime.
- `src/config/index.ts` — the whole environment contract, validated at import.
- `src/config/databaseIdentity.ts` — declares the database this service uses.
  Source, not configuration: Mongoose applies `dbName` over the database named
  in `MONGODB_URI`, so this constant — not the connection string — decides what
  a release touches. Read by `.github/scripts/assert-own-database.sh` before a
  release is built.
- `src/db/tenantScope.ts` — the tenant isolation boundary. Mongo has no Row
  Level Security, so isolation holds only while every tenant-owned query goes
  through here.
- `src/db/collections.ts` — the only way this service reaches a collection.
  Declares tenant-owned collections (every read and write takes a
  `TenantContext`) and the few that cannot be scoped by the tenant because they
  define it, each of which states its reason in source.
- `src/db/driverEscapes.ts` + `src/__tests__/collectionBoundary.test.ts` — the
  gate on the above. Nothing in Mongo stops a query that forgets its tenant
  filter, so the build fails when a module outside `src/db` reaches the driver.
- `src/db/transaction.ts` — transactions, and the duplicate-key classification
  that lets idempotency be a unique index instead of a racy read-then-write.
- `src/http/` — the §10.5 error convention and the one place a failure becomes a
  response.
- `src/modules/` — the modular monolith. `tenancy` owns the tenant and where
  `applicationId` comes from; `ingestion` owns the report write path; `outbox`
  owns the durable event row.
- `src/utils/database.ts` — connection, retry and drain.
- `src/routes/health.routes.ts` — liveness and readiness, kept separate so a
  draining task, or one that lost its database, fails readiness while still
  answering liveness.

## Local development

```bash
cp .env.example .env
bun run dev
```

CrowdSource uses its **own database inside the Mongo instance you already run**
for the other Oxy apps — the same arrangement as production, where separation
comes from `dbName`, not from a separate server. There is deliberately no
`docker-compose.yml` starting a second Mongo: it would fight for port 27017 with
the one already running and model a topology production does not have.

The instance must be a **replica set**. Multi-document transactions need one and
the outbox pattern depends on them, so a standalone `mongod` works until the
first outbox write and then fails in a way that looks like a code bug. Check
with `mongosh --eval 'rs.status().set'`. If you have no Mongo at all:

```bash
docker run -d --name oxy-mongo -p 27017:27017 mongo:8 --replSet rs0 --bind_ip_all
docker exec oxy-mongo mongosh --quiet --eval 'rs.initiate()'
```

## Commands

```bash
bun run dev      # watch mode
bun run build    # tsc -> dist/ (this is what the ECS image runs)
bun run lint     # tsc --noEmit
bun run test     # vitest
```

The suite starts a **disposable MongoDB replica set** (`mongodb-memory-server`,
a devDependency) rather than using the local one, and the integration tests run
against it — a mocked driver can be made to agree with any claim about a unique
index or a transaction, which is exactly why it must not be what those claims are
tested against. `src/__tests__/support/tenants.ts` refuses to run if that replica
set did not start, so a suite that silently fell back to a developer's local Mongo
fails instead of passing against the wrong server.

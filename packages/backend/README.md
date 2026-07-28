# @crowdsource/backend

CrowdSource's Express service — the modular monolith that will own tenancy,
ingestion, evidence, cases, sortition, review, consensus, decisions, webhook
delivery and the Oxy Trust reputation bridge.

Today it is a skeleton: it validates its configuration, serves health endpoints
and nothing else. Modules mount in `src/app.ts` as they are built.

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

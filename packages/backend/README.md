# `@crowdsource/backend`

CrowdSource's private Express service: tenancy, report ingestion, cases,
sortition, review, consensus, decisions, appeals, webhooks, reviewer state and
the developer/Trust & Safety console APIs.

PostgreSQL is its only datastore.

## Runtime structure

- `server.ts` owns the PostgreSQL reachability check, listener, workers, drain
  and process handlers. It reaches the database before accepting traffic.
- `src/app.ts` builds the HTTP app and opens no connections or timers.
- `src/config/index.ts` validates the runtime contract. `DATABASE_URL` is the
  application-role connection; it is required to boot.
- `src/db/postgres/database.ts` owns the one pooled application handle.
- `src/db/postgres/withTenant.ts` installs tenant parameters with `SET LOCAL`.
- `src/db/postgres/repositories/` contains explicit Drizzle repositories,
  transactional claims and the cross-module storage operations.
- `src/db/postgres/schema/` and `migrations/` are the schema and its only journal.
- `src/db/collections.ts` is a typed compatibility adapter over 26 explicit
  domain/table bindings. It never derives a table from a model name.
- `src/db/transaction.ts` provides PostgreSQL transaction retry and SQLSTATE /
  constraint classification.
- `src/routes/health.routes.ts` separates liveness from PostgreSQL-backed
  readiness.

Tenant-owned tables use enabled and forced PostgreSQL RLS. The serving role owns
no tables. Cross-tenant Trust & Safety reads enumerate applications and enter
each tenant explicitly; they do not use a superuser, `BYPASSRLS`, security
definers or the migrator credential.

Domain writes and their outbox rows commit in one PostgreSQL transaction. Outbox
and webhook workers claim rows atomically with leases; a queue is never the only
record of pending work. Closed domain vocabularies have one shared source tuple
and named PostgreSQL CHECK constraints; the port ledger has no remaining
column-backed validation gap.

## Database roles and migrations

Use two separate credentials:

- `DATABASE_URL` -> `crowdsource_app`, the serving role subject to forced RLS;
- `MIGRATOR_DATABASE_URL` -> `crowdsource_migrator`, the table owner used only by
  `scripts/migrate.ts`.

The migrator refuses to fall back to the application credential and requires an
exact `--target-database=<name>` guard. The serving task definition must never
carry `MIGRATOR_DATABASE_URL`.

```bash
MIGRATOR_DATABASE_URL='postgres://…' \
  bun scripts/migrate.ts --target-database=crowdsource --phase=pre
```

`crowdsource_migrator` owns the database and therefore reaches the `public`
schema through PostgreSQL's `pg_database_owner` pseudo-role; do not add a
redundant direct `CREATE`/`USAGE` schema grant to it. `crowdsource_app` owns
nothing, has an explicit `USAGE` grant on `public`, receives DML through the
migrator's default privileges, and is subject to forced RLS.

Do not use example names or URLs as production values. Provisioning is an
operator action.

## Local development

Start the disposable PostgreSQL server from the repository root:

```bash
docker compose -f docker-compose.postgres.yml up -d --wait postgres
export CROWDSOURCE_BACKEND_TEST_POSTGRES_URL='postgres://crowdsource:crowdsource@127.0.0.1:5436/postgres'
export DATABASE_URL="$CROWDSOURCE_BACKEND_TEST_POSTGRES_URL"
bun run --cwd packages/backend dev
```

The test harness creates a uniquely named database plus exact non-superuser app
and migrator roles for each run, applies the journal, and drops that disposable
database afterwards. It refuses to run without
`CROWDSOURCE_BACKEND_TEST_POSTGRES_URL`; it never falls back to a developer or
production database.

## Commands

```bash
bun run --cwd packages/backend build
bun run --cwd packages/backend lint
bun run --cwd packages/backend test
```

The backend Vitest suite exercises RLS, constraints, transactions and claim
races against real PostgreSQL.

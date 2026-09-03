# PostgreSQL runtime cut

This records repository state, not production state.

As of the PostgreSQL-only backend change, `@crowdsource/backend`:

- boots, checks readiness and shuts down through one PostgreSQL pool;
- requires `DATABASE_URL` and has no Mongo runtime configuration;
- stores all 26 former document domains in 27 explicit Drizzle tables (reviewer
  principal links are normalized into their own table and use their exact
  three-field source tuple as the primary key, with no invented id);
- executes tenant-owned work through `withTenant` / `withTenantTransaction`, with
  PostgreSQL RLS enabled and forced on the scoped tables;
- commits domain rows and unscoped outbox rows in the same PostgreSQL transaction;
- claims outbox and webhook work with atomic PostgreSQL updates and leases;
- enforces all 38 column-backed members of the 41-value-set port ledger with
  named PostgreSQL CHECKs (the other three live inside JSONB snapshots);
- has no `mongoose` or `mongodb-memory-server` dependency and no Mongo deploy secret;
- runs its integration suite against disposable, non-superuser PostgreSQL roles.

The runtime cut does **not** prove a production data cutover. No source database
was inspected or modified by this repository work. Production remains blocked
until an authorised maintenance window performs the backend runbook's
freeze/export/import/re-export reconciliation against a separately named, empty
target and verifies the exact deployed artifact. A fresh target must apply the
whole journal under that freeze; the ordinary rolling `pre -> deploy -> post`
sequence cannot cross the historical post-before-later-pre high-water mark.

## Repository gates

The cut is guarded by:

1. `postgresOnlyRuntime.test.ts`, which scans executable source, manifests,
   environment templates and deployment wiring for Mongo imports, URIs,
   dependencies and secrets;
2. `postgresTableBoundary.realdb.test.ts`, which requires every Drizzle table to
   be explicitly RLS-scoped or explicitly exempt and verifies the live catalogue;
3. `scopedRepositoryBoundary.test.ts`, which requires the branded
   `TenantScopedHandle` in every scoped repository;
4. real PostgreSQL tests for isolation, deduplication races, immutable decisions,
   leases, retries, domain/outbox rollback atomicity, the complete closed-value
   ledger, and the natural reviewer principal-link key;
5. `verify-backend-cutover-manifest.mjs` and the cutover tool tests, which fix
   the 26-to-27 dataset map and mutation-prove the signed freeze, non-empty
   source, empty target, phase, IDs/relationships and count/content/identity
   evidence; a dedicated CI entry repeats import/re-export against real
   PostgreSQL.

Historical design documents under `docs/superpowers/` intentionally retain the
old state they proposed or measured. They are evidence, not current operations.

-- oxy:deploy-phase=pre
--
-- Additive only: one CREATE TABLE, its indexes, and the row-security DDL that
-- makes the table readable at all. Nothing is dropped, renamed or narrowed, so
-- this is safe to apply while the previous image is still serving traffic.
--
-- REGENERATION WARNING. Everything below the `statement-breakpoint` after the
-- indexes is HAND-WRITTEN: drizzle-kit cannot model row-level security, so it
-- cannot round-trip it either. `bun run db:generate` will emit only the table and
-- the two indexes and this block will be gone. Re-apply it, then read the
-- regenerated file for statements you did not intend — a regeneration against a
-- stale build of a sibling package silently reverts constraints in a diff that
-- looks entirely plausible.
--
-- PROVISIONING DEPENDENCY. `crowdsource_migrator` and `crowdsource_app` must
-- already exist, with the migrator holding CREATE on the schema and default
-- privileges granting the application role DML on tables it creates. That is
-- oxy-infra runbook 30 §2A, not this migration's job: roles are cluster objects
-- shared with every other database on the instance, and a migration that created
-- them would be a migration that needs privileges no application role should
-- hold. Applying this against a database provisioned the single-role way fails
-- loudly on the policy below, which is the correct outcome — the alternative is a
-- table whose isolation silently does nothing.

CREATE TABLE "cases" (
	"case_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"application_id" text NOT NULL,
	"subject_external_id" text NOT NULL,
	"status" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cases_application_subject_key" ON "cases" USING btree ("application_id","subject_external_id");--> statement-breakpoint
CREATE INDEX "cases_tenant_status_idx" ON "cases" USING btree ("organization_id","application_id","status");--> statement-breakpoint

-- Row-level security. Hand-written; see the header before regenerating.
--
-- ENABLE alone is INERT for the table's owner — measured on PostgreSQL 17: the
-- DDL succeeds, `pg_policies` lists the policy, and every tenant's rows stay
-- visible. FORCE is what makes the feature do anything, and it is stated here
-- rather than left to the role split so the boundary survives the table being
-- reassigned to another owner later.
ALTER TABLE "cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- BOTH keys. An organization routinely owns several applications, so a predicate
-- on `organization_id` alone isolates two customers from each other and NOT one
-- customer's staging product from its production one. Measured: under an
-- org-only predicate, a sibling application's rows are returned.
--
-- `WITH CHECK` repeats `USING` rather than being omitted. With no `WITH CHECK`,
-- Postgres applies `USING` to the write path too, so this closes no gap that is
-- open today — it is here so that a later narrowing of the read predicate cannot
-- silently widen the write one.
--
-- `current_setting(…, true)` returns NULL when the parameter is unset, so an
-- unset context matches nothing and the table reads empty. Fail-closed, measured.
CREATE POLICY "tenant_isolation" ON "cases"
	FOR ALL
	USING (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	)
	WITH CHECK (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	);--> statement-breakpoint

-- The migrator's own access, and why a forced table needs it.
--
-- Under FORCE the owner is bound by the policy above, and the verbs fail
-- DIFFERENTLY — measured with no tenant parameters set: INSERT errors loudly,
-- while SELECT, UPDATE and DELETE all answer 0 with no error at all. So a
-- data-bearing migration touches nothing, exits zero, and is recorded in the
-- ledger as applied. The loud one is harmless; the silent ones are not.
--
-- This grants the migrator nothing it lacked — it owns the table and could
-- always DROP POLICY. What changes is that the capability is visible in
-- `pg_policies` rather than implicit in ownership. Scoped `TO` one role, so it
-- does not widen any other: measured, the application role reading immediately
-- afterwards in the same database still sees exactly its own tenant's rows.
CREATE POLICY "migrator_full_access" ON "cases"
	FOR ALL
	TO "crowdsource_migrator"
	USING (true)
	WITH CHECK (true);

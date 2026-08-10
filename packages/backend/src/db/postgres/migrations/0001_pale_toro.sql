-- oxy:deploy-phase=pre
--
-- Additive only: ten CREATE TABLEs, their indexes, and the row-security DDL that
-- makes each one readable. Nothing is dropped, renamed or narrowed, so this is
-- safe to apply while the previous image is still serving traffic.
--
-- REGENERATION WARNING. Everything below the generated statements is
-- HAND-MAINTAINED: drizzle-kit cannot model row-level security, so a
-- `bun run db:generate` emits only the tables and indexes and this block is
-- gone. Re-apply it and then read the regenerated file for statements you did
-- not intend.
--
-- PROVISIONING DEPENDENCY. `crowdsource_migrator` and `crowdsource_app` must
-- already exist, with the migrator OWNING the database and default privileges
-- granting the application role DML on tables it creates — oxy-infra runbook 30
-- §2A. Ownership rather than a schema grant is load-bearing: `@oxyhq/db`'s
-- ledger lives in its own `drizzle` schema, and `CREATE SCHEMA` needs CREATE on
-- the DATABASE, so a schema-only grant fails before any table exists.

CREATE TABLE "appeals" (
	"appeal_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"application_id" text NOT NULL,
	"case_id" text NOT NULL,
	"superseded_revision" integer NOT NULL,
	"superseded_decision_id" text NOT NULL,
	"opened_revision" integer NOT NULL,
	"reason" text NOT NULL,
	"appellant_external_principal_id" text NOT NULL,
	"author_context" jsonb,
	"previous_required_votes" integer NOT NULL,
	"severe_action" boolean NOT NULL,
	"required_agreeing_votes" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"filed_at" timestamp with time zone NOT NULL,
	"filed_by_credential_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"decision_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"application_id" text NOT NULL,
	"case_id" text NOT NULL,
	"revision" integer NOT NULL,
	"status" text NOT NULL,
	"outcome" text NOT NULL,
	"context_sufficiency" text NOT NULL,
	"confidence" double precision NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recommended_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"jury_size" integer NOT NULL,
	"jury_decisive_votes" integer NOT NULL,
	"jury_winning_votes" integer NOT NULL,
	"jury_agreement" double precision NOT NULL,
	"jury_specialist_present" boolean NOT NULL,
	"policy_version_taxonomy" text NOT NULL,
	"policy_version_application" text NOT NULL,
	"policy_version_oxy_conduct" text NOT NULL,
	"supersedes_decision_id" text,
	"agreeing_reviewer_ids" text[] DEFAULT '{}' NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"audit_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"application_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_credential_id" text,
	"actor_oxy_user_id" text,
	"report_id" text,
	"case_id" text,
	"external_report_id" text,
	"reason" text,
	"subject_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_sets" (
	"organization_id" text NOT NULL,
	"application_id" text NOT NULL,
	"policy_set_id" text NOT NULL,
	"version" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"locale" text,
	"rules" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"organization_id" text NOT NULL,
	"application_id" text NOT NULL,
	"day" text NOT NULL,
	"reports_received" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_reports" (
	"organization_id" text NOT NULL,
	"application_id" text NOT NULL,
	"case_id" text NOT NULL,
	"report_id" text NOT NULL,
	"external_report_id" text NOT NULL,
	"allegation_codes" text[] DEFAULT '{}' NOT NULL,
	"merged" boolean DEFAULT false NOT NULL,
	"linked_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"report_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"application_id" text NOT NULL,
	"external_report_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"case_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_attempts" (
	"attempt_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"application_id" text NOT NULL,
	"delivery_id" text NOT NULL,
	"webhook_endpoint_id" text NOT NULL,
	"event_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"outcome" text NOT NULL,
	"response_status" integer,
	"failure_kind" text,
	"latency_ms" integer NOT NULL,
	"response_body_preview" text DEFAULT '' NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"secret_version" integer,
	"attempted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"webhook_endpoint_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"application_id" text NOT NULL,
	"url" text NOT NULL,
	"event_types" text[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"disabled_reason" text,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_secrets" (
	"organization_id" text NOT NULL,
	"application_id" text NOT NULL,
	"webhook_endpoint_id" text NOT NULL,
	"version" integer NOT NULL,
	"algorithm" text NOT NULL,
	"key_fingerprint" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"activates_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "appeals_application_case_revision_key" ON "appeals" USING btree ("application_id","case_id","superseded_revision");--> statement-breakpoint
CREATE UNIQUE INDEX "appeals_application_idempotency_key" ON "appeals" USING btree ("application_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "appeals_application_case_opened_idx" ON "appeals" USING btree ("application_id","case_id","opened_revision");--> statement-breakpoint
CREATE UNIQUE INDEX "decisions_case_revision_key" ON "decisions" USING btree ("case_id","revision");--> statement-breakpoint
CREATE INDEX "decisions_application_case_revision_idx" ON "decisions" USING btree ("application_id","case_id","revision" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_application_occurred_idx" ON "audit_events" USING btree ("application_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_application_case_occurred_idx" ON "audit_events" USING btree ("application_id","case_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "policy_sets_application_set_version_key" ON "policy_sets" USING btree ("application_id","policy_set_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_counters_application_day_key" ON "usage_counters" USING btree ("application_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "case_reports_application_report_key" ON "case_reports" USING btree ("application_id","report_id");--> statement-breakpoint
CREATE INDEX "case_reports_application_case_idx" ON "case_reports" USING btree ("application_id","case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_application_external_key" ON "reports" USING btree ("application_id","external_report_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_application_idempotency_key" ON "reports" USING btree ("application_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_attempts_delivery_attempt_key" ON "webhook_attempts" USING btree ("delivery_id","attempt_number");--> statement-breakpoint
CREATE INDEX "webhook_attempts_application_attempted_idx" ON "webhook_attempts" USING btree ("application_id","attempted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "webhook_attempts_attempted_at_idx" ON "webhook_attempts" USING btree ("attempted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_endpoints_application_url_key" ON "webhook_endpoints" USING btree ("application_id","url");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_event_types_idx" ON "webhook_endpoints" USING gin ("event_types");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_application_status_idx" ON "webhook_endpoints" USING btree ("application_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_secrets_endpoint_version_key" ON "webhook_secrets" USING btree ("application_id","webhook_endpoint_id","version");--> statement-breakpoint
CREATE INDEX "webhook_secrets_endpoint_activates_idx" ON "webhook_secrets" USING btree ("application_id","webhook_endpoint_id","activates_at" DESC NULLS LAST);--> statement-breakpoint

-- Row-level security, one block per tenant-owned table. Hand-maintained; see the
-- header before regenerating.
--
-- Three facts, each measured against a real PostgreSQL 17 rather than taken from
-- documentation, decide the shape and are stated once here rather than ten times:
--
--   * ENABLE alone is INERT for a table's owner — the DDL succeeds, pg_policies
--     lists the policy, every tenant's rows stay visible. FORCE is what makes it
--     do anything, and it is applied even though the application role is a
--     non-owner (and therefore already bound), so the boundary survives a table
--     being reassigned to another owner later.
--   * BOTH keys are in the predicate. One organization routinely owns several
--     applications, so an organization-only predicate isolates two customers and
--     NOT one customer's staging product from its production one.
--   * Under FORCE the MIGRATOR is bound too, and the verbs fail differently:
--     INSERT errors, while SELECT, UPDATE and DELETE answer 0 with no error — so
--     a data-bearing migration touches nothing and is recorded as applied.
--     migrator_full_access closes that, and grants the migrator nothing that
--     owning the table did not already give it.

ALTER TABLE "reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reports" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "reports"
	FOR ALL
	USING (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	)
	WITH CHECK (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	);--> statement-breakpoint
CREATE POLICY "migrator_full_access" ON "reports"
	FOR ALL
	TO "crowdsource_migrator"
	USING (true)
	WITH CHECK (true);--> statement-breakpoint

ALTER TABLE "case_reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_reports" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "case_reports"
	FOR ALL
	USING (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	)
	WITH CHECK (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	);--> statement-breakpoint
CREATE POLICY "migrator_full_access" ON "case_reports"
	FOR ALL
	TO "crowdsource_migrator"
	USING (true)
	WITH CHECK (true);--> statement-breakpoint

ALTER TABLE "policy_sets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "policy_sets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "policy_sets"
	FOR ALL
	USING (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	)
	WITH CHECK (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	);--> statement-breakpoint
CREATE POLICY "migrator_full_access" ON "policy_sets"
	FOR ALL
	TO "crowdsource_migrator"
	USING (true)
	WITH CHECK (true);--> statement-breakpoint

ALTER TABLE "decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "decisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "decisions"
	FOR ALL
	USING (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	)
	WITH CHECK (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	);--> statement-breakpoint
CREATE POLICY "migrator_full_access" ON "decisions"
	FOR ALL
	TO "crowdsource_migrator"
	USING (true)
	WITH CHECK (true);--> statement-breakpoint

ALTER TABLE "appeals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "appeals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "appeals"
	FOR ALL
	USING (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	)
	WITH CHECK (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	);--> statement-breakpoint
CREATE POLICY "migrator_full_access" ON "appeals"
	FOR ALL
	TO "crowdsource_migrator"
	USING (true)
	WITH CHECK (true);--> statement-breakpoint

ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_events"
	FOR ALL
	USING (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	)
	WITH CHECK (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	);--> statement-breakpoint
CREATE POLICY "migrator_full_access" ON "audit_events"
	FOR ALL
	TO "crowdsource_migrator"
	USING (true)
	WITH CHECK (true);--> statement-breakpoint

ALTER TABLE "usage_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "usage_counters" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "usage_counters"
	FOR ALL
	USING (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	)
	WITH CHECK (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	);--> statement-breakpoint
CREATE POLICY "migrator_full_access" ON "usage_counters"
	FOR ALL
	TO "crowdsource_migrator"
	USING (true)
	WITH CHECK (true);--> statement-breakpoint

ALTER TABLE "webhook_endpoints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "webhook_endpoints"
	FOR ALL
	USING (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	)
	WITH CHECK (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	);--> statement-breakpoint
CREATE POLICY "migrator_full_access" ON "webhook_endpoints"
	FOR ALL
	TO "crowdsource_migrator"
	USING (true)
	WITH CHECK (true);--> statement-breakpoint

ALTER TABLE "webhook_secrets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_secrets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "webhook_secrets"
	FOR ALL
	USING (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	)
	WITH CHECK (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	);--> statement-breakpoint
CREATE POLICY "migrator_full_access" ON "webhook_secrets"
	FOR ALL
	TO "crowdsource_migrator"
	USING (true)
	WITH CHECK (true);--> statement-breakpoint

ALTER TABLE "webhook_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_attempts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "webhook_attempts"
	FOR ALL
	USING (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	)
	WITH CHECK (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	);--> statement-breakpoint
CREATE POLICY "migrator_full_access" ON "webhook_attempts"
	FOR ALL
	TO "crowdsource_migrator"
	USING (true)
	WITH CHECK (true);

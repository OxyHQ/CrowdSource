-- oxy:deploy-phase=pre
--
-- Additive only: sixteen CREATE TABLEs and their indexes. Nothing is dropped,
-- renamed or narrowed, so this is safe to apply while the previous image is
-- still serving traffic. Nothing reads these tables yet — the batch is inert,
-- and Mongo remains the authority for every one of them.
--
-- THE ABSENCE OF ROW-SECURITY DDL IS A DECISION, NOT AN OMISSION. Every table
-- here is registered in `db/postgres/tableRegistry.ts` under one of four
-- exemption kinds, and `postgresTableBoundary.realdb.test.ts` fails the build
-- for any table that is in neither list. Do NOT "fix" this file by adding
-- ENABLE/FORCE ROW LEVEL SECURITY and a `tenant_isolation` policy to the tables
-- that carry `organization_id` and `application_id` — eleven of the sixteen do,
-- and a policy would break each of them differently:
--
--   * `applications`, `application_credentials`, `organization_members`,
--     `organizations` DEFINE the tenant. The runtime parameters a policy reads
--     are not set until AFTER the read that would be filtered by them, so the
--     policy is circular and the service could not authenticate anybody.
--   * `assignments`, `sortition_draws`, `reviews`, `outbox_events`,
--     `webhook_deliveries` are tenant-STAMPED but read by a caller who holds an
--     Oxy session and can never set those parameters — a reviewer belongs to no
--     tenant, and a dispatcher claims across all of them.
--   * `app_trust_snapshots`, `staff_audit_events`, `reviewer_relations`,
--     `reviewer_principal_links` NAME a tenant without belonging to one.
--
-- REGENERATION WARNING. This header is HAND-MAINTAINED: `bun run db:generate`
-- emits only the tables and indexes and this block is gone. Re-apply it, keep
-- exactly ONE `-- oxy:deploy-phase=` line, and read the regenerated file for
-- statements you did not intend.

CREATE TABLE "organization_members" (
	"membership_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"roles" text[] NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_audit_events" (
	"staff_audit_id" text PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"actor_oxy_user_id" text NOT NULL,
	"roles" text[] NOT NULL,
	"application_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trust_safety_staff" (
	"oxy_user_id" text PRIMARY KEY NOT NULL,
	"roles" text[] NOT NULL,
	"status" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_trust_snapshots" (
	"application_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"standing" text NOT NULL,
	"global_reputation_effects_allowed" boolean NOT NULL,
	"evidence_integrity" double precision,
	"identity_binding_reliability" double precision,
	"policy_quality" double precision,
	"last_standing_reason" text NOT NULL,
	"standing_changed_at" timestamp with time zone,
	"standing_changed_by_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"application_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text NOT NULL,
	"attempts" integer NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"dispatched_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviewer_affinities" (
	"pair_key" text PRIMARY KEY NOT NULL,
	"reviewer_id_a" text NOT NULL,
	"reviewer_id_b" text NOT NULL,
	"co_served_count" integer NOT NULL,
	"last_served_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviewer_principal_links" (
	"reviewer_principal_link_id" text PRIMARY KEY NOT NULL,
	"reviewer_id" text NOT NULL,
	"application_id" text NOT NULL,
	"external_principal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviewer_profiles" (
	"reviewer_id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"state" text NOT NULL,
	"account_active" boolean NOT NULL,
	"oxy_account_verified" boolean NOT NULL,
	"is_adult" boolean NOT NULL,
	"suspected_sock_puppet" boolean NOT NULL,
	"risk_cluster_id" text,
	"languages" text[] NOT NULL,
	"categories" text[] NOT NULL,
	"specialist_categories" text[] NOT NULL,
	"max_sensitivity_rank" integer NOT NULL,
	"consented_sensitive_categories" text[] NOT NULL,
	"declared_conflict_applications" text[] NOT NULL,
	"rules_accepted_at" timestamp with time zone,
	"available" boolean NOT NULL,
	"daily_review_limit" integer NOT NULL,
	"training_completed_modules" text[] NOT NULL,
	"training_completed_at" timestamp with time zone,
	"calibration_passed_at" timestamp with time zone,
	"calibration_score" double precision,
	"calibration_attempts" integer NOT NULL,
	"last_calibration_at" timestamp with time zone,
	"reliability_by_category" jsonb NOT NULL,
	"completed_review_count" integer NOT NULL,
	"personhood_confidence" double precision NOT NULL,
	"sampling_key" double precision NOT NULL,
	"suspended_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviewer_relations" (
	"reviewer_relation_id" text PRIMARY KEY NOT NULL,
	"reviewer_id" text NOT NULL,
	"application_id" text NOT NULL,
	"external_principal_id" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignments" (
	"assignment_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"application_id" text NOT NULL,
	"case_id" text NOT NULL,
	"case_revision" integer NOT NULL,
	"draw_id" text NOT NULL,
	"incident_id" text,
	"reviewer_id" text NOT NULL,
	"slot_type" text NOT NULL,
	"filled_as" text NOT NULL,
	"status" text NOT NULL,
	"token_hash" text NOT NULL,
	"sensitivity_class" text NOT NULL,
	"offered_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"recusal_reason" text,
	"replacement_assignment_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"review_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"application_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"case_id" text NOT NULL,
	"case_revision" integer NOT NULL,
	"reviewer_id" text NOT NULL,
	"outcome" text NOT NULL,
	"context_sufficiency" text NOT NULL,
	"findings" jsonb NOT NULL,
	"recommended_actions" text[] NOT NULL,
	"notes" text,
	"submitted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sortition_draws" (
	"draw_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"application_id" text NOT NULL,
	"case_id" text NOT NULL,
	"case_revision" integer NOT NULL,
	"pool" text NOT NULL,
	"round" integer NOT NULL,
	"kind" text NOT NULL,
	"panel_spec_id" text NOT NULL,
	"rules_version" text NOT NULL,
	"seed" text NOT NULL,
	"requested_slots" text[] NOT NULL,
	"candidate_snapshot" jsonb NOT NULL,
	"rejections" jsonb NOT NULL,
	"selected" jsonb NOT NULL,
	"sampled_count" integer NOT NULL,
	"eligible_count" integer NOT NULL,
	"status" text NOT NULL,
	"refusal_reason" text,
	"drawn_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_credentials" (
	"credential_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"application_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"application_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"application_id" text NOT NULL,
	"webhook_endpoint_id" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"attempt_count" integer NOT NULL,
	"cycle_attempt_count" integer NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"last_response_status" integer,
	"dead_letter_reason" text,
	"succeeded_at" timestamp with time zone,
	"dead_lettered_at" timestamp with time zone,
	"replay_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "organization_members_organization_id_oxy_user_id_key" ON "organization_members" USING btree ("organization_id","oxy_user_id");--> statement-breakpoint
CREATE INDEX "organization_members_oxy_user_id_status_idx" ON "organization_members" USING btree ("oxy_user_id","status");--> statement-breakpoint
CREATE INDEX "staff_audit_events_actor_oxy_user_id_occurred_at_idx" ON "staff_audit_events" USING btree ("actor_oxy_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "staff_audit_events_application_id_occurred_at_idx" ON "staff_audit_events" USING btree ("application_id","occurred_at");--> statement-breakpoint
CREATE INDEX "app_trust_snapshots_standing_updated_at_idx" ON "app_trust_snapshots" USING btree ("standing","updated_at");--> statement-breakpoint
CREATE INDEX "app_trust_snapshots_organization_id_idx" ON "app_trust_snapshots" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "outbox_events_status_available_at_idx" ON "outbox_events" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "reviewer_affinities_reviewer_id_a_co_served_count_idx" ON "reviewer_affinities" USING btree ("reviewer_id_a","co_served_count");--> statement-breakpoint
CREATE INDEX "reviewer_affinities_reviewer_id_b_co_served_count_idx" ON "reviewer_affinities" USING btree ("reviewer_id_b","co_served_count");--> statement-breakpoint
CREATE UNIQUE INDEX "reviewer_principal_links_reviewer_application_principal_key" ON "reviewer_principal_links" USING btree ("reviewer_id","application_id","external_principal_id");--> statement-breakpoint
CREATE INDEX "reviewer_principal_links_application_id_external_principal_id_idx" ON "reviewer_principal_links" USING btree ("application_id","external_principal_id");--> statement-breakpoint
CREATE INDEX "reviewer_principal_links_reviewer_id_idx" ON "reviewer_principal_links" USING btree ("reviewer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reviewer_profiles_oxy_user_id_key" ON "reviewer_profiles" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE INDEX "reviewer_profiles_categories_idx" ON "reviewer_profiles" USING gin ("categories");--> statement-breakpoint
CREATE INDEX "reviewer_profiles_languages_idx" ON "reviewer_profiles" USING gin ("languages");--> statement-breakpoint
CREATE INDEX "reviewer_profiles_state_sampling_key_idx" ON "reviewer_profiles" USING btree ("state","sampling_key");--> statement-breakpoint
CREATE INDEX "reviewer_profiles_risk_cluster_id_idx" ON "reviewer_profiles" USING btree ("risk_cluster_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reviewer_relations_reviewer_application_principal_key" ON "reviewer_relations" USING btree ("reviewer_id","application_id","external_principal_id");--> statement-breakpoint
CREATE INDEX "reviewer_relations_application_id_external_principal_id_idx" ON "reviewer_relations" USING btree ("application_id","external_principal_id");--> statement-breakpoint
CREATE INDEX "assignments_case_id_case_revision_idx" ON "assignments" USING btree ("case_id","case_revision");--> statement-breakpoint
CREATE INDEX "assignments_incident_id_idx" ON "assignments" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "assignments_reviewer_id_status_idx" ON "assignments" USING btree ("reviewer_id","status");--> statement-breakpoint
CREATE INDEX "assignments_status_expires_at_idx" ON "assignments" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "reviews_case_id_case_revision_idx" ON "reviews" USING btree ("case_id","case_revision");--> statement-breakpoint
CREATE INDEX "reviews_reviewer_id_submitted_at_review_id_idx" ON "reviews" USING btree ("reviewer_id","submitted_at","review_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_assignment_id_key" ON "reviews" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "sortition_draws_case_id_case_revision_drawn_at_idx" ON "sortition_draws" USING btree ("case_id","case_revision","drawn_at");--> statement-breakpoint
CREATE INDEX "application_credentials_application_id_idx" ON "application_credentials" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "application_credentials_organization_id_idx" ON "application_credentials" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "applications_organization_id_idx" ON "applications" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_lower_key" ON "organizations" USING btree (lower("slug"));--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_endpoint_event_key" ON "webhook_deliveries" USING btree ("webhook_endpoint_id","event_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx" ON "webhook_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_application_status_created_idx" ON "webhook_deliveries" USING btree ("application_id","status","created_at" DESC NULLS LAST);
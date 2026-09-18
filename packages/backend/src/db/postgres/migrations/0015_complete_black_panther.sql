-- oxy:deploy-phase=pre
-- Community notes (docs/architecture/community-notes.md): four new tenant-owned tables, each RLS-enabled and
-- forced with the same tenant_isolation and migrator_full_access policies every
-- tenant-owned table carries, plus the widened audit action CHECK. Additive only,
-- so it is safe before the image that uses it.
CREATE TABLE "community_note_assignments" (
	"assignment_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"application_id" text NOT NULL,
	"note_id" text NOT NULL,
	"rater_principal_id" text NOT NULL,
	"issuance_key" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"rated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_note_ratings" (
	"rating_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"application_id" text NOT NULL,
	"note_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"rater_principal_id" text NOT NULL,
	"rating" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"rated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "community_note_ratings_rating_check" CHECK ("community_note_ratings"."rating" in ('helpful', 'not_helpful'))
);
--> statement-breakpoint
CREATE TABLE "community_note_status_revisions" (
	"revision_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"application_id" text NOT NULL,
	"note_id" text NOT NULL,
	"revision" integer NOT NULL,
	"status" text NOT NULL,
	"algorithm_version" text,
	"note_intercept" double precision,
	"note_factor" double precision,
	"rating_count" integer NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "community_note_status_revisions_status_check" CHECK ("community_note_status_revisions"."status" in ('needs_ratings', 'shown', 'not_shown', 'withdrawn'))
);
--> statement-breakpoint
CREATE TABLE "community_notes" (
	"note_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"application_id" text NOT NULL,
	"external_subject_id" text NOT NULL,
	"subject_author_principal_id" text NOT NULL,
	"author_principal_id" text NOT NULL,
	"language" text NOT NULL,
	"text" text NOT NULL,
	"source_urls" jsonb NOT NULL,
	"status" text NOT NULL,
	"status_revision" integer NOT NULL,
	"status_changed_at" timestamp with time zone NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"written_by_credential_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "community_notes_status_check" CHECK ("community_notes"."status" in ('needs_ratings', 'shown', 'not_shown', 'withdrawn'))
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_action_check";--> statement-breakpoint
CREATE UNIQUE INDEX "community_note_assignments_application_note_rater_key" ON "community_note_assignments" USING btree ("application_id","note_id","rater_principal_id");--> statement-breakpoint
CREATE INDEX "community_note_assignments_application_issuance_idx" ON "community_note_assignments" USING btree ("application_id","rater_principal_id","issuance_key");--> statement-breakpoint
CREATE UNIQUE INDEX "community_note_ratings_application_idempotency_key" ON "community_note_ratings" USING btree ("application_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "community_note_ratings_application_note_rater_key" ON "community_note_ratings" USING btree ("application_id","note_id","rater_principal_id");--> statement-breakpoint
CREATE INDEX "community_note_ratings_application_rater_rated_idx" ON "community_note_ratings" USING btree ("application_id","rater_principal_id","rated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "community_note_status_revisions_application_note_revision_key" ON "community_note_status_revisions" USING btree ("application_id","note_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "community_notes_application_idempotency_key" ON "community_notes" USING btree ("application_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "community_notes_application_subject_author_key" ON "community_notes" USING btree ("application_id","external_subject_id","author_principal_id");--> statement-breakpoint
CREATE INDEX "community_notes_application_subject_status_idx" ON "community_notes" USING btree ("application_id","external_subject_id","status");--> statement-breakpoint
CREATE INDEX "community_notes_application_author_created_idx" ON "community_notes" USING btree ("application_id","author_principal_id","created_at");--> statement-breakpoint
CREATE INDEX "community_notes_application_status_language_idx" ON "community_notes" USING btree ("application_id","status","language");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_check" CHECK ("audit_events"."action" in ('report.ingress.accepted', 'report.ingress.replayed', 'report.ingress.rejected', 'report.receipt.read', 'case.read', 'decision.read', 'appeal.filed', 'appeal.filed.replayed', 'community_note.written', 'community_note.withdrawn', 'community_note.assignments.issued', 'community_note.rated', 'console.credential.issued', 'console.credential.revoked', 'console.webhook.secret.rotated', 'console.delivery.replayed', 'console.application.created'));--> statement-breakpoint

ALTER TABLE "community_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "community_notes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "community_notes"
	FOR ALL
	USING (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	)
	WITH CHECK (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	);--> statement-breakpoint
CREATE POLICY "migrator_full_access" ON "community_notes"
	FOR ALL
	TO "crowdsource_migrator"
	USING (true)
	WITH CHECK (true);--> statement-breakpoint

ALTER TABLE "community_note_ratings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "community_note_ratings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "community_note_ratings"
	FOR ALL
	USING (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	)
	WITH CHECK (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	);--> statement-breakpoint
CREATE POLICY "migrator_full_access" ON "community_note_ratings"
	FOR ALL
	TO "crowdsource_migrator"
	USING (true)
	WITH CHECK (true);--> statement-breakpoint

ALTER TABLE "community_note_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "community_note_assignments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "community_note_assignments"
	FOR ALL
	USING (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	)
	WITH CHECK (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	);--> statement-breakpoint
CREATE POLICY "migrator_full_access" ON "community_note_assignments"
	FOR ALL
	TO "crowdsource_migrator"
	USING (true)
	WITH CHECK (true);--> statement-breakpoint

ALTER TABLE "community_note_status_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "community_note_status_revisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "community_note_status_revisions"
	FOR ALL
	USING (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	)
	WITH CHECK (
		"organization_id" = current_setting('app.organization_id', true)
		AND "application_id" = current_setting('app.application_id', true)
	);--> statement-breakpoint
CREATE POLICY "migrator_full_access" ON "community_note_status_revisions"
	FOR ALL
	TO "crowdsource_migrator"
	USING (true)
	WITH CHECK (true);

-- oxy:deploy-phase=pre
-- Oxy file references (oxy ADR 0043; docs/architecture/evidence-files.md):
-- three new tables the previous image never reads, plus the widened audit
-- action and reason CHECKs, whose new values only the new image writes.
-- Additive only, so it applies before the rollout. No row changes.
CREATE TABLE "case_evidence_files" (
	"organization_id" text NOT NULL,
	"application_id" text NOT NULL,
	"case_id" text NOT NULL,
	"file_id" text NOT NULL,
	"file_status" text NOT NULL,
	"file_visibility" text,
	"file_state_at" timestamp with time zone,
	"reference_state" text NOT NULL,
	"reference_attempts" integer NOT NULL,
	"reference_due_at" timestamp with time zone NOT NULL,
	"reference_claim" text,
	"reference_error" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "case_evidence_files_pkey" PRIMARY KEY("case_id","file_id"),
	CONSTRAINT "case_evidence_files_file_status_check" CHECK ("case_evidence_files"."file_status" in ('active', 'trash', 'blocked', 'deleted', 'unknown')),
	CONSTRAINT "case_evidence_files_file_visibility_check" CHECK ("case_evidence_files"."file_visibility" is null or "case_evidence_files"."file_visibility" in ('public', 'unlisted', 'private')),
	CONSTRAINT "case_evidence_files_reference_state_check" CHECK ("case_evidence_files"."reference_state" in ('pending', 'registered', 'refused', 'removal_pending', 'removed')),
	CONSTRAINT "case_evidence_files_reference_attempts_check" CHECK ("case_evidence_files"."reference_attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "oxy_file_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"file_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"file_status" text NOT NULL,
	"file_visibility" text NOT NULL,
	"rows_changed" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "oxy_file_events_type_check" CHECK ("oxy_file_events"."type" in ('file.deleted', 'file.visibility_changed', 'file.trashed', 'file.restored', 'file.blocked', 'file.unblocked')),
	CONSTRAINT "oxy_file_events_rows_changed_check" CHECK ("oxy_file_events"."rows_changed" >= 0)
);
--> statement-breakpoint
CREATE TABLE "oxy_file_reconciliations" (
	"entity_type" text PRIMARY KEY NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_started_at" timestamp with time zone,
	"last_completed_at" timestamp with time zone,
	"last_dry_run" boolean,
	"last_counts" jsonb,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_action_check";--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_reason_check";--> statement-breakpoint
CREATE INDEX "case_evidence_files_file_id_idx" ON "case_evidence_files" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "case_evidence_files_reference_due_idx" ON "case_evidence_files" USING btree ("reference_due_at") WHERE "case_evidence_files"."reference_state" in ('pending', 'removal_pending');--> statement-breakpoint
CREATE INDEX "oxy_file_events_file_id_idx" ON "oxy_file_events" USING btree ("file_id");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_check" CHECK ("audit_events"."action" in ('report.ingress.accepted', 'report.ingress.replayed', 'report.ingress.rejected', 'report.receipt.read', 'case.read', 'decision.read', 'appeal.filed', 'appeal.filed.replayed', 'community_note.written', 'community_note.withdrawn', 'community_note.assignments.issued', 'community_note.rated', 'console.credential.issued', 'console.credential.revoked', 'console.webhook.secret.rotated', 'console.delivery.replayed', 'console.application.created', 'evidence.withheld', 'evidence.restored'));--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_reason_check" CHECK ("audit_events"."reason" is null or "audit_events"."reason" in ('schema_invalid', 'application_mismatch', 'unsafe_resource_url', 'policy_unknown', 'payload_conflict', 'evidence_unverified', 'file_trashed', 'file_blocked', 'file_deleted', 'file_private', 'file_unavailable', 'file_unreferenceable'));
-- oxy:deploy-phase=pre
--
-- Additive only: five CREATE TABLEs and their indexes, nothing dropped, renamed
-- or narrowed. `pre` is therefore safe while the previous image is still serving
-- traffic, which is what that phase means — @oxyhq/db's runner refuses a
-- migration that does not say which side of a deploy it belongs on, rather than
-- guessing and running a narrowing statement against a live old image.
--
CREATE TABLE "moderation_enforcements" (
	"decision_id" text NOT NULL,
	"decision_revision" integer NOT NULL,
	"action" text NOT NULL,
	"case_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"outcome" text NOT NULL,
	"recommended_action" text,
	"recorded_as" text,
	"reason" varchar(500) NOT NULL,
	"mode" text NOT NULL,
	"applied" boolean DEFAULT false NOT NULL,
	"applied_at" timestamp with time zone,
	"skipped_reason" varchar(300),
	"previous_state" jsonb,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "moderation_enforcements_pkey" PRIMARY KEY("decision_id","decision_revision","action"),
	CONSTRAINT "moderation_enforcements_revision_check" CHECK ("moderation_enforcements"."decision_revision" >= 1),
	CONSTRAINT "moderation_enforcements_action_check" CHECK ("moderation_enforcements"."action" in ('restrict', 'restore', 'flag', 'unflag', 'review', 'none')),
	CONSTRAINT "moderation_enforcements_recorded_as_check" CHECK ("moderation_enforcements"."recorded_as" is null or "moderation_enforcements"."recorded_as" in ('restrict', 'restore', 'flag', 'unflag', 'review', 'none')),
	CONSTRAINT "moderation_enforcements_mode_check" CHECK ("moderation_enforcements"."mode" in ('observe', 'manual', 'automatic'))
);
--> statement-breakpoint
CREATE TABLE "moderation_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text,
	"case_id" text,
	"payload" jsonb,
	"state" text DEFAULT 'claimed' NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"queued_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "moderation_events_state_check" CHECK ("moderation_events"."state" in ('claimed', 'queued', 'ignored'))
);
--> statement-breakpoint
CREATE TABLE "moderation_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" varchar(2000),
	"processed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "moderation_outbox_kind_check" CHECK ("moderation_outbox"."kind" in ('report.submit', 'decision.apply')),
	CONSTRAINT "moderation_outbox_status_check" CHECK ("moderation_outbox"."status" in ('pending', 'processing', 'processed', 'dead_letter'))
);
--> statement-breakpoint
CREATE TABLE "moderation_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"reported_type" text NOT NULL,
	"reported_id" text NOT NULL,
	"reporter" text NOT NULL,
	"categories" text[] NOT NULL,
	"details" varchar(2000),
	"local_status" text DEFAULT 'received' NOT NULL,
	"local_status_reason" varchar(300),
	"crowdsource_report_id" text,
	"crowdsource_case_id" text,
	"crowdsource_merged" boolean,
	"content_snapshot_hash" text,
	"submitted_at" timestamp with time zone,
	"last_delivery_error" varchar(2000),
	"decision_id" text,
	"decision_revision" integer,
	"decision_outcome" text,
	"decision_status" text,
	"decided_at" timestamp with time zone,
	"enforced_action" text,
	"enforced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"legacy_status" text DEFAULT 'pending' NOT NULL,
	CONSTRAINT "moderation_reports_local_status_check" CHECK ("moderation_reports"."local_status" in ('received', 'queued', 'submitted', 'delivery_failed', 'closed')),
	CONSTRAINT "moderation_reports_reported_type_check" CHECK ("moderation_reports"."reported_type" in ('widget', 'gizmo', 'doodad')),
	CONSTRAINT "moderation_reports_categories_check" CHECK ("moderation_reports"."categories" <@ array['spam', 'harassment', 'other']::text[])
);
--> statement-breakpoint
CREATE TABLE "widgets" (
	"id" text PRIMARY KEY NOT NULL,
	"body" text NOT NULL,
	"owner_id" text NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "moderation_enforcements_case_id_idx" ON "moderation_enforcements" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "moderation_enforcements_subject_chrono_idx" ON "moderation_enforcements" USING btree ("subject_type","subject_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "moderation_enforcements_subject_action_applied_idx" ON "moderation_enforcements" USING btree ("subject_type","subject_id","action","applied","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "moderation_events_case_id_idx" ON "moderation_events" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "moderation_events_state_received_at_idx" ON "moderation_events" USING btree ("state","received_at");--> statement-breakpoint
CREATE INDEX "moderation_events_expires_at_idx" ON "moderation_events" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "moderation_outbox_due_idx" ON "moderation_outbox" USING btree ("status","available_at","created_at");--> statement-breakpoint
CREATE INDEX "moderation_outbox_lease_idx" ON "moderation_outbox" USING btree ("status","lease_until","created_at");--> statement-breakpoint
CREATE INDEX "moderation_outbox_expires_at_idx" ON "moderation_outbox" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "moderation_reports_local_status_created_at_idx" ON "moderation_reports" USING btree ("local_status","created_at");--> statement-breakpoint
CREATE INDEX "moderation_reports_crowdsource_case_id_idx" ON "moderation_reports" USING btree ("crowdsource_case_id");--> statement-breakpoint
CREATE INDEX "moderation_reports_reporter_object_idx" ON "moderation_reports" USING btree ("reporter","reported_id","reported_type");
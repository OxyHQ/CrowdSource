-- oxy:deploy-phase=pre
--
-- Additive: one CREATE TABLE and its indexes for the second fictional
-- application's report table. Nothing dropped, renamed or narrowed, so `pre` is
-- safe while the previous image is still serving.
--
CREATE TABLE "review_only_reports" (
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
	CONSTRAINT "review_only_reports_local_status_check" CHECK ("review_only_reports"."local_status" in ('received', 'queued', 'submitted', 'delivery_failed', 'closed')),
	CONSTRAINT "review_only_reports_reported_type_check" CHECK ("review_only_reports"."reported_type" in ('account', 'message')),
	CONSTRAINT "review_only_reports_categories_check" CHECK ("review_only_reports"."categories" <@ array['harassment']::text[])
);
--> statement-breakpoint
CREATE INDEX "review_only_reports_local_status_created_at_idx" ON "review_only_reports" USING btree ("local_status","created_at");--> statement-breakpoint
CREATE INDEX "review_only_reports_crowdsource_case_id_idx" ON "review_only_reports" USING btree ("crowdsource_case_id");--> statement-breakpoint
CREATE INDEX "review_only_reports_reporter_object_idx" ON "review_only_reports" USING btree ("reporter","reported_id","reported_type");
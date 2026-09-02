-- oxy:deploy-phase=pre
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "cases" LIMIT 1) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'CrowdSource cases cutover requires an empty PostgreSQL target; export MongoDB and import through the verified cutover tool instead of altering populated shadow rows.';
  END IF;
END
$$;--> statement-breakpoint
DROP INDEX "cases_application_subject_key";--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "content_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "policy_version" text NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "case_dedup_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "subject_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "primary_resource_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "policy_set_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "taxonomy_version" text NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "content_snapshot" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "allegation_codes" text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "report_count" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "reporter_fingerprints" text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "reach" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "active_distribution" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "allow_community_review" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "contains_personal_data" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "retention_days" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "priority_score" double precision NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "sensitivity_class" text;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "review_pool" text;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "requires_redaction" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "escalated" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "triaged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "current_revision" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "decided_revision" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "first_reported_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "last_reported_at" timestamp with time zone NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "cases_application_subject_content_policy_key" ON "cases" USING btree ("application_id","subject_external_id","content_hash","policy_version");--> statement-breakpoint
CREATE INDEX "cases_application_dedup_idx" ON "cases" USING btree ("application_id","case_dedup_key");--> statement-breakpoint
CREATE INDEX "cases_status_priority_created_idx" ON "cases" USING btree ("status","priority_score" DESC NULLS LAST,"created_at");--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_status_check" CHECK ("cases"."status" in ('received', 'triaged', 'awaiting_review', 'under_review', 'awaiting_consensus', 'decided', 'escalated', 'appealed', 'superseded', 'closed'));--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_report_count_check" CHECK ("cases"."report_count" >= 0);--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_reach_check" CHECK ("cases"."reach" >= 0);--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_retention_days_check" CHECK ("cases"."retention_days" > 0);--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_current_revision_check" CHECK ("cases"."current_revision" >= 1);--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_decided_revision_check" CHECK ("cases"."decided_revision" >= 0 and "cases"."decided_revision" <= "cases"."current_revision");

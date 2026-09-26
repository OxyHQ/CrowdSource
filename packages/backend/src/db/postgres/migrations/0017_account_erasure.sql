-- oxy:deploy-phase=pre
-- Two new tables and an index, nothing else: the previous image never reads
-- them, so they apply before the rollout and the new image boots against them.
-- No row changes. OxyHQ/Mention#1178.
CREATE TABLE "account_erasures" (
	"event_id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"source" text NOT NULL,
	"occurred_at" timestamp with time zone,
	"retained" boolean NOT NULL,
	"status" text NOT NULL,
	"attempts" integer NOT NULL,
	"lease_until" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"counts" jsonb,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "account_erasures_source_check" CHECK ("account_erasures"."source" in ('webhook', 'reconciliation')),
	CONSTRAINT "account_erasures_status_check" CHECK ("account_erasures"."status" in ('pending', 'running', 'completed', 'failed')),
	CONSTRAINT "account_erasures_attempts_check" CHECK ("account_erasures"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "account_event_cursors" (
	"feed" text PRIMARY KEY NOT NULL,
	"cursor" text,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "account_erasures_status_lease_until_idx" ON "account_erasures" USING btree ("status","lease_until");

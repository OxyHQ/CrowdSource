-- oxy:deploy-phase=pre
ALTER TABLE "organization_members" ADD COLUMN "invited_by_oxy_user_id" text;--> statement-breakpoint
ALTER TABLE "organization_members" ADD COLUMN "revoked_at" timestamp with time zone;

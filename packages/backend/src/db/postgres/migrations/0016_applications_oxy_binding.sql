-- oxy:deploy-phase=pre
-- A nullable column and a partial unique index: nothing reads it until the image
-- that can, and the previous image never selects it, so it applies before the
-- rollout. No row changes.
ALTER TABLE "applications" ADD COLUMN "oxy_application_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "applications_oxy_application_id_key" ON "applications" USING btree ("oxy_application_id") WHERE "applications"."oxy_application_id" is not null;
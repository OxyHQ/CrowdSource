-- oxy:deploy-phase=pre
-- Expand: the old image may still provide the synthetic id while the new image
-- omits it. Both can write during the rolling deployment; the natural tuple is
-- already unique in the old schema, so promoting it does not change row identity.
ALTER TABLE "reviewer_principal_links" DROP CONSTRAINT "reviewer_principal_links_pkey";--> statement-breakpoint
ALTER TABLE "reviewer_principal_links" ALTER COLUMN "reviewer_principal_link_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reviewer_principal_links" ADD CONSTRAINT "reviewer_principal_links_reviewer_application_principal_pk" PRIMARY KEY("reviewer_id","application_id","external_principal_id");--> statement-breakpoint
DROP INDEX "reviewer_principal_links_reviewer_application_principal_key";

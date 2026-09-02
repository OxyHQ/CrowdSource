-- oxy:deploy-phase=post
-- Contract only after the PostgreSQL-only image has passed its smoke checks.
ALTER TABLE "reviewer_principal_links" DROP COLUMN "reviewer_principal_link_id";

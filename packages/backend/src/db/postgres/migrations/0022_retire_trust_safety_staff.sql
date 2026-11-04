-- oxy:deploy-phase=post
-- Retires trust_safety_staff. Trust & Safety roles are Oxy application permissions held
-- through a role in the organization that owns CrowdSource (oxy ADR 0056); the image this
-- ships with no longer names the table, but the previous one still deletes from it on
-- account erasure, so it is dropped only after that image has drained. Production held
-- no rows; a row here means someone was relying on it, so the drop refuses rather than
-- discarding it. No foreign key or view references the table, so no CASCADE.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM trust_safety_staff) THEN RAISE EXCEPTION 'trust_safety_staff is not empty; map its holders to Oxy organization roles before dropping it'; END IF;
END $$;
--> statement-breakpoint
DROP TABLE "trust_safety_staff";

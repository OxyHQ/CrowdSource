-- oxy:deploy-phase=post
-- Run only after the previous image has drained. Unexpected unmapped data stops cutover.
LOCK TABLE organizations IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM organizations WHERE oxy_account_id IS NULL) THEN RAISE EXCEPTION 'Reviewed organization mapping required before cutover'; END IF;
 IF EXISTS (SELECT 1 FROM organizations o FULL JOIN organization_identity_archives a USING (organization_id)
 WHERE (o.name IS NOT NULL AND a.name IS DISTINCT FROM o.name) OR (a.organization_id IS NOT NULL AND o.organization_id IS NULL)) THEN RAISE EXCEPTION 'Organization identity archive mismatch'; END IF;
END $$;
--> statement-breakpoint
DROP TRIGGER organizations_identity_frozen ON organizations;
--> statement-breakpoint
DROP FUNCTION crowdsource_freeze_organization_identity();
--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_active_identity_check" CHECK ("organizations"."status" <> 'active' OR "organizations"."oxy_account_id" IS NOT NULL);
--> statement-breakpoint
CREATE FUNCTION crowdsource_protect_organization_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.oxy_account_id IS DISTINCT FROM NEW.oxy_account_id AND NOT (NEW.oxy_account_id IS NULL AND NEW.status='suspended') THEN RAISE EXCEPTION 'Organization reference cannot be reassigned'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER organizations_reference_immutable BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION crowdsource_protect_organization_reference();

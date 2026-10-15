-- oxy:deploy-phase=pre
CREATE TABLE "organization_identity_archives" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "oxy_account_id" text;--> statement-breakpoint
ALTER TABLE "organization_identity_archives" ADD CONSTRAINT "org_identity_archive_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_oxy_account_id_key" ON "organizations" USING btree ("oxy_account_id");
--> statement-breakpoint
LOCK TABLE organizations IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
INSERT INTO organization_identity_archives (organization_id,name) SELECT organization_id,name FROM organizations;
--> statement-breakpoint
-- Reviewed source ownership: inventory task 9bf215c7, Oxy app-owner evidence b74bb8cf.
-- Exact tenant + sole app + canonical application binding, never a name/slug match.
UPDATE organizations SET oxy_account_id='69b2d3df5d12f58c9800d651'
WHERE organization_id='org_d7139127ac384a1da3963564cb592549'
AND (SELECT count(*) FROM applications WHERE organization_id=organizations.organization_id)=1
AND EXISTS (SELECT 1 FROM applications WHERE organization_id=organizations.organization_id
  AND application_id='app_61e5372b942a493c94904a7d697c942b'
  AND oxy_application_id='6a2f851751b784a86fd0e916');
--> statement-breakpoint
CREATE FUNCTION crowdsource_freeze_organization_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
   IF NEW.name IS NOT NULL OR NEW.oxy_account_id IS NULL THEN RAISE EXCEPTION 'Organization identity is managed in Oxy'; END IF;
 ELSIF NEW.name IS DISTINCT FROM OLD.name THEN RAISE EXCEPTION 'Organization identity is managed in Oxy';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER organizations_identity_frozen BEFORE INSERT OR UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION crowdsource_freeze_organization_identity();
--> statement-breakpoint
CREATE FUNCTION crowdsource_immutable_organization_archive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Organization identity archive is immutable'; END $$;
--> statement-breakpoint
CREATE TRIGGER organization_identity_archive_immutable BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON organization_identity_archives FOR EACH STATEMENT EXECUTE FUNCTION crowdsource_immutable_organization_archive();

-- oxy:deploy-phase=post
-- Contract: reject values the retired document validators rejected. Applying
-- this after the PostgreSQL-only image keeps the rolling window compatible;
-- any unreconciled legacy value makes the migration fail rather than widening
-- the domain silently.
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_roles_check" CHECK ("organization_members"."roles" <@ array['owner', 'admin', 'developer', 'viewer']::text[]);--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_status_check" CHECK ("organization_members"."status" in ('active', 'revoked'));--> statement-breakpoint
ALTER TABLE "staff_audit_events" ADD CONSTRAINT "staff_audit_events_action_check" CHECK ("staff_audit_events"."action" in ('staff.applications.read', 'staff.escalated.read', 'staff.metrics.read', 'staff.deadletter.read', 'staff.standing.changed'));--> statement-breakpoint
ALTER TABLE "staff_audit_events" ADD CONSTRAINT "staff_audit_events_roles_check" CHECK ("staff_audit_events"."roles" <@ array['policy', 'appeals', 'evidence', 'security']::text[]);--> statement-breakpoint
ALTER TABLE "trust_safety_staff" ADD CONSTRAINT "trust_safety_staff_roles_check" CHECK ("trust_safety_staff"."roles" <@ array['policy', 'appeals', 'evidence', 'security']::text[]);--> statement-breakpoint
ALTER TABLE "trust_safety_staff" ADD CONSTRAINT "trust_safety_staff_status_check" CHECK ("trust_safety_staff"."status" in ('active', 'revoked'));--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_check" CHECK ("audit_events"."action" in ('report.ingress.accepted', 'report.ingress.replayed', 'report.ingress.rejected', 'report.receipt.read', 'case.read', 'decision.read', 'appeal.filed', 'appeal.filed.replayed', 'console.credential.issued', 'console.credential.revoked', 'console.webhook.secret.rotated', 'console.delivery.replayed', 'console.application.created'));--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_reason_check" CHECK ("audit_events"."reason" is null or "audit_events"."reason" in ('schema_invalid', 'application_mismatch', 'unsafe_resource_url', 'policy_unknown', 'payload_conflict'));--> statement-breakpoint
ALTER TABLE "policy_sets" ADD CONSTRAINT "policy_sets_status_check" CHECK ("policy_sets"."status" in ('draft', 'published'));--> statement-breakpoint
ALTER TABLE "app_trust_snapshots" ADD CONSTRAINT "app_trust_snapshots_standing_check" CHECK ("app_trust_snapshots"."standing" in ('sandbox', 'trusted', 'restricted'));--> statement-breakpoint
ALTER TABLE "app_trust_snapshots" ADD CONSTRAINT "app_trust_snapshots_last_standing_reason_check" CHECK ("app_trust_snapshots"."last_standing_reason" in ('initial', 'promotion_review_passed', 'evidence_integrity_failed', 'high_overturn_rate', 'suspected_abuse', 'investigation_closed'));--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_status_check" CHECK ("reports"."status" in ('received', 'merged', 'invalid', 'withdrawn', 'closed'));--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_status_check" CHECK ("application_credentials"."status" in ('active', 'revoked'));--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_status_check" CHECK ("applications"."status" in ('active', 'suspended'));--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_status_check" CHECK ("organizations"."status" in ('active', 'suspended'));--> statement-breakpoint
ALTER TABLE "webhook_attempts" ADD CONSTRAINT "webhook_attempts_outcome_check" CHECK ("webhook_attempts"."outcome" in ('succeeded', 'failed'));--> statement-breakpoint
ALTER TABLE "webhook_attempts" ADD CONSTRAINT "webhook_attempts_failure_kind_check" CHECK ("webhook_attempts"."failure_kind" is null or "webhook_attempts"."failure_kind" in ('http_status', 'unsafe_target', 'upstream_unreachable', 'secret_unavailable', 'endpoint_disabled'));--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_status_check" CHECK ("webhook_endpoints"."status" in ('active', 'disabled'));--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_disabled_reason_check" CHECK ("webhook_endpoints"."disabled_reason" is null or "webhook_endpoints"."disabled_reason" in ('gone', 'operator'));

-- oxy:deploy-phase=pre
-- Widens the oxy_file_events type CHECK for file.lost (@oxy.so/core 6.14). Additive: the
-- previous image never writes the new value, so this applies before the rollout.
ALTER TABLE "oxy_file_events" DROP CONSTRAINT "oxy_file_events_type_check";--> statement-breakpoint
ALTER TABLE "oxy_file_events" ADD CONSTRAINT "oxy_file_events_type_check" CHECK ("oxy_file_events"."type" in ('file.deleted', 'file.visibility_changed', 'file.trashed', 'file.restored', 'file.blocked', 'file.unblocked', 'file.lost'));
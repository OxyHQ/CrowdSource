-- oxy:deploy-phase=pre
--
-- Six closed value sets enforced as CHECK constraints, so none is merely a
-- comment. §9.6's decision vocabulary, §9.8's appeal grounds,
-- §12.7's delivery lifecycle and §10.9's stop reasons.
--
-- PRE, though a CHECK narrows. A `post` statement is one that BREAKS A WRITE THE
-- PREVIOUS IMAGE PERFORMS, and these break none: every writer of these six
-- columns supplies a literal from the same tuple the constraint is rendered
-- from, so the running image keeps working against them unchanged.
--
-- All 27 tables are EMPTY, so no ADD CONSTRAINT here can fail validating an
-- existing row. Stated rather than implied, because a CHECK is validated at ADD
-- time and one violating row would fail the migration mid-deploy.
--
-- EVERY ONE IS A RULE THAT WAS ACTUALLY ENFORCED ON INSERT. Each of these six
-- columns is written through an insert path that already rejected values
-- outside its set. Value sets written only by update paths were never enforced;
-- those are recorded in `closedValueSets.realdb.test.ts` as not-applicable,
-- because a rule that never RAN must not become a constraint that does.
--
-- `webhook_deliveries.dead_letter_reason` IS NULLABLE and its CHECK admits NULL
-- without saying so: a CHECK rejects only FALSE, and `NULL in (…)` is NULL.
-- Measured on a real server — the same shape of constraint accepted a NULL row
-- and rejected a non-member with 23514. "No reason yet" is therefore already
-- legal, and an `OR … IS NULL` would be redundant rather than protective.
--
-- `webhook_deliveries.event_type` DELIBERATELY GETS NO CHECK. §10.6's event
-- types are a published vocabulary, but the column has never been limited to a
-- fixed set, so a constraint would be a NEW restriction rather than an enforced
-- existing one — and it is the field most likely
-- to gain a member, where a CHECK dead-letters a legitimate new event at the
-- DATABASE rather than at the contract.
--
-- All six render from a tuple via `inList` — four from
-- `@oxy.so/crowdsource-contracts`, two from `db/postgres/schema/webhooks.ts`.
-- `sql.raw` on the value list is required: an ordinary
-- interpolation into `check()` emits the bound parameter `$1` and fails at APPLY
-- time with no local signal. Verified before commit: no `$N` appears below.
--
-- REGENERATION WARNING. This header is HAND-MAINTAINED: `bun run db:generate`
-- emits only the statements below and this block is gone. Re-apply it, keep
-- exactly ONE `-- oxy:deploy-phase=` line, and read the regenerated file for
-- statements you did not intend.

ALTER TABLE "appeals" ADD CONSTRAINT "appeals_reason_check" CHECK ("appeals"."reason" in ('context_missing', 'policy_misapplied', 'finding_incorrect', 'exception_applies', 'not_responsible', 'procedural_error'));--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_status_check" CHECK ("decisions"."status" in ('provisional', 'final', 'superseded', 'corrected'));--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_outcome_check" CHECK ("decisions"."outcome" in ('violation', 'no_violation', 'insufficient_context', 'inconclusive', 'content_unavailable', 'duplicate', 'escalated'));--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_context_sufficiency_check" CHECK ("decisions"."context_sufficiency" in ('sufficient', 'insufficient'));--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_status_check" CHECK ("webhook_deliveries"."status" in ('pending', 'delivering', 'succeeded', 'dead_letter'));--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_dead_letter_reason_check" CHECK ("webhook_deliveries"."dead_letter_reason" in ('attempts_exhausted', 'endpoint_gone', 'client_error', 'unsafe_target', 'endpoint_disabled'));

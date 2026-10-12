-- oxy:deploy-phase=pre
--
-- PRE, on the same reasoning 0003 and 0004 set out: a `post` statement is one
-- that BREAKS A WRITE THE PREVIOUS IMAGE PERFORMS. Eight of the nine below break
-- none, because every writer of those columns already stays inside exactly these
-- sets and never writes a duplicate. The previous image keeps running against
-- them unchanged, which is exactly the property `pre` asserts. Both tables are
-- also EMPTY, so no statement here can fail on existing data.
--
-- Do NOT paraphrase that rule as "post = narrowing". A CHECK and a UNIQUE both
-- narrow, and all nine are `post` under that paraphrase — but the zero-capacity
-- deploy path does not run `post` at all, so marking this file `post` would leave
-- the constraints unapplied AND queue every later `pre` behind them. That exact
-- stall has cost a sibling service four consecutive red deploys.
--
-- These are the structural guarantees of the two sortition tables. Without them
-- each would be a comment, and nothing recomputes a comment. A prohibition is a
-- TYPE or a CHECK, never a convention.
--
-- ## The UNIQUE is the one to read first
--
-- `assignments_case_id_reviewer_id_case_revision_key` makes
-- `case_id + reviewer_id + case_revision` unique. Migrations 0000-0004 had no
-- such constraint, and no gate would ever have noticed:
-- `closedValueSets.realdb.test.ts` censuses value sets, and a unique is a
-- different shape.
--
-- It is load-bearing rather than decorative. `openPanel`'s own header names it as
-- the reason a replayed draw is safe — "the unique index on
-- `caseId + reviewerId + caseRevision` rejects a second attempt to seat the same
-- person" — and §12.7's review constraint is only meaningful if the assignment
-- authorising a review is unique the same way. Without it a replayed outbox
-- event would seat duplicate jurors, with no error and no log line.
--
-- Uniqueness is TOTAL, not partial: a recused or expired seat still occupies that
-- person's place on that revision (the replacement is a different person by
-- construction), so there is no status for which a second row is legitimate, and
-- a partial unique would readmit exactly the replay this rejects.
--
-- ## The seven value sets
--
-- Every value list is RENDERED from its tuple via `inList` rather than spelled
-- out here — `ASSIGNMENT_STATUSES`, `DRAW_STATUSES` and `DRAW_KINDS` from
-- `db/postgres/schema/sortition.ts`, `SLOT_TYPES` from
-- `modules/sortition/panelSpec` and `REVIEW_POOLS` from `modules/triage`. So
-- adding a member is a code change PLUS a migration
-- in the same PR rather than a constraint that silently stops agreeing with the
-- type. Rendered with `sql.raw` deliberately: an ordinary interpolation into
-- `check()` emits the bound parameter `$1`, which fails at APPLY time with no
-- local signal.
--
-- `requested_slots` is `text[]`, so its value set is CONTAINMENT (`<@`) rather
-- than `in (...)`: it constrains each element. Note it is vacuously TRUE for
-- `{}`.
--
-- `sensitivity_class`, `refusal_reason`, `panel_spec_id` and `rules_version`
-- DELIBERATELY get no CHECK. None has ever been limited to a fixed set, so
-- constraining any here would be a NEW restriction on its writers rather than
-- the enforcement of an existing one. The asymmetry is recorded so a later
-- reader does not "fix" it.
--
-- ## THE LAST STATEMENT IS THE ONLY NEW RESTRICTION IN THIS FILE
--
-- Called out because the other eight enforce rules writers already followed and
-- it does not. Nothing before it enforced a non-empty array; the invariant lived
-- in `sortition.service.ts:471`'s throw, which is application code. It is still
-- `pre` — no writer violates it today — but that evidence rests on one code path
-- rather than on an enforced rule, and that is a weaker kind of evidence than
-- the eight above rest on.
--
-- It is an IMPLICATION, not a floor, and the asymmetry is load-bearing:
-- `sortition.service.ts:433-450` records the §7.5 row-1 legal-pool refusal with
-- `slots: []` deliberately, so that "no panel was ever opened" and "this case is
-- under legal protocol" stay distinguishable. A flat
-- `cardinality(requested_slots) >= 1` would refuse that legitimate write.
-- `cardinality()` and never `array_length(col, 1)`: the latter is NULL on an empty
-- array, a CHECK rejects only FALSE, and NULL is not FALSE — so the `array_length`
-- spelling would ADMIT `{}` on a `drawn` row and enforce nothing, while reading
-- identically. Both directions are fixtured in
-- `sortitionRepositories.realdb.test.ts`.
--
-- REGENERATION WARNING. This header is HAND-MAINTAINED: `bun run db:generate`
-- emits only the statements below and this block is gone. Re-apply it, keep
-- exactly ONE `-- oxy:deploy-phase=` line, and read the regenerated file for
-- statements you did not intend.

ALTER TABLE "assignments" ADD CONSTRAINT "assignments_case_id_reviewer_id_case_revision_key" UNIQUE("case_id","reviewer_id","case_revision");--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_status_check" CHECK ("assignments"."status" in ('offered', 'accepted', 'submitted', 'recused', 'expired', 'replaced'));--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_slot_type_check" CHECK ("assignments"."slot_type" in ('reliable_general', 'category_specialist', 'intermediate', 'calibrated_newcomer', 'appeals_reviewer'));--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_filled_as_check" CHECK ("assignments"."filled_as" in ('reliable_general', 'category_specialist', 'intermediate', 'calibrated_newcomer', 'appeals_reviewer'));--> statement-breakpoint
ALTER TABLE "sortition_draws" ADD CONSTRAINT "sortition_draws_status_check" CHECK ("sortition_draws"."status" in ('drawn', 'refused'));--> statement-breakpoint
ALTER TABLE "sortition_draws" ADD CONSTRAINT "sortition_draws_kind_check" CHECK ("sortition_draws"."kind" in ('initial', 'replacement', 'expansion'));--> statement-breakpoint
ALTER TABLE "sortition_draws" ADD CONSTRAINT "sortition_draws_pool_check" CHECK ("sortition_draws"."pool" in ('community', 'specialist', 'legal'));--> statement-breakpoint
ALTER TABLE "sortition_draws" ADD CONSTRAINT "sortition_draws_requested_slots_check" CHECK ("sortition_draws"."requested_slots" <@ array['reliable_general', 'category_specialist', 'intermediate', 'calibrated_newcomer', 'appeals_reviewer']::text[]);--> statement-breakpoint
ALTER TABLE "sortition_draws" ADD CONSTRAINT "sortition_draws_requested_slots_cardinality_check" CHECK ("sortition_draws"."status" <> 'drawn' or cardinality("sortition_draws"."requested_slots") >= 1);
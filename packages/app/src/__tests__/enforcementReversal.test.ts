/**
 * A reversal reads the row whose effect actually happened.
 *
 * `previousStateFor` filters the reversal lookup on `applied: true`, and that
 * one clause is what makes "restore it to what it WAS" true rather than
 * aspirational. Without it the lookup takes the most recent row of the reversed
 * action regardless of whether that row changed anything — and a row that was
 * merely RECORDED carries no `previousState` at all, so the reversal silently
 * falls back to whatever the application's default is.
 *
 * ## Why the obvious version of this test cannot fail
 *
 * `mercaria` wrote it, proved it could not fail, and deleted it — then told me,
 * which is how this file exists. Their version restored a restricted object and
 * asserted it came back; it passed with AND without the `applied: true` filter,
 * because an object that was never restricted is excluded by the effect's own
 * status guard anyway. The assertion had nothing to bite on.
 *
 * What discriminates is TWO ROWS THAT DISAGREE about what was displaced: an
 * older applied row that says `draft`, and a newer recorded-only row that says
 * nothing. Only the filter decides which one is read, so only that arrangement
 * can tell the two implementations apart.
 *
 * The bug it protects against is the one worth naming: a DRAFT that moderation
 * restricted must not be PUBLISHED by a correction. The appeal succeeded, so the
 * object goes back to what it was — and what it was is not visible.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Harness } from './support/backend.js';
import { decision } from './support/decisions.js';
import { BACKENDS } from './support/backends.js';

/**
 * Both backends, one suite. The leaf test names are unchanged: vitest prints
 * `mongoose > <name>` and `postgres > <name>`, and the mutation script matches on
 * the leaf.
 */
describe.each(BACKENDS)('$name', (backend) => {

  let harness: Harness | null = null;

  afterEach(async () => {
    await harness?.close();
    harness = null;
  });

  const CASE_ID = 'case_reversal';

  describe('a reversal restores what was actually displaced', () => {
    it('reads the applied row, not the newer recorded-only one', async () => {
      harness = await backend.createHarness();
      const widgetId = await harness.app.createWidget({
        body: 'a draft nobody has seen',
        ownerId: 'oxy-owner',
        status: 'draft',
      });
      const subject = { type: 'widget', id: widgetId };

      // --- Revision 1: a violation. Restricts a DRAFT, recording what it was.
      const first = await harness.moderation.enforcement.apply({
        decision: decision({
          revision: 1,
          outcome: 'violation',
          recommendedActions: [{ action: 'remove' }],
        }),
        caseId: CASE_ID,
        subject,
      });
      expect(first).toEqual([{ action: 'restrict', result: 'applied' }]);
      expect((await harness.app.readWidget(widgetId))?.status).toBe('restricted');

      /**
       * Revision 2: the same violation upheld. It plans `restrict` again, the
       * widget is already restricted, so the effect changes nothing — a RECORDED
       * row with no `previousState`, and it is now the most recent `restrict` row
       * for this object. Entirely ordinary, which is the point: nothing here is
       * contrived to break the lookup.
       */
      const second = await harness.moderation.enforcement.apply({
        decision: decision({
          revision: 2,
          outcome: 'violation',
          recommendedActions: [{ action: 'remove' }],
        }),
        caseId: CASE_ID,
        subject,
      });
      expect(second).toEqual([{ action: 'restrict', result: 'recorded' }]);

      const restrictRows = (await harness.enforcement.rows()).filter(
        (row) => row.action === 'restrict',
      );
      expect(restrictRows).toHaveLength(2);
      // Oldest first, and the two rows disagree: the NEWER one is uninformative.
      expect(restrictRows[0].applied).toBe(true);
      expect(restrictRows[0].previousState).toEqual({ status: 'draft' });
      expect(restrictRows[1].applied).toBe(false);
      expect(restrictRows[1].previousState).toBeNull();

      // --- Revision 3: the correction. The restore must read the APPLIED row.
      const third = await harness.moderation.enforcement.apply({
        decision: decision({
          revision: 3,
          outcome: 'no_violation',
          findings: [],
          recommendedActions: [{ action: 'no_action' }],
        }),
        caseId: CASE_ID,
        subject,
      });
      // Every declared restore is planned; this test is about which ROW the
      // restore reads, so it asserts that entry rather than the whole plan.
      expect(third).toContainEqual({ action: 'restore', result: 'applied' });

      /**
       * `draft`, not `published`. Reading the newer recorded-only row would hand
       * the effect no `previousState`, and the application's fallback would put a
       * draft into publication — a moderation correction publishing something its
       * author never did.
       */
      expect((await harness.app.readWidget(widgetId))?.status).toBe('draft');
    });

  });

  describe('an action that could not apply to THIS object is labelled honestly', () => {
    it('records the effective action on the report, not the planned one', async () => {
      /**
       * `noted-moovo`'s asymmetry, measured in Moovo: the restore lever exists for
       * a courier and not for a customer or a delivery, and two of their three
       * delivered subject types are the latter — so this is the majority of
       * `no_violation` outcomes, not a corner.
       *
       * The plan is computed before `apply` runs and is deliberately
       * subject-blind, so it must name `restore`. Only `apply` knows this
       * particular object has no such lever, and `recordedAs` is how it says so.
       */
      harness = await backend.createHarness();
      const widgetId = await harness.app.createWidget({
        body: 'never restricted',
        ownerId: 'oxy-owner',
        status: 'published',
      });
      const subject = { type: 'gizmo', id: widgetId };

      const outcomes = await harness.moderation.enforcement.apply({
        decision: decision({
          revision: 1,
          outcome: 'no_violation',
          findings: [],
          recommendedActions: [],
        }),
        caseId: 'case_effective_label',
        subject,
      });

      // The PLAN named `restore`; the effect said it amounted to nothing.
      expect(outcomes).toContainEqual({
        action: 'restore',
        result: 'recorded',
        recordedAs: 'none',
      });

      /**
       * The claim row keeps the planned action — it is half the idempotency key
       * and it is what was decided — and carries the effective label alongside.
       * Rewriting `action` would make a redelivery claim a different row.
       */
      const [row] = await harness.enforcement.rows();
      expect(row.action).toBe('restore');
      expect(row.recordedAs).toBe('none');
      expect(row.applied).toBe(false);
    });
  });

  describe('one action reversing several', () => {
    it('reads the most recent applied row across the whole declared set', async () => {
      /**
       * `mercaria`'s shape: their `restore` reverses whichever of `restrict`,
       * `request_changes` or `freeze_transaction` actually applied, because on a
       * listing all three are reversible and any of them may be the thing that
       * happened. The harness models it with `restore: ['restrict', 'flag']`.
       *
       * The discriminator is that the two applied rows record DIFFERENT previous
       * states, and the more recent one is not the first entry in the declared
       * list. So the widget's final status says which row was read: the `flag`
       * row carries no `status`, so a correct lookup falls back to `published`,
       * while reading the older `restrict` row would restore `draft`.
       */
      harness = await backend.createHarness();
      const widgetId = await harness.app.createWidget({
        body: 'a draft nobody has seen',
        ownerId: 'oxy-owner',
        status: 'draft',
      });
      const subject = { type: 'widget', id: widgetId };

      // Older applied row: restrict, displacing `draft`.
      expect(
        await harness.moderation.enforcement.apply({
          decision: decision({ revision: 1, recommendedActions: [{ action: 'remove' }] }),
          caseId: CASE_ID,
          subject,
        }),
      ).toEqual([{ action: 'restrict', result: 'applied' }]);

      // NEWER applied row: flag, displacing `flagged: false`.
      expect(
        await harness.moderation.enforcement.apply({
          decision: decision({ revision: 2, recommendedActions: [{ action: 'label' }] }),
          caseId: CASE_ID,
          subject,
        }),
      ).toEqual([{ action: 'flag', result: 'applied' }]);

      const applied = (await harness.enforcement.rows()).filter((row) => row.applied);
      // Oldest first: `restrict` displaced the status, then `flag` displaced the flag.
      expect(applied.map((row) => row.action)).toEqual(['restrict', 'flag']);
      expect(applied[0].previousState).toEqual({ status: 'draft' });
      expect(applied[1].previousState).toEqual({ flagged: false });

      // The correction. Its restore must read the FLAG row, not the restrict one.
      expect(
        await harness.moderation.enforcement.apply({
          decision: decision({
            revision: 3,
            outcome: 'no_violation',
            findings: [],
            recommendedActions: [],
          }),
          caseId: CASE_ID,
          subject,
        }),
      ).toContainEqual({ action: 'restore', result: 'applied' });

      /**
       * `published`, from the harness's fallback, because the newest applied row
       * recorded a flag rather than a status. Reading the older `restrict` row
       * instead would put the widget back to `draft` — the right answer to a
       * question nobody asked, drawn from a row two revisions stale.
       */
      expect((await harness.app.readWidget(widgetId))?.status).toBe('published');
    });
  });

  describe('a correction undoes every reversible action, not just the first', () => {
    it('lifts a label as well as a restriction', async () => {
      /**
       * `mention-finish` found `unlabel_sensitive` fully implemented in Mention,
       * mode-gated, and reachable from NOTHING — the correction fix had been
       * applied to one of two reversible actions. A post hidden and labelled by
       * one revision, then cleared by a correction, came back visible and stayed
       * labelled forever: the appeal succeeded, the warning never lifted, and
       * nothing errored.
       *
       * This package had the same gap. The symptom was even visible here — an
       * earlier test was deleted because `unflag` was "unreachable from the
       * harness's tables", which was read as a fixture quirk. The unreachability
       * WAS the bug.
       */
      harness = await backend.createHarness();
      const widgetId = await harness.app.createWidget({
        body: 'hidden and labelled',
        ownerId: 'oxy-owner',
        status: 'published',
      });
      const subject = { type: 'widget', id: widgetId };

      // One revision does both: restrict and flag.
      await harness.moderation.enforcement.apply({
        decision: decision({ revision: 1, recommendedActions: [{ action: 'label' }] }),
        caseId: CASE_ID,
        subject,
      });
      await harness.moderation.enforcement.apply({
        decision: decision({ revision: 2, recommendedActions: [{ action: 'remove' }] }),
        caseId: CASE_ID,
        subject,
      });
      expect(await harness.app.readWidget(widgetId)).toMatchObject({
        status: 'restricted',
        flagged: true,
      });

      // The correction. BOTH must be undone.
      const outcomes = await harness.moderation.enforcement.apply({
        decision: decision({
          revision: 3,
          outcome: 'no_violation',
          findings: [],
          recommendedActions: [{ action: 'no_action' }],
        }),
        caseId: CASE_ID,
        subject,
      });
      expect(outcomes.map((outcome) => outcome.action).sort()).toEqual([
        'restore',
        'unflag',
      ]);

      /**
       * `flagged: false` is the assertion that bites. Planning only the first
       * declared restore leaves the widget visible and labelled — the exact state
       * an appellant is told they were cleared of.
       */
      expect(await harness.app.readWidget(widgetId)).toMatchObject({
        status: 'published',
        flagged: false,
      });
    });
  });

  describe('the restore dedup is per action, not per set', () => {
    it('still adds the other reversal when one is already recommended', async () => {
      /**
       * The case a whole-set dedup gets wrong, and it is not exotic: a
       * `no_violation` whose recommendation IS one of the restore actions.
       *
       * `restore` arrives from the recommendation table, so it is already in the
       * plan. A dedup asking "is any restore already planned?" then suppresses the
       * ENTIRE set and `unflag` is never added — the same permanent label as the
       * singular bug, reached by a different route and only on decisions that
       * happen to recommend a restore. Asking per action keeps them independent.
       */
      harness = await backend.createHarness();
      const widgetId = await harness.app.createWidget({
        body: 'hidden and labelled',
        ownerId: 'oxy-owner',
        status: 'published',
      });
      const subject = { type: 'widget', id: widgetId };

      await harness.moderation.enforcement.apply({
        decision: decision({ revision: 1, recommendedActions: [{ action: 'label' }] }),
        caseId: CASE_ID,
        subject,
      });
      await harness.moderation.enforcement.apply({
        decision: decision({ revision: 2, recommendedActions: [{ action: 'remove' }] }),
        caseId: CASE_ID,
        subject,
      });

      const outcomes = await harness.moderation.enforcement.apply({
        decision: decision({
          revision: 3,
          outcome: 'no_violation',
          findings: [],
          // The recommendation IS a restore. `unflag` must survive it.
          recommendedActions: [{ action: 'restore' }],
        }),
        caseId: CASE_ID,
        subject,
      });

      expect(outcomes.map((outcome) => outcome.action).sort()).toEqual([
        'restore',
        'unflag',
      ]);
      expect(await harness.app.readWidget(widgetId)).toMatchObject({
        status: 'published',
        flagged: false,
      });
    });
  });

});

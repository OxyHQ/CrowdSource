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
import { createHarness, type Harness } from './support/harness';
import { decision } from './support/decisions';

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

const CASE_ID = 'case_reversal';

describe('a reversal restores what was actually displaced', () => {
  it('reads the applied row, not the newer recorded-only one', async () => {
    harness = await createHarness();
    const widget = await harness.widgets.create({
      body: 'a draft nobody has seen',
      ownerId: 'oxy-owner',
      status: 'draft',
    });
    const subject = { type: 'widget', id: String(widget._id) };

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
    expect((await harness.widgets.findById(widget._id).lean())?.status).toBe('restricted');

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

    const restrictRows = await harness.moderation.models.enforcement
      .find({ subjectType: 'widget', subjectId: subject.id, action: 'restrict' })
      .sort({ createdAt: -1 })
      .lean();
    expect(restrictRows).toHaveLength(2);
    // The two rows disagree, and the newer one is the uninformative one.
    expect(restrictRows[0].applied).toBe(false);
    expect(restrictRows[0].previousState).toBeUndefined();
    expect(restrictRows[1].applied).toBe(true);
    expect(restrictRows[1].previousState).toEqual({ status: 'draft' });

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
    expect(third).toEqual([{ action: 'restore', result: 'applied' }]);

    /**
     * `draft`, not `published`. Reading the newer recorded-only row would hand
     * the effect no `previousState`, and the application's fallback would put a
     * draft into publication — a moderation correction publishing something its
     * author never did.
     */
    expect((await harness.widgets.findById(widget._id).lean())?.status).toBe('draft');
  });

});

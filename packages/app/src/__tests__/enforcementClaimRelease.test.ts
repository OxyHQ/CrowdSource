/**
 * Invariant: a claim whose effect FAILED goes back, so a retry can carry it out.
 *
 * The claim is what makes enforcement exactly-once, and its cost is that a
 * failure has to release it. Keeping it would deduplicate the action away
 * forever: the decision's one chance to act is consumed by an attempt that did
 * nothing, and nothing ever errors again — the outbox retries the event, the
 * executor answers `duplicate`, and the object is never removed.
 *
 * Nothing else in this suite exercises the failing-effect path at all, and the
 * two states it distinguishes look identical from outside: whether the row is
 * gone is only observable by trying the same decision revision again.
 *
 * The row is addressed by its idempotency KEY rather than by a record id, which
 * is what lets both backends release the same row — through Mongo's unique index
 * and through Postgres's composite primary key. A release that matched nothing
 * type-checks perfectly.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { decision } from './support/decisions.js';
import { TEST_ACTIONS, type Harness, type TestAction } from './support/backend.js';
import type { EnforcementEffect, ModerationEnforcementConfig } from '../types.js';
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

  const CASE_ID = 'case_claim_release';

  /**
   * An application whose effect fails while `failing()` says so, and works
   * afterwards. Deliberately not the harness's own enforcement config: this is
   * about the executor's bookkeeping, so the effect does nothing but succeed or
   * throw.
   */
  function unreliableEnforcement(
    failing: () => boolean,
  ): ModerationEnforcementConfig<TestAction> {
    return {
      actions: TEST_ACTIONS,
      noneAction: 'none',
      reviewAction: 'review',
      restoreAction: ['restore', 'unflag'],
      recommendationToAction: { remove: 'restrict' },
      reversibleActions: ['restore', 'unflag'],
      async apply(): Promise<EnforcementEffect<TestAction>> {
        if (failing()) throw new Error('the effect failed');
        return { changed: true, previousState: { status: 'published' } };
      },
    };
  }

  describe('an enforcement effect that throws', () => {
    it('releases its claim, so the same decision revision can be applied on a retry', async () => {
      let failing = true;
      harness = await backend.createHarness({ enforcement: unreliableEnforcement(() => failing) });
      const subject = { type: 'widget', id: harness.app.absentId() };
      const violation = decision({
        revision: 1,
        outcome: 'violation',
        recommendedActions: [{ action: 'remove' }],
      });

      await expect(
        harness.moderation.enforcement.apply({
          decision: violation,
          caseId: CASE_ID,
          subject,
        }),
      ).rejects.toThrow('the effect failed');

      // The claim is gone: no row survives an attempt that changed nothing.
      expect(await harness.enforcement.rows()).toHaveLength(0);

      /**
       * The assertion that bites. A release that matched no row leaves the claim
       * in place, and this second attempt answers `duplicate` — the outbox
       * completes the event, the decision is recorded as handled, and the effect
       * never happens.
       */
      failing = false;
      const outcomes = await harness.moderation.enforcement.apply({
        decision: violation,
        caseId: CASE_ID,
        subject,
      });
      expect(outcomes).toEqual([{ action: 'restrict', result: 'applied' }]);

      const rows = await harness.enforcement.rows();
      expect(rows).toHaveLength(1);
      expect(rows[0].applied).toBe(true);
      expect(rows[0].previousState).toEqual({ status: 'published' });
    });
  });

});

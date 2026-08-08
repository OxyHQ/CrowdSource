/**
 * Invariant: a claimed event carries the identity its own lease is completed by.
 *
 * The store maps its primary key onto `ModerationOutboxEvent.id`, and EVERY
 * lease transition — the heartbeat's renewal, the completion, the failure
 * release — addresses the row by that one value. A mapping that produced
 * anything else is not a type error and is invisible on the happy path: the
 * report is still delivered, the reporter still gets a case, and only the
 * completion silently matches no row. The event then sits in `processing` until
 * its lease expires and is delivered AGAIN, forever, with nothing failing.
 *
 * That is why this file asserts the identity itself rather than the delivery it
 * enables — an end-to-end test of the loop passes with the mapping broken,
 * because everything it looks at has already happened by then.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Harness } from './support/backend.js';
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

  const LEASE_OWNER = 'moderation:test-owner';

  async function enqueue(current: Harness, eventId: string): Promise<void> {
    await current.transaction.run(async (write) => {
      await write({ eventId, kind: 'report.submit', payload: { reportId: 'claim-lease' } });
    });
  }

  describe('claiming an outbox event', () => {
    it('returns the event under the id its lease transitions are addressed by', async () => {
      harness = await backend.createHarness();
      const eventId = 'moderation:report.submit:claim-carries-its-id';
      await enqueue(harness, eventId);

      const claimed = await harness.outbox.claim({ leaseOwner: LEASE_OWNER });
      if (claimed === null) throw new Error('the due event was not claimed');

      expect(claimed.id).toBe(eventId);
      expect(claimed.kind).toBe('report.submit');
      expect(claimed.payload.reportId).toBe('claim-lease');
      // The claim is what counts an attempt, so a retry ceiling can be reached.
      expect(claimed.attempts).toBe(1);

      // The round trip: the id that came back is the one that completes the lease.
      expect(await harness.outbox.complete(claimed.id, LEASE_OWNER)).toBe(true);
      const row = await harness.outbox.read(eventId);
      expect(row?.status).toBe('processed');
      expect(row?.leaseOwner).toBeNull();
    });

    it('does not hand the same event to a second claim', async () => {
      harness = await backend.createHarness();
      const eventId = 'moderation:report.submit:claimed-once';
      await enqueue(harness, eventId);

      const first = await harness.outbox.claim({ leaseOwner: LEASE_OWNER });
      expect(first?.id).toBe(eventId);
      /**
       * The live lease is what holds the second worker off. Without the claim
       * being atomic — a read of what is due, then a write — both would take it
       * and one report would be delivered twice.
       */
      expect(await harness.outbox.claim({ leaseOwner: 'another-task' })).toBeNull();
    });
  });

});

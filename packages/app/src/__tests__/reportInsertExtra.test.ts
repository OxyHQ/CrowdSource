/**
 * Invariant: an application's own columns are stored, and cannot overwrite the
 * fields this package owns.
 *
 * `CreateReportInput.extra` exists so an adopter can store its own columns on
 * the report it already had — a tenant id, a source, a legacy verdict. It is
 * spread FIRST, and the ordering is the guard: spread last, an `extra` carrying
 * `localStatus` decides whether the report is queued, while intake's own answer
 * — computed from whether the reported type has a subject provider — is thrown
 * away. The report then reads `closed` with a live delivery event behind it, or
 * `queued` with nothing that will ever deliver it, and neither is an error
 * anything reports.
 *
 * The first assertion below passes under both orderings. Only the second and
 * third can tell them apart, which is why the fixture sends a key this package
 * owns rather than only an innocuous one.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { reportSubmitEventId } from '../outbox/service.js';
import { createHarness, type Harness } from './support/harness.js';

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("intake stores the application's own fields", () => {
  it('keeps them out of the fields this package decides', async () => {
    harness = await createHarness();
    const widget = await harness.widgets.create({ body: 'hello', ownerId: 'oxy-owner' });

    const { report } = await harness.moderation.createReport({
      reporter: 'oxy-reporter',
      reportedType: 'widget',
      reportedId: String(widget._id),
      categories: ['spam'],
      extra: {
        // The adopter's own column, which must land…
        legacyStatus: 'triaged',
        // …and one of this package's, which must not.
        localStatus: 'closed',
      },
    });

    const stored = await harness.reports.findById(report.id).lean();
    expect(stored?.legacyStatus).toBe('triaged');
    expect(stored?.localStatus).toBe('queued');

    /**
     * And the status is not merely a label: the delivery event intake committed
     * in the same transaction is what `queued` means, so a report that took its
     * status from `extra` would be inconsistent with the row beside it.
     */
    const event = await harness.moderation.models.outbox
      .findById(reportSubmitEventId(report.id))
      .lean();
    expect(event?.status).toBe('pending');
  });
});

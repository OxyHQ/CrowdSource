/**
 * Invariant: `taxonomy.metadata` is opt-in and cannot shadow the two keys this
 * package owns.
 *
 * Metadata rides in the `ReportInput`, the SDK derives the case envelope from
 * it, and ingress fingerprints that envelope to detect "same external id,
 * different body". So a metadata change IS an envelope change, and that makes
 * both properties below load-bearing rather than tidy:
 *
 * 1. **An adopter that sets nothing must emit exactly what it emitted before
 *    this field existed.** A default that added a key would turn every other
 *    adopter's in-flight retries into a permanent 409 — days later, as reports
 *    silently stuck in a queue — for a feature none of them asked for.
 * 2. **`taxonomyVersion` and `categories` cannot be overwritten.** A case has to
 *    be readable back against the mapping that produced it, and that is not
 *    negotiable per application.
 *
 * Harness-free on purpose: `buildModerationReportInput` takes a report, a
 * registry and a taxonomy, and touches no store at all. The property is about
 * what goes on the wire, so the test asks the function that composes it rather
 * than driving a database to observe it three layers away.
 */

import { describe, expect, it } from 'vitest';
import { buildModerationReportInput, createSubjectRegistry } from '../evidence.js';
import type { ModerationSubjectProvider, ModerationTaxonomy } from '../types.js';

const provider: ModerationSubjectProvider = {
  reportedType: 'widget',
  subjectType: 'custom.test.widget',
  async snapshot(reportedId) {
    return {
      subject: { externalId: reportedId, type: 'custom.test.widget' },
      content: 'buy cheap watches',
    };
  },
};

const report = {
  id: 'report-1',
  reportedType: 'widget',
  reportedId: 'widget-1',
  reporter: 'oxy-reporter',
  categories: ['spam'],
  createdAt: new Date('2026-08-08T12:00:00.000Z'),
};

async function metadataFor(taxonomy: ModerationTaxonomy): Promise<Record<string, unknown>> {
  const built = await buildModerationReportInput({
    report,
    registry: createSubjectRegistry([provider]),
    taxonomy,
  });
  if (built === null) throw new Error('the provider returned no snapshot');
  return { ...built.reportInput.metadata };
}

const BASE: ModerationTaxonomy = {
  version: '2026.07',
  allegationsFor: () => ['integrity.spam'],
};

describe('taxonomy metadata', () => {
  /**
   * The compatibility floor. Asserted as an EXACT key set rather than with
   * `toMatchObject`, which would pass with an extra key present — and an extra
   * key is precisely the failure this test exists to prevent.
   */
  it('adds nothing when an adopter declares none', async () => {
    expect(await metadataFor(BASE)).toEqual({
      taxonomyVersion: '2026.07',
      categories: 'spam',
    });
  });

  it("carries the adopter's own entries", async () => {
    expect(
      await metadataFor({ ...BASE, metadata: { evidenceAttachmentsSupported: false } }),
    ).toEqual({
      taxonomyVersion: '2026.07',
      categories: 'spam',
      evidenceAttachmentsSupported: false,
    });
  });

  /**
   * The fixture that can tell the two merge ORDERS apart.
   *
   * Both keys are sent with wrong values that are still well-typed, so a merge
   * spreading the adopter's entries last would produce a report readable back
   * against a mapping that never existed. The test above cannot see the
   * difference — this one is the only reason the spread order is checked at all.
   */
  it('cannot be shadowed by an adopter using the reserved names', async () => {
    expect(
      await metadataFor({
        ...BASE,
        metadata: { taxonomyVersion: 'not-a-version', categories: 'not-the-categories' },
      }),
    ).toEqual({
      taxonomyVersion: '2026.07',
      categories: 'spam',
    });
  });
});

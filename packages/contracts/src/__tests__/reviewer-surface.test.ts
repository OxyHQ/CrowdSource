import { describe, expect, it } from 'vitest';

import {
  AssignmentPackageSchema,
  RESOURCE_TYPES,
  REVIEWER_SENSITIVITY_CLASSES,
  REVIEWER_STATES,
  ResourceSchema,
  ReviewerCalibrationSubmissionSchema,
  ReviewerPreferencesUpdateSchema,
  ReviewerResourceSchema,
  ReviewHistoryQuerySchema,
  type ReviewerResource,
  type ReviewerResourceOf,
  type Resource,
} from '../index.js';

/**
 * The reviewer wire surface, checked against itself and against the envelope.
 *
 * Every shape here is a Zod schema whose TypeScript type is `z.infer` of it, so
 * "the type and the schema disagree" is not a failure this file has to test for —
 * there is one declaration. What it does test is the two things a single
 * declaration cannot protect:
 *
 *  1. The reviewer resource union is WRITTEN OUT while the envelope's `Resource`
 *     union is the source of truth for what material exists. A new resource type
 *     in `resources.ts` would otherwise parse as an unknown discriminator and the
 *     material would silently never reach a jury.
 *  2. §9.1's hidden column has no field on any shape, which only means anything
 *     if the parse REFUSES those fields rather than dropping them.
 *
 * The backend↔app payload test lives in the backend suite, where a real HTTP
 * response can be produced and fed to the app's real projection. This file is the
 * cheaper half: it cannot see whether either side actually uses these shapes, so
 * it does not pretend to.
 */

/**
 * True when `A` and `B` are assignable in both directions.
 *
 * Mutual assignability rather than strict identity, deliberately. Identity — the
 * `(<T>() => T extends A ? 1 : 2)` trick — also reports a difference between
 * `Omit<X, 'k'> & { a: A }` and the flattened object with the same members, which
 * is precisely the shape `ReviewerResourceOf` produces and is not a difference
 * anybody needs to act on. A check that fails for a reason nobody can fix is a
 * check somebody deletes; this one fails only for a missing variant, an extra
 * field or a changed type, which are the failures that matter.
 *
 * `[A] extends [B]` wraps both sides in tuples so a union is compared as a whole
 * rather than distributed member by member — without the tuples, a union that had
 * LOST a variant would still satisfy the check.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe('the reviewer resource union follows the envelope', () => {
  it('covers every resource type the envelope can carry', () => {
    /**
     * The vacuity floor for this whole block. Twelve is not a magic number — it
     * is `RESOURCE_TYPES.length`, asserted so a traversal that silently returned
     * nothing could not read as agreement between two empty lists.
     */
    const reviewerTypes = ReviewerResourceSchema.options.map((option) => option.shape.type.value);
    expect(reviewerTypes.length).toBe(RESOURCE_TYPES.length);
    expect(reviewerTypes.length).toBeGreaterThan(1);
    expect([...reviewerTypes].sort()).toEqual([...RESOURCE_TYPES].sort());
  });

  /**
   * The base fields, compared against the envelope's own resources.
   *
   * A field added to `resourceBaseShape` in `resources.ts` — a new provenance
   * marker, say — would otherwise be stripped from the reviewer's view by
   * omission, with nothing failing. `sha256` is the one deliberate difference: it
   * pins the case to the exact bytes reported, which the case verifies and a
   * reviewer does not.
   */
  it('carries every base field of an envelope resource except the digest', () => {
    const envelopeText = ResourceSchema.options.find(
      (option) => option.shape.type.value === 'text',
    );
    const reviewerText = ReviewerResourceSchema.options.find(
      (option) => option.shape.type.value === 'text',
    );
    expect(envelopeText).toBeDefined();
    expect(reviewerText).toBeDefined();

    const envelopeKeys = Object.keys(envelopeText?.shape ?? {})
      .filter((key) => key !== 'sha256')
      .sort();
    expect(envelopeKeys.length).toBeGreaterThan(3);
    expect(Object.keys(reviewerText?.shape ?? {}).sort()).toEqual(envelopeKeys);
  });

  /**
   * And the type-level half: what the written union infers must be what the
   * envelope union implies.
   *
   * A hand-rolled check rather than `expectTypeOf().toEqualTypeOf()`, because
   * vitest's helper collapses a discriminated union of objects with disjoint keys
   * into one object type with `data: never` and then fails on its own constraint
   * — it cannot express this comparison at all.
   *
   * The failure lands at TYPECHECK time on the `= true`, before any payload
   * exists to notice a mismatch with. The runtime assertion below it is there so
   * the test cannot pass while doing nothing.
   */
  it('infers the same shape the envelope union implies', () => {
    const unionMatchesEnvelope: MutuallyAssignable<
      ReviewerResource,
      ReviewerResourceOf<Resource>
    > = true;
    expect(unionMatchesEnvelope).toBe(true);
  });
});

describe('§9.1 — the hidden column is refused, not ignored', () => {
  function assignment(): unknown {
    return {
      assignmentId: 'asg_1',
      caseRevision: 1,
      expiresAt: '2026-07-30T00:00:00.000Z',
      language: 'es',
      families: ['harassment'],
      allegations: { unverified: true, codes: ['harassment.targeted_abuse'] },
      policy: {
        policySetId: 'crowdsource.baseline',
        version: '2026.1.0',
        taxonomyVersion: '2026.1',
        rules: [],
      },
      presentation: {
        sensitivityClass: 'standard',
        requiresRedaction: false,
        blurBeforeReveal: false,
      },
      resources: [],
      relations: [],
      watermark: 'aaaa-bbbb-cccc',
    };
  }

  it('accepts the package as the backend builds it', () => {
    expect(AssignmentPackageSchema.safeParse(assignment()).success).toBe(true);
  });

  /**
   * One case per row of §9.1's "Ocultar" column. A lenient parse would let every
   * one of these onto a screen; `.strict()` is what turns each into a refusal.
   */
  it.each([
    ['the number of reports', { reportCount: 42 }],
    ['the reporter', { reporterId: 'user_9' }],
    ["the author's reputation", { authorReputation: 0.2 }],
    ['a partial result', { partialOutcome: 'violation' }],
    ['a vote tally', { votes: { violation: 2, no_violation: 1 } }],
    ['the other jurors', { jurors: ['rvw_a', 'rvw_b'] }],
    ["the application's brand", { applicationName: 'Mention' }],
    ['the case id, which would become a URL', { caseId: 'case_1' }],
  ])('refuses %s', (_label, extra) => {
    const result = AssignmentPackageSchema.safeParse({ ...(assignment() as object), ...extra });
    expect(result.success).toBe(false);
  });

  it('refuses a reputation smuggled inside a resource', () => {
    const result = AssignmentPackageSchema.safeParse({
      ...(assignment() as object),
      resources: [
        {
          id: 'res_post',
          type: 'text',
          role: 'subject',
          data: { text: 'reported text' },
          authorReputation: 0.9,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  /**
   * The asset locator is the §9.1 leak that was actually live: a URL on the
   * reporting application's own host, sent straight to the review screen. The
   * reviewer surface has no field for it at all.
   */
  it('refuses an asset locator, which names the application that reported', () => {
    expect(
      ReviewerResourceSchema.safeParse({
        id: 'res_image',
        type: 'image',
        role: 'subject',
        asset: {
          mediaType: 'image/png',
          retrievable: true,
          url: 'https://cdn.example-app.test/photo.png',
        },
      }).success,
    ).toBe(false);
  });

  it('accepts an asset as a bare Oxy file id', () => {
    expect(
      ReviewerResourceSchema.safeParse({
        id: 'res_image',
        type: 'image',
        role: 'subject',
        asset: { mediaType: 'image/png', retrievable: true, fileId: 'file_abc' },
      }).success,
    ).toBe(true);
  });

  it('accepts an unretrievable asset rather than dropping the resource', () => {
    // A jury must know material existed even when CrowdSource cannot serve it —
    // which is what `content_unavailable` is an outcome for.
    expect(
      ReviewerResourceSchema.safeParse({
        id: 'res_image',
        type: 'image',
        role: 'subject',
        asset: { mediaType: 'image/png', retrievable: false },
      }).success,
    ).toBe(true);
  });

  it('refuses the resource digest, which the case verifies and a reviewer does not', () => {
    expect(
      ReviewerResourceSchema.safeParse({
        id: 'res_post',
        type: 'text',
        role: 'subject',
        data: { text: 'reported text' },
        sha256: `sha256:${'a'.repeat(64)}`,
      }).success,
    ).toBe(false);
  });
});

describe('§7.5 — prohibited material has no reviewer-facing representation', () => {
  it('is absent from the consentable vocabulary', () => {
    expect(REVIEWER_SENSITIVITY_CLASSES).not.toContain('prohibited');
  });

  it('is refused on the wire', () => {
    expect(packageAccepts('standard')).toBe(true);
    expect(packageAccepts('prohibited')).toBe(false);
  });

  function packageAccepts(sensitivity: string): boolean {
    return AssignmentPackageSchema.safeParse({
      assignmentId: 'asg_1',
      caseRevision: 1,
      expiresAt: '2026-07-30T00:00:00.000Z',
      language: null,
      families: [],
      allegations: { unverified: true, codes: [] },
      policy: {
        policySetId: 'crowdsource.baseline',
        version: '2026.1.0',
        taxonomyVersion: '2026.1',
        rules: [],
      },
      presentation: { sensitivityClass: sensitivity, requiresRedaction: false, blurBeforeReveal: false },
      resources: [],
      relations: [],
      watermark: null,
    }).success;
  }
});

describe('§8.1 — the state vocabulary', () => {
  /**
   * The drift this whole module exists to prevent. The app used to declare
   * `community_reviewer`, `trusted_reviewer`, `category_specialist` and
   * `appeals_reviewer`; the backend persisted `community`, `trusted`,
   * `specialist` and `appeals`. Naming the losers explicitly is what makes this
   * assertion fail if either spelling comes back.
   */
  it('is the short form, with no `_reviewer` suffix anywhere', () => {
    expect([...REVIEWER_STATES]).toEqual([
      'applicant',
      'calibrating',
      'community',
      'trusted',
      'specialist',
      'appeals',
      'suspended',
    ]);
    for (const retired of [
      'community_reviewer',
      'trusted_reviewer',
      'category_specialist',
      'appeals_reviewer',
    ]) {
      expect(REVIEWER_STATES).not.toContain(retired);
    }
  });
});

describe('inbound bodies refuse what would promote a reviewer', () => {
  it.each([
    ['their own state', { state: 'trusted' }],
    ['their personhood score', { personhoodConfidence: 1 }],
    ['their reliability', { reliabilityByCategory: { harassment: 1 } }],
    ['their review count', { completedReviewCount: 500 }],
    ['their place in the draw window', { samplingKey: 0.1 }],
  ])('refuses a preferences body setting %s', (_label, body) => {
    expect(ReviewerPreferencesUpdateSchema.safeParse(body).success).toBe(false);
  });

  it('refuses an empty preferences body rather than accepting a no-op', () => {
    expect(ReviewerPreferencesUpdateSchema.safeParse({}).success).toBe(false);
  });

  it('refuses un-accepting the reviewing rules', () => {
    expect(ReviewerPreferencesUpdateSchema.safeParse({ rulesAccepted: true }).success).toBe(true);
    expect(ReviewerPreferencesUpdateSchema.safeParse({ rulesAccepted: false }).success).toBe(false);
  });

  it('refuses a calibration answer that carries its own grade', () => {
    expect(
      ReviewerCalibrationSubmissionSchema.safeParse({
        answers: [{ itemId: 'cal_1', violation: true, correct: true }],
      }).success,
    ).toBe(false);
  });

  it('bounds the history page size', () => {
    expect(ReviewHistoryQuerySchema.safeParse({ limit: '20' }).data?.limit).toBe(20);
    expect(ReviewHistoryQuerySchema.safeParse({ limit: 5_000 }).success).toBe(false);
  });
});

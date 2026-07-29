import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { TaxonomyFamily } from '@oxyhq/crowdsource-contracts';

import { TRAINING_MODULES } from '../../modules/reviewer/calibration';
import { personhoodConfidence } from '../../modules/reviewer/personhood';
import {
  reviewerProfiles,
  type ReviewerPrincipalLink,
  type ReviewerProfileDocument,
} from '../../modules/reviewer/reviewer.collection';
import type { ReviewerState } from '../../modules/reviewer/reviewerState';

/**
 * Support for the reviewer and sortition integration tests.
 *
 * ## Reviewer profiles are GLOBAL, and that shapes every test here
 *
 * A case belongs to one tenant; a reviewer belongs to none. So a reviewer this
 * file creates is a candidate for every case in the database, including the ones
 * other test files are running concurrently against the same replica set. A
 * panel that quietly drew somebody else's reviewers would make two suites fail
 * each other in ways that look like a broken selector.
 *
 * The isolation is therefore the TAXONOMY FAMILY. Every helper takes the family
 * its reviewers accept, and each test file picks one no other file's cases
 * allege — a reviewer is only eligible for a case whose every alleged family
 * they accept (§8.2), so a `commerce` reviewer is never drawn for a `harassment`
 * case. That is the same mechanism the product uses, which is the point: the
 * test isolation is the feature, not a fixture trick.
 */

/**
 * Stands in for `createOptionalOxyAuth` in the integration tests.
 *
 * It replaces exactly one thing: the network call that asks Oxy whether a bearer
 * token is a real session. Everything downstream is the real code — the missing
 * session still produces this service's own `401` through `requireReviewerSession`,
 * and the profile is still created and resolved by `ensureReviewerProfile`. So
 * the AUTHORISATION rules this phase owns are exercised for real, and only the
 * AUTHENTICATION that belongs to `@oxyhq/core` is stubbed.
 */
export function stubOxySession(): RequestHandler {
  return (request, _response, next) => {
    const userId = request.get('x-test-oxy-user');
    if (userId) {
      Reflect.set(request, 'userId', userId);
      Reflect.set(request, 'user', {
        id: userId,
        verified: request.get('x-test-oxy-verified') === 'true',
      });
    }
    next();
  };
}

export interface ReviewerFixture {
  readonly reviewerId: string;
  readonly oxyUserId: string;
}

export interface CreateReviewerOptions {
  /** The family this reviewer accepts. The isolation axis — see above. */
  readonly family: TaxonomyFamily;
  readonly state?: ReviewerState;
  readonly reliability?: number;
  readonly completedReviewCount?: number;
  readonly languages?: readonly string[];
  readonly specialistCategories?: readonly TaxonomyFamily[];
  readonly riskClusterId?: string | null;
  readonly principalLinks?: readonly ReviewerPrincipalLink[];
  readonly declaredConflictApplications?: readonly string[];
  readonly available?: boolean;
  readonly maxSensitivityRank?: number;
  readonly consentedSensitiveCategories?: readonly TaxonomyFamily[];
  readonly samplingKey?: number;
}

/**
 * A reviewer who is eligible by default.
 *
 * Written straight to the collection rather than driven through the onboarding
 * routes, because the tests that USE this are about the draw. The onboarding
 * path — applicant to calibrating to community, and the personhood score that
 * gate depends on — is exercised end to end by `reviewerOnboarding.integration.test.ts`,
 * and `personhoodConfidence` is called here rather than hard-coded so a fixture
 * cannot claim an eligibility the real rules would not grant.
 */
export async function createReviewer(
  options: CreateReviewerOptions,
): Promise<ReviewerFixture> {
  const now = new Date();
  const reviewerId = `rvw_${randomUUID().replace(/-/g, '')}`;
  const oxyUserId = `oxy_${randomUUID().replace(/-/g, '')}`;

  const document: ReviewerProfileDocument = {
    reviewerId,
    oxyUserId,
    state: options.state ?? 'community',
    accountActive: true,
    oxyAccountVerified: false,
    isAdult: true,
    suspectedSockPuppet: false,
    riskClusterId: options.riskClusterId ?? null,
    languages: [...(options.languages ?? ['es'])],
    categories: [options.family],
    specialistCategories: [...(options.specialistCategories ?? [])],
    maxSensitivityRank: options.maxSensitivityRank ?? 0,
    consentedSensitiveCategories: [...(options.consentedSensitiveCategories ?? [])],
    declaredConflictApplications: [...(options.declaredConflictApplications ?? [])],
    available: options.available ?? true,
    dailyReviewLimit: 20,
    trainingCompletedModules: TRAINING_MODULES.map((module) => module.moduleId),
    trainingCompletedAt: now,
    calibrationPassedAt: now,
    calibrationScore: 0.9,
    calibrationAttempts: 1,
    lastCalibrationAt: now,
    reliabilityByCategory: { [options.family]: options.reliability ?? 0.9 },
    completedReviewCount: options.completedReviewCount ?? 0,
    // Derived, never asserted: a fixture that hard-coded this could grant itself
    // an eligibility the real rules refuse.
    personhoodConfidence: personhoodConfidence({
      accountActive: true,
      oxyAccountVerified: false,
      trainingCompletedAt: now,
      calibrationPassedAt: now,
      suspectedSockPuppet: false,
    }),
    samplingKey: options.samplingKey ?? Math.random(),
    principalLinks: [...(options.principalLinks ?? [])],
    suspendedUntil: null,
    createdAt: now,
    updatedAt: now,
  };

  await reviewerProfiles.insertOne(document);
  return { reviewerId, oxyUserId };
}

/**
 * A pool big enough for a round-1 panel with room to spare.
 *
 * Two thirds are reliable and experienced, one third are calibrated newcomers,
 * so §8.3's slots all have somebody to draw from and a panel that ignored slots
 * would be visible.
 */
export async function createReviewerPool(
  family: TaxonomyFamily,
  size: number,
): Promise<ReviewerFixture[]> {
  const created: ReviewerFixture[] = [];
  for (let index = 0; index < size; index += 1) {
    created.push(
      await createReviewer({
        family,
        reliability: index % 3 === 2 ? 0.4 : 0.9,
        completedReviewCount: index % 3 === 2 ? 0 : 40,
      }),
    );
  }
  return created;
}

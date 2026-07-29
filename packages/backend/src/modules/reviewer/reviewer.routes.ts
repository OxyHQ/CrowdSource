import { Router } from 'express';
import { z } from 'zod';
import { TAXONOMY_FAMILIES, TaxonomyCodeSchema } from '@oxyhq/crowdsource-contracts';

import { ApiError } from '../../http/apiError';
import { CONSENTABLE_SENSITIVITY, type ReviewerProfileDocument } from './reviewer.collection';
import { DAILY_REVIEW_LIMIT_MAX } from './reviewer.service';
import {
  completeTrainingModule,
  submitCalibration,
  trainingView,
  updateReviewerPreferences,
} from './reviewer.service';
import { requestReviewer, requireReviewerSession } from './reviewerAuth';

/**
 * The reviewer's own profile, preferences and training (§10.3).
 *
 * Everything here is about the person asking; nothing here is about a case. The
 * reviewer id comes from the authenticated session and is never a parameter, so
 * there is no route on which one reviewer could read or change another's
 * eligibility.
 *
 * `GET /v1/reviewer/profile` shows §10.3's "eligibility, categories and PRIVATE
 * reliability" — private meaning it is shown to its owner and to nobody else.
 * §9.1 forbids a reviewer seeing another juror's anything, and §13.7's consent
 * model only works if a person can see what they consented to.
 */

export const reviewerRouter: Router = Router();

const TaxonomyFamilySchema = z.enum(TAXONOMY_FAMILIES);

/**
 * Preferences, parsed strictly.
 *
 * `.strict()` matters more here than anywhere else on this surface: `state`,
 * `personhoodConfidence`, `reliabilityByCategory` and `completedReviewCount` are
 * the fields that decide who sits on a jury, and a lenient schema plus a
 * spread-based update is exactly how a reviewer would promote themselves. The
 * schema refuses unknown keys and the service takes named arguments, so there
 * are two independent reasons it cannot happen.
 */
const PreferencesSchema = z
  .strictObject({
    languages: z.array(z.string().min(2).max(16)).max(20).optional(),
    categories: z.array(TaxonomyFamilySchema).max(TAXONOMY_FAMILIES.length).optional(),
    isAdult: z.boolean().optional(),
    available: z.boolean().optional(),
    dailyReviewLimit: z.number().int().min(1).max(DAILY_REVIEW_LIMIT_MAX).optional(),
    maxSensitivity: z.enum(CONSENTABLE_SENSITIVITY).optional(),
    consentedSensitiveCategories: z
      .array(TaxonomyFamilySchema)
      .max(TAXONOMY_FAMILIES.length)
      .optional(),
    declaredConflictApplications: z.array(z.string().min(1).max(64)).max(50).optional(),
    principalLinks: z
      .array(
        z.strictObject({
          applicationId: z.string().min(1).max(64),
          externalPrincipalId: z.string().min(1).max(256),
        }),
      )
      .max(50)
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'a preferences update must change at least one field',
  });

const CalibrationSchema = z.strictObject({
  answers: z
    .array(
      z.strictObject({
        itemId: z.string().min(1).max(64),
        violation: z.boolean(),
        code: TaxonomyCodeSchema.optional(),
      }),
    )
    .min(1)
    .max(64),
});

function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('invalid_request', 'The request body is not valid.', {
      issues: parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
        .slice(0, 500),
    });
  }
  return parsed.data;
}

/**
 * What a reviewer may see about themselves.
 *
 * A projection rather than the document, and the omissions are deliberate:
 * `samplingKey` is how the draw windows the population and publishing it would
 * let somebody reason about when they are likely to be considered;
 * `oxyUserId` is the identity this service keeps separate from `reviewerId` on
 * purpose (§8.7); `riskClusterId` and `suspectedSockPuppet` are anti-abuse
 * signals, and telling somebody they are flagged tells them to change what they
 * are doing.
 */
function profileView(profile: ReviewerProfileDocument) {
  return {
    reviewerId: profile.reviewerId,
    state: profile.state,
    languages: profile.languages,
    categories: profile.categories,
    specialistCategories: profile.specialistCategories,
    maxSensitivityRank: profile.maxSensitivityRank,
    consentedSensitiveCategories: profile.consentedSensitiveCategories,
    declaredConflictApplications: profile.declaredConflictApplications,
    principalLinks: profile.principalLinks,
    isAdult: profile.isAdult,
    available: profile.available,
    dailyReviewLimit: profile.dailyReviewLimit,
    personhoodConfidence: profile.personhoodConfidence,
    reliabilityByCategory: profile.reliabilityByCategory,
    completedReviewCount: profile.completedReviewCount,
    trainingCompletedModules: profile.trainingCompletedModules,
    calibrationPassedAt: profile.calibrationPassedAt?.toISOString() ?? null,
    calibrationScore: profile.calibrationScore,
  };
}

reviewerRouter.get('/reviewer/profile', ...requireReviewerSession(), (request, response) => {
  response.status(200).json(profileView(requestReviewer(request)));
});

reviewerRouter.post('/reviewer/preferences', ...requireReviewerSession(), async (request, response) => {
  const preferences = parseOrThrow(PreferencesSchema, request.body);
  const updated = await updateReviewerPreferences(
    requestReviewer(request).reviewerId,
    preferences,
  );
  response.status(200).json(profileView(updated));
});

reviewerRouter.get('/reviewer/training', ...requireReviewerSession(), (request, response) => {
  const view = trainingView(requestReviewer(request));
  response.status(200).json({
    ...view,
    calibrationPassedAt: view.calibrationPassedAt?.toISOString() ?? null,
  });
});

reviewerRouter.post(
  '/reviewer/training/:moduleId/complete',
  ...requireReviewerSession(),
  async (request, response) => {
    const moduleId = request.params.moduleId;
    if (typeof moduleId !== 'string') {
      throw new ApiError('not_found', 'No such training module.');
    }
    const updated = await completeTrainingModule(requestReviewer(request).reviewerId, moduleId);
    response.status(200).json(profileView(updated));
  },
);

reviewerRouter.post(
  '/reviewer/training/calibration',
  ...requireReviewerSession(),
  async (request, response) => {
    const body = parseOrThrow(CalibrationSchema, request.body);
    const { result, profile } = await submitCalibration(
      requestReviewer(request).reviewerId,
      body.answers,
    );

    /**
     * The score and which items were wrong, never which answer was right. A
     * calibration that hands back the answer key is one everybody passes on the
     * second attempt, which measures attendance rather than judgement.
     */
    response.status(200).json({
      passed: result.passed,
      score: result.score,
      incorrectItemIds: result.incorrectItemIds,
      state: profile.state,
    });
  },
);

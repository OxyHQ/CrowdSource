import { Router } from 'express';
import {
  ReviewerCalibrationSubmissionSchema,
  ReviewerPreferencesUpdateSchema,
  type ReviewerCalibrationResultView,
} from '@oxyhq/crowdsource-contracts';

import { ApiError } from '../../http/apiError';
import { parseOrThrow } from '../../http/parseBody';
import { reviewerExposure } from '../sortition/exposure';
import {
  completeTrainingModule,
  submitCalibration,
  updateReviewerPreferences,
} from './reviewer.service';
import { requestReviewer, requireReviewerSession } from './reviewerAuth';
import { reviewerProfileView, reviewerTrainingView } from './reviewerViews';

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
 * model only works if a person can see what they consented to. What is shown and
 * what is withheld is decided in `reviewerViews.ts`, once, as a pure function
 * over the document.
 *
 * ## There is no `POST /v1/reviewer/onboarding`
 *
 * §4.1's onboarding screen submits `POST /v1/reviewer/preferences`, and that is
 * not a compromise: §10.3's route table has seven reviewer endpoints and no
 * onboarding among them, and everything the screen collects — languages,
 * categories, sensitive consent, age — is precisely what §10.3 says this route
 * updates. Rules acceptance is the one thing that had no home, so it became a
 * field on this body rather than a route of its own. A second endpoint writing
 * the same fields would be a second place the adult-attestation refusal below
 * has to be remembered.
 */

export const reviewerRouter: Router = Router();

reviewerRouter.get('/reviewer/profile', ...requireReviewerSession(), async (request, response) => {
  const profile = requestReviewer(request);
  const now = new Date();
  response
    .status(200)
    .json(reviewerProfileView(profile, await reviewerExposure(profile.reviewerId, now), now));
});

reviewerRouter.post(
  '/reviewer/preferences',
  ...requireReviewerSession(),
  async (request, response) => {
    const preferences = parseOrThrow(
      ReviewerPreferencesUpdateSchema,
      request.body,
      'The request body is not valid.',
    );
    const updated = await updateReviewerPreferences(
      requestReviewer(request).reviewerId,
      preferences,
    );
    const now = new Date();
    response
      .status(200)
      .json(reviewerProfileView(updated, await reviewerExposure(updated.reviewerId, now), now));
  },
);

reviewerRouter.get('/reviewer/training', ...requireReviewerSession(), (request, response) => {
  response.status(200).json(reviewerTrainingView(requestReviewer(request)));
});

reviewerRouter.post(
  '/reviewer/training/:moduleId/complete',
  ...requireReviewerSession(),
  async (request, response) => {
    const moduleId = request.params.moduleId;
    if (typeof moduleId !== 'string') {
      throw new ApiError('not_found', 'No such training module.');
    }
    /**
     * The UPDATED document, never `requestReviewer` again: the authenticated
     * profile was resolved before this handler ran and would render the module
     * still incomplete — the one thing the caller is asking about.
     */
    const updated = await completeTrainingModule(requestReviewer(request).reviewerId, moduleId);
    response.status(200).json(reviewerTrainingView(updated));
  },
);

reviewerRouter.post(
  '/reviewer/training/calibration',
  ...requireReviewerSession(),
  async (request, response) => {
    const body = parseOrThrow(
      ReviewerCalibrationSubmissionSchema,
      request.body,
      'The request body is not valid.',
    );
    const { result, profile } = await submitCalibration(
      requestReviewer(request).reviewerId,
      body.answers,
    );

    /**
     * The score and which items were wrong, never which answer was right. A
     * calibration that hands back the answer key is one everybody passes on the
     * second attempt, which measures attendance rather than judgement.
     */
    const view: ReviewerCalibrationResultView = {
      passed: result.passed,
      score: result.score,
      incorrectItemIds: [...result.incorrectItemIds],
      state: profile.state,
    };
    response.status(200).json(view);
  },
);

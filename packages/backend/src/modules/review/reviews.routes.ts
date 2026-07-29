import { Router } from 'express';
import { ReviewHistoryQuerySchema } from '@oxyhq/crowdsource-contracts';

import { parseOrThrow } from '../../http/parseBody';
import { requestReviewer, requireReviewerSession } from '../reviewer/reviewerAuth';
import { reviewHistoryPage } from './reviewHistory';

/**
 * §4.1's "Historial" — the reviewer's own completed reviews.
 *
 * One route, and the shape of it is the invariant: it takes no case id, no
 * subject, no application and no free-text search. A reviewer can page through
 * what THEY did, and there is no parameter by which they could look for a
 * particular case — which is what keeps "nobody chooses the case they review"
 * true of the history screen as well as of the queue.
 *
 * The reviewer comes from the session. There is no `reviewerId` parameter, so
 * there is no route on which one reviewer could read another's record.
 */

export const reviewsRouter: Router = Router();

reviewsRouter.get('/reviewer/reviews', ...requireReviewerSession(), async (request, response) => {
  const query = parseOrThrow(
    ReviewHistoryQuerySchema,
    request.query,
    'The request query is not valid.',
  );
  response.status(200).json(await reviewHistoryPage(requestReviewer(request).reviewerId, query));
});

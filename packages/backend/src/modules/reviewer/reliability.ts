import type { TaxonomyFamily } from '@oxyhq/crowdsource-contracts';

import type { ReviewerProfileDocument } from './reviewer.collection';

/**
 * How reliable a reviewer is for the material a case is about.
 *
 * The MINIMUM across the families alleged, not the mean. A reviewer who is
 * excellent on spam and poor on harassment should not count as reliable on a
 * case that alleges both — averaging would let a strong score in an unrelated
 * family carry them. A family with no measurement contributes 0, which is the
 * honest value: nobody has measured it.
 *
 * It lives in the reviewer module because it is a fact about a reviewer, and it
 * is shared because two callers need the same number for different purposes and
 * must not disagree about it:
 *
 *  - the draw (§8.4) turns it into a selection weight, one of four terms;
 *  - consensus (§9.5) averages it across the panel into `panelQuality`, one of
 *    three terms in a confidence score.
 *
 * Neither may turn it into a vote. §8.4 is explicit that reliability affects
 * eligibility, the slot and the aggregate confidence score and never multiplies
 * a vote, and §9.5 repeats it for confidence specifically. What enforces that
 * here is that this function is about a PERSON and knows nothing about a ballot:
 * there is no review, no outcome and no position in its signature, so the number
 * cannot reach the count. `weightSeparation.test.ts` holds the other half by
 * pinning that the selection weight itself never leaves the draw.
 */
export function categoryReliability(
  profile: ReviewerProfileDocument,
  families: readonly TaxonomyFamily[],
): number {
  if (families.length === 0) return 0;
  return families.reduce(
    (lowest, family) => Math.min(lowest, profile.reliabilityByCategory[family] ?? 0),
    1,
  );
}

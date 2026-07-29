import { config } from '../../config';
import {
  eligibilityFilter,
  type CaseEligibilityCriteria,
} from '../reviewer/eligibility';
import { reviewerProfiles, type ReviewerProfileDocument } from '../reviewer/reviewer.collection';

/**
 * Getting candidates out of the database, at a cost that does not grow with the
 * number of reviewers (§8.8).
 *
 * §8.8 is specific about what not to do: the civic selector "limits the pool it
 * queries and evaluates candidates sequentially". Both halves are bugs at scale
 * and one of them is a bug at any scale — an unordered `limit(500)` does not
 * sample five hundred reviewers, it returns the SAME five hundred rows every
 * time, whichever the storage engine walks first. A pool that never rotates is
 * not a lottery.
 *
 * The fix is a uniform sampling key on every profile plus a range scan from a
 * random point on it:
 *
 *   `{ state, categories, samplingKey }` → equality, equality, range
 *
 * which is a bounded index scan. The database walks at most `limit` index
 * entries and fetches at most `limit` documents, whether there are a thousand
 * profiles or fifty million. The window wraps around zero when the tail is
 * short, so a draw starting at 0.98 is not systematically smaller than one
 * starting at 0.02 — without the wrap, reviewers with high sampling keys would
 * be drawn measurably more often, which is a bias the seed cannot correct.
 *
 * `$sample` was the obvious alternative and is not usable: it draws from the
 * documents the filter already matched, so the filter has to be evaluated across
 * the whole population first — the collection scan this exists to avoid.
 *
 * ## What one draw costs
 *
 * At most two queries here — one range scan from the window's start, and a
 * second only when the tail was short and the window has to wrap. Both are
 * bounded by the sample size rather than by the population.
 *
 * The whole draw is nine reads at most; `sortition.service.ts` enumerates them.
 * None is per candidate, which is the difference that matters: the civic
 * selector runs roughly ten round trips per CANDIDATE.
 */

export interface CandidateSample {
  readonly profiles: readonly ReviewerProfileDocument[];
  /** How many the index actually returned, before eligibility was re-checked. */
  readonly sampledCount: number;
  /** Where on the sampling key this draw's window started, for the record. */
  readonly windowStart: number;
}

/**
 * A window of eligible candidates, starting at a random point on the sampling
 * key and wrapping around.
 *
 * The window start uses `Math.random`, and that is deliberate rather than an
 * oversight about cryptographic quality: it decides which slice of the
 * population is CONSIDERED, and the slice it produced is then persisted in the
 * draw's candidate snapshot. The randomness that decides WHO IS CHOSEN from that
 * slice is the CSPRNG seed in `seededRandom.ts`, and only that one has to resist
 * prediction — a reviewer who could guess the window still could not guess the
 * panel.
 */
export async function sampleCandidates(
  criteria: CaseEligibilityCriteria,
  now: Date,
  limit: number = config.sortition.candidateSampleSize,
): Promise<CandidateSample> {
  const filter = eligibilityFilter(criteria, now);
  const windowStart = Math.random();

  const head = await reviewerProfiles.find(
    { ...filter, samplingKey: { $gte: windowStart } },
    { sort: { samplingKey: 1 }, limit },
  );

  if (head.length >= limit) {
    return { profiles: head, sampledCount: head.length, windowStart };
  }

  /**
   * The wrap. Without it the pool is biased toward high sampling keys, and the
   * bias is invisible: every individual draw looks fine, and only an aggregate
   * over months shows that reviewers near 1.0 served twice as often.
   */
  const tail = await reviewerProfiles.find(
    { ...filter, samplingKey: { $lt: windowStart } },
    { sort: { samplingKey: 1 }, limit: limit - head.length },
  );

  const profiles = [...head, ...tail];
  return { profiles, sampledCount: profiles.length, windowStart };
}

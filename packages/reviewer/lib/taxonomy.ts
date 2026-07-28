/**
 * The universal taxonomy families of PLAN §6.3, as the reviewer app needs them.
 *
 * A reviewer opts in per FAMILY, not per code: consent, training and exposure
 * limits are all managed at that granularity (§8.2, §13.7). The individual codes
 * belong to the policy brief the server sends with a case, not to this list.
 *
 * Like `lib/reviewer-api/types.ts`, this is a placeholder for
 * `@oxyhq/crowdsource-contracts` and should be deleted when that package
 * publishes the taxonomy — the families are a shared contract, and two copies of
 * a shared contract is how they drift.
 */

export interface TaxonomyFamily {
  id: string;
  /**
   * PLAN §13.7 — "no mostrar contenido crítico a comunidad general". A family
   * marked here is not offered during onboarding: access to it comes from the
   * specialist path, not from a checkbox a new reviewer can tick.
   */
  specialistOnly: boolean;
  /** Whether material in this family is routinely behind the sensitive gate. */
  routinelySensitive: boolean;
}

export const TAXONOMY_FAMILIES: readonly TaxonomyFamily[] = [
  { id: 'integrity', specialistOnly: false, routinelySensitive: false },
  { id: 'harassment', specialistOnly: false, routinelySensitive: false },
  { id: 'hate', specialistOnly: false, routinelySensitive: true },
  { id: 'violence', specialistOnly: false, routinelySensitive: true },
  { id: 'sexual_content', specialistOnly: false, routinelySensitive: true },
  { id: 'child_safety', specialistOnly: true, routinelySensitive: true },
  { id: 'self_harm', specialistOnly: false, routinelySensitive: true },
  { id: 'privacy', specialistOnly: false, routinelySensitive: false },
  { id: 'commerce', specialistOnly: false, routinelySensitive: false },
  { id: 'platform_abuse', specialistOnly: false, routinelySensitive: false },
  { id: 'other', specialistOnly: false, routinelySensitive: false },
];

/** Families a reviewer may opt into without a specialist path. */
export const OPT_IN_FAMILIES = TAXONOMY_FAMILIES.filter((family) => !family.specialistOnly);

/** Families for which sensitive-material consent is a meaningful question. */
export const CONSENTABLE_FAMILIES = OPT_IN_FAMILIES.filter((family) => family.routinelySensitive);

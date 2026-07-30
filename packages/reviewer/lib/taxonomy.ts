/**
 * How the reviewer app PRESENTS the universal taxonomy families (PLAN §6.3).
 *
 * The families themselves are `TAXONOMY_FAMILIES` in
 * `@oxyhq/crowdsource-contracts` — layer one is CrowdSource's own (§6.1) and a
 * second copy of a shared vocabulary is how two copies drift. What lives here is
 * only what a SCREEN needs and the contract has no business knowing: whether a
 * family may be ticked during onboarding, and whether its material is routinely
 * behind the sensitive gate.
 *
 * A reviewer opts in per FAMILY, not per code: consent, training and exposure
 * limits are all managed at that granularity (§8.2, §13.7). The individual codes
 * belong to the policy brief the server sends with a case.
 */

import { TAXONOMY_FAMILIES, type TaxonomyFamily } from '@oxyhq/crowdsource-contracts';

export interface FamilyPresentation {
  id: TaxonomyFamily;
  /**
   * PLAN §13.7 — "no mostrar contenido crítico a comunidad general". A family
   * marked here is not offered during onboarding: access to it comes from the
   * specialist path, not from a checkbox a new reviewer can tick.
   */
  specialistOnly: boolean;
  /** Whether material in this family is routinely behind the sensitive gate. */
  routinelySensitive: boolean;
}

/**
 * One entry per contract family, keyed by the contract's own union.
 *
 * A `Record` over `TaxonomyFamily` rather than a list, so a family added to the
 * contract is a COMPILE ERROR here rather than a family that silently never
 * appears in onboarding — which would leave a reviewer unable to opt into work
 * the server would happily draw them for.
 */
const PRESENTATION: Readonly<Record<TaxonomyFamily, Omit<FamilyPresentation, 'id'>>> =
  Object.freeze({
    integrity: { specialistOnly: false, routinelySensitive: false },
    harassment: { specialistOnly: false, routinelySensitive: false },
    hate: { specialistOnly: false, routinelySensitive: true },
    violence: { specialistOnly: false, routinelySensitive: true },
    sexual_content: { specialistOnly: false, routinelySensitive: true },
    child_safety: { specialistOnly: true, routinelySensitive: true },
    self_harm: { specialistOnly: false, routinelySensitive: true },
    privacy: { specialistOnly: false, routinelySensitive: false },
    commerce: { specialistOnly: false, routinelySensitive: false },
    platform_abuse: { specialistOnly: false, routinelySensitive: false },
    other: { specialistOnly: false, routinelySensitive: false },
  });

export const FAMILY_PRESENTATIONS: readonly FamilyPresentation[] = TAXONOMY_FAMILIES.map(
  (id) => ({ id, ...PRESENTATION[id] }),
);

/** Families a reviewer may opt into without a specialist path. */
export const OPT_IN_FAMILIES = FAMILY_PRESENTATIONS.filter((family) => !family.specialistOnly);

/** Families for which sensitive-material consent is a meaningful question. */
export const CONSENTABLE_FAMILIES = OPT_IN_FAMILIES.filter(
  (family) => family.routinelySensitive,
);

/** A family a reviewer can actually tick — the type the onboarding form holds. */
export type ConsentableFamily = TaxonomyFamily;

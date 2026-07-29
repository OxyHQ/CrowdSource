import type {
  DecisionOutcome,
  FindingAttribution,
  FindingScope,
  Severity,
  TaxonomyCode,
} from '@oxyhq/crowdsource-contracts';

/**
 * How far a confirmed finding reaches (§6.5), as data.
 *
 * A `DecisionFinding` requires a `scope` and a review does not carry one, so
 * something has to decide it — and §6.1 is emphatic that "should this conduct
 * affect global Oxy trust?" is the THIRD layer, owned by the Oxy Conduct Policy
 * and evaluated by the Reputation Bridge. That bridge is phase 7. This table is
 * therefore deliberately minimal and deliberately conservative, and it is not a
 * conduct policy:
 *
 *  - It lists ONLY the rows §6.5 actually names, and nothing else.
 *  - Everything absent defaults to `application_local`, which is §6.5's own
 *    opening sentence — "una restricción local no se convierte automáticamente
 *    en una sanción global" — and Appendix F's "un reporte confirmado no
 *    equivale a una sanción global". Defaulting the other way would make every
 *    unlisted family a candidate for a global penalty by omission.
 *  - A `low` severity finding never leaves the application, whatever its code.
 *    §6.5's spam row: "spam repetitivo de baja gravedad → limitación local →
 *    efecto global solo ante patrón cross app o reincidencia". Recidivism and
 *    cross-application patterns are §11.9's, computed from incidents, and no
 *    single decision can observe either.
 *
 * What this scope DOES is gate §11.7.5: only `oxy_network` and
 * `identity_integrity` may ever reach Oxy Trust, and a finding scoped
 * `application_local` cannot produce a global effect no matter what a later
 * module decides. Widening a row here is therefore a change that has to be
 * argued for against §6.5, which is why the table is data with the plan's own
 * sentences attached rather than a function full of conditionals.
 */

/** §6.5's named rows, by universal code. */
const CODE_SCOPE: Partial<Record<TaxonomyCode, FindingScope>> = Object.freeze({
  /** "Acoso dirigido confirmado → retirada o limitación → puede afectar conduct standing." */
  'harassment.targeted_abuse': 'oxy_network',
  'harassment.credible_threat': 'oxy_network',
  'harassment.sexual_harassment': 'oxy_network',
  'harassment.doxxing': 'oxy_network',

  /** "Material íntimo no consentido → acción inmediata y escalado → efecto global grave." */
  'sexual_content.non_consensual': 'oxy_network',
  'sexual_content.exploitation': 'oxy_network',
  'privacy.intimate_media': 'oxy_network',

  /**
   * §7.5 row 1's material. §6.5 does not tabulate it because §7.5 has already
   * removed it from the community path entirely; a confirmed finding of it is
   * the clearest possible case of conduct that crosses applications.
   */
  'child_safety.sexualization': 'oxy_network',
  'child_safety.grooming': 'oxy_network',
  'child_safety.exploitation': 'oxy_network',

  /**
   * "Estafa deliberada en marketplace → retirada, reembolso, suspensión → puede
   * afectar integridad global." §11.7.5 names `identity_integrity` as the other
   * scope an effect may follow, and deliberate deception about who you are or
   * what you are selling is what that scope is about.
   */
  'integrity.scam': 'identity_integrity',
  'integrity.fraud': 'identity_integrity',
  'integrity.impersonation': 'identity_integrity',
});

/**
 * How far a confirmed finding of this code, at this severity, reaches.
 *
 * The severity floor applies before the table, not after: §6.5's spam row makes
 * low severity local regardless of what the code would otherwise be worth, and
 * ordering it the other way would let a `low` harassment finding reach Oxy Trust
 * because its code appears above.
 */
export function findingScopeOf(code: TaxonomyCode, severity: Severity): FindingScope {
  if (severity === 'low') return 'application_local';
  return CODE_SCOPE[code] ?? 'application_local';
}

/**
 * Whose conduct a confirmed finding is about (Appendix B's `attribution`).
 *
 * `author` and nothing else, for now, and the omission is the honest one. §11.11
 * and §11.12 describe confirmed report abuse and confirmed review abuse
 * attributing to a `reporter` and a `reviewer`, but neither is something a jury
 * reviewing REPORTED MATERIAL can conclude: a panel is shown the material and
 * the policy, not who filed the report (§9.1), so it has no basis on which to
 * attribute anything to them. Those two attributions arrive with the surfaces
 * that can actually establish them.
 *
 * Undefined for anything that is not a violation, because §11.7.4 will not let
 * an effect land without a binding proof anyway and attributing conduct to
 * somebody whose material was found not to violate is a claim nobody made.
 */
export function findingAttributionOf(
  outcome: DecisionOutcome,
): FindingAttribution | undefined {
  return outcome === 'violation' ? 'author' : undefined;
}

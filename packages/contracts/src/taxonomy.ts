/**
 * The universal classification layer (§6.1, §6.3).
 *
 * §6.1 separates three layers and warns that mixing them makes the service
 * unusable across applications with different rules. This module is the FIRST
 * layer only — "what does the material contain or represent?" — and it belongs
 * to CrowdSource. Whether that content violates anything is the second layer
 * (`policies.ts`, per tenant) and whether it should move global trust is the
 * third (`reputation-events.ts`). Nothing here may encode a single tenant's
 * vocabulary.
 *
 * The code list is CLOSED. `other.policy_specific` and `other.unclassifiable`
 * are the escape hatches the plan provides for material that does not fit; an
 * open string would let a tenant mint private codes, which is precisely the
 * cross-application comparability §6.1 exists to protect. Adding a code is an
 * additive change that bumps `UNIVERSAL_TAXONOMY_VERSION`, and §6.4 requires
 * every decision to record the version it was classified under, so historical
 * decisions keep meaning what they meant.
 */

import { z } from 'zod';

/** §6.3 families. */
export const TAXONOMY_FAMILIES = [
  'integrity',
  'harassment',
  'hate',
  'violence',
  'sexual_content',
  'child_safety',
  'self_harm',
  'privacy',
  'commerce',
  'platform_abuse',
  'other',
] as const;

export const TaxonomyFamilySchema = z.enum(TAXONOMY_FAMILIES);
export type TaxonomyFamily = z.infer<typeof TaxonomyFamilySchema>;

const INTEGRITY_CODES = [
  'integrity.spam',
  'integrity.scam',
  'integrity.fraud',
  'integrity.impersonation',
  'integrity.coordinated_manipulation',
] as const;

const HARASSMENT_CODES = [
  'harassment.insult',
  'harassment.targeted_abuse',
  'harassment.sexual_harassment',
  'harassment.doxxing',
  'harassment.credible_threat',
] as const;

const HATE_CODES = [
  'hate.dehumanization',
  'hate.slur',
  'hate.incitement',
  'hate.protected_targeting',
] as const;

const VIOLENCE_CODES = [
  'violence.graphic',
  'violence.threat',
  'violence.instruction',
  'violence.celebration',
] as const;

const SEXUAL_CONTENT_CODES = [
  'sexual_content.nudity',
  'sexual_content.explicit_activity',
  'sexual_content.non_consensual',
  'sexual_content.exploitation',
] as const;

const CHILD_SAFETY_CODES = [
  'child_safety.sexualization',
  'child_safety.grooming',
  'child_safety.exploitation',
] as const;

const SELF_HARM_CODES = [
  'self_harm.promotion',
  'self_harm.instruction',
  'self_harm.imminent_risk',
] as const;

const PRIVACY_CODES = [
  'privacy.personal_information',
  'privacy.intimate_media',
  'privacy.location_exposure',
] as const;

const COMMERCE_CODES = [
  'commerce.prohibited_item',
  'commerce.counterfeit',
  'commerce.misleading_listing',
  'commerce.unsafe_product',
] as const;

const PLATFORM_ABUSE_CODES = [
  'platform_abuse.ban_evasion',
  'platform_abuse.report_abuse',
  'platform_abuse.automation_abuse',
] as const;

const OTHER_CODES = ['other.policy_specific', 'other.unclassifiable'] as const;

/**
 * §6.3, grouped.
 *
 * §9.4 requires consensus on the "main taxonomic family", not only on the exact
 * code, so the grouping is part of the contract rather than something the
 * consensus engine re-derives from string prefixes.
 */
export const TAXONOMY_CODES_BY_FAMILY = Object.freeze({
  integrity: INTEGRITY_CODES,
  harassment: HARASSMENT_CODES,
  hate: HATE_CODES,
  violence: VIOLENCE_CODES,
  sexual_content: SEXUAL_CONTENT_CODES,
  child_safety: CHILD_SAFETY_CODES,
  self_harm: SELF_HARM_CODES,
  privacy: PRIVACY_CODES,
  commerce: COMMERCE_CODES,
  platform_abuse: PLATFORM_ABUSE_CODES,
  other: OTHER_CODES,
} as const);

export const UNIVERSAL_TAXONOMY_CODES = [
  ...INTEGRITY_CODES,
  ...HARASSMENT_CODES,
  ...HATE_CODES,
  ...VIOLENCE_CODES,
  ...SEXUAL_CONTENT_CODES,
  ...CHILD_SAFETY_CODES,
  ...SELF_HARM_CODES,
  ...PRIVACY_CODES,
  ...COMMERCE_CODES,
  ...PLATFORM_ABUSE_CODES,
  ...OTHER_CODES,
] as const;

export const TaxonomyCodeSchema = z.enum(UNIVERSAL_TAXONOMY_CODES);
export type TaxonomyCode = z.infer<typeof TaxonomyCodeSchema>;

/**
 * The version of the code list above.
 *
 * §6.4: every decision records the taxonomy version it was decided under, and a
 * policy update never silently rewrites history. Keeping the constant in the
 * same module as the codes is what makes that possible — the two cannot drift.
 * The value is the one the plan uses in Appendix B and §11.6.
 */
export const UNIVERSAL_TAXONOMY_VERSION = '2026.1';

/** The family a code belongs to. */
export function taxonomyFamilyOf(code: TaxonomyCode): TaxonomyFamily {
  const [family] = code.split('.');
  return TaxonomyFamilySchema.parse(family);
}

/** §9.4 / §11.8 severity scale. */
export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export const SeveritySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof SeveritySchema>;

/**
 * How far a finding reaches.
 *
 * §11.6 and Appendix B use `oxy_network`; §11.7.5 additionally names
 * `identity_integrity` as a scope that may produce an Oxy Trust effect. The
 * plan never names the third value — the one that means "this matters to the
 * application and stops there" — even though §6.5's entire argument is that
 * most local restrictions must NOT become global sanctions. `application_local`
 * is the contract's name for it and is the ONE token in this package invented
 * rather than quoted. Modelling it as an absent field instead would make
 * §11.7.5 a presence check, which fails open.
 */
export const FINDING_SCOPES = ['application_local', 'oxy_network', 'identity_integrity'] as const;
export const FindingScopeSchema = z.enum(FINDING_SCOPES);
export type FindingScope = z.infer<typeof FindingScopeSchema>;

/**
 * Scopes that §11.7.5 allows to reach Oxy Trust.
 *
 * Exported as its own schema so `reputation-events.ts` states the rule in the
 * type rather than re-checking it at runtime.
 */
export const REPUTATION_ELIGIBLE_FINDING_SCOPES = ['oxy_network', 'identity_integrity'] as const;
export const ReputationEligibleFindingScopeSchema = z.enum(REPUTATION_ELIGIBLE_FINDING_SCOPES);
export type ReputationEligibleFindingScope = z.infer<typeof ReputationEligibleFindingScopeSchema>;

/**
 * Who a finding attributes conduct to.
 *
 * Appendix B and §11.6 use `author`. §11.11 and §11.12 describe confirmed
 * report abuse and confirmed review abuse producing conduct effects of their
 * own, which is where the other two values come from. There is deliberately no
 * `unknown`: attribution exists to name a principal, and §11.7.4 will not let
 * an effect land without a binding proof for that principal anyway.
 */
export const FINDING_ATTRIBUTIONS = ['author', 'reporter', 'reviewer'] as const;
export const FindingAttributionSchema = z.enum(FINDING_ATTRIBUTIONS);
export type FindingAttribution = z.infer<typeof FindingAttributionSchema>;

/**
 * What CrowdSource may recommend an application do.
 *
 * The plan writes action tokens in two places. §6.2, §9.3, §10.7 and Appendix B
 * recommend `remove_or_restrict` and `allow_with_label`; §7.6 tabulates, per
 * decision outcome, the actions an application may take in response. They are
 * the same vocabulary seen from the two ends of one exchange, so the contract
 * carries the union as one closed list — otherwise a recommendation and the
 * enforcement that answers it would not be comparable, and §7.6's requirement
 * that an application "record what it did and why" would compare apples to
 * pears.
 *
 * §7.6's outcome→action table is NOT reproduced as a constraint. It bounds what
 * an application may do in response to an outcome, not what a jury may
 * recommend — Appendix B recommends `remove_or_restrict`, which does not appear
 * in §7.6's `violation` row at all. Binding the two would reject the plan's own
 * reference decision.
 */
export const RECOMMENDED_ACTIONS = [
  'remove_or_restrict',
  'allow_with_label',
  'remove',
  'hide',
  'label',
  'age_gate',
  'reduce_distribution',
  'freeze_transaction',
  'suspend_user',
  'request_changes',
  'allow',
  'restore',
  'no_action',
  'request_more_context',
  'hold',
  'local_manual_review',
  'keep_restricted_temporarily',
  'escalate',
  'no_global_effect',
  'specialist_queue',
  'legal_queue',
  'safety_queue',
] as const;

export const RecommendedActionSchema = z.enum(RECOMMENDED_ACTIONS);
export type RecommendedAction = z.infer<typeof RecommendedActionSchema>;

/**
 * The context that makes a classification not mean what it usually means —
 * §9.2's and §9.4's "excepción", §6.2's `context`.
 *
 * §6.2's worked example is where this field comes from and what fixes its
 * shape: the jury's finding is `sexual_content.nudity, severity = medium,
 * context = artistic`, and it is that qualifier — not the code and not the
 * severity — that turns the same classification into a violation under one
 * application's policy and not under another's. It therefore belongs to layer
 * one, beside the code: a reviewer describes what the material IS, and
 * "artistic nudity" is a different description from "nudity".
 *
 * §9.4 makes it one of the six dimensions consensus is measured on, which is
 * the reason it must be a CLOSED list. Two reviewers who both answer
 * `no_violation` but for incompatible reasons — one because the material is
 * documentary, one because they think the rule does not cover it at all — have
 * not agreed about the material, and a free-text field could not tell the two
 * apart. An open token would also be a channel for case content to reach a
 * decision record, which §13.5 forbids.
 *
 * Only `artistic` is the plan's own word. The rest are the exception vocabulary
 * every published moderation policy shares, and they are named here rather than
 * left to a tenant because layer one is CrowdSource's (§6.1) — a tenant that
 * could mint its own exception tokens would make findings incomparable across
 * applications, which is exactly what §6.1 exists to prevent. Absence means no
 * exception applies, which is the safe direction: a finding with no exception
 * stands as classified.
 */
export const FINDING_CONTEXTS = [
  'artistic',
  'educational',
  'documentary',
  'newsworthy',
  'satire',
  'counter_speech',
  'medical',
  'consensual',
  'fictional',
] as const;
export const FindingContextSchema = z.enum(FINDING_CONTEXTS);
export type FindingContext = z.infer<typeof FindingContextSchema>;

/**
 * A tenant's advance classification of how exposing the material is.
 *
 * The plan names exactly one value — `standard`, in Appendix A — and §7.5
 * clearly implies at least one more (categories that never reach a community
 * jury). Rather than invent the rest, this stays an open lowercase token: it is
 * a HINT (§5.2: "never shown as a verdict"), the authoritative
 * `sensitivity_class` is computed by triage server-side (§12.8), and access to
 * sensitive material is gated on that computed class, never on what the tenant
 * asserted. Closing this list is a product decision that has not been made.
 */
export const SensitivityHintSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/, 'must be a lowercase token');
export type SensitivityHint = z.infer<typeof SensitivityHintSchema>;

import {
  PolicySetVersionSchema,
  TAXONOMY_CODES_BY_FAMILY,
  UNIVERSAL_TAXONOMY_VERSION,
  type PolicySetVersion,
} from '@oxyhq/crowdsource-contracts';

import { policyVersionToken } from '../cases/caseDedupKey';

/**
 * The baseline policy set — the minimal policy registry §15.3 asks for, over
 * §6.3's initial taxonomy.
 *
 * §6.1 splits classification (CrowdSource's taxonomy) from policy (each
 * tenant's rules) and warns that mixing them makes the service unusable across
 * applications with different norms. This file sits on the policy side of that
 * line while staying tenant-neutral: one rule per taxonomy family, binding the
 * family's codes to a starting severity and the actions an application would
 * typically consider. It is what an integrator can point at on day one, before
 * they have written a policy set of their own.
 *
 * Three properties make that safe rather than a shortcut:
 *
 *   * **It is data.** §6.4's last line forbids rules expressed as tenant-supplied
 *     code, and the contract has no field that could carry any. This constant is
 *     parsed by the same `PolicySetVersionSchema` a tenant's own registration
 *     goes through, at import time, so a malformed baseline fails at boot rather
 *     than at the first report that references it.
 *   * **It is versioned and frozen.** §6.4 requires every decision to record the
 *     policy version it was decided under and forbids a policy update from
 *     silently changing what a past decision meant. Editing a rule below means
 *     publishing a NEW version constant, never modifying this one.
 *   * **It never wins over a tenant's own.** `policy.registry.ts` resolves a
 *     tenant-registered set first; this is the fallback for the one id/version
 *     pair it owns.
 *
 * The severities are a starting classification of how much harm a family
 * *typically* represents. They are not a verdict, not a finding and not visible
 * to a jury — §6.2 keeps allegation, finding and action separate, and a jury
 * classifies the material itself before any rule is consulted.
 */

export const BASELINE_POLICY_SET_ID = 'crowdsource.baseline';

/**
 * Calendar-shaped, like every policy version in the plan, and deliberately NOT
 * tied to `UNIVERSAL_TAXONOMY_VERSION`: the taxonomy and the policy over it are
 * versioned independently (§6.4), so a new code can be classified without
 * reissuing every application's rules.
 */
export const BASELINE_POLICY_VERSION = '2026.07';

/** The token stored on a case and used as §7.3's fourth dedup component. */
export const BASELINE_POLICY_TOKEN = policyVersionToken(
  BASELINE_POLICY_SET_ID,
  BASELINE_POLICY_VERSION,
);

/**
 * Frozen at the moment the constant below was written. A published version
 * records when it was published (§6.4) and this one was published by shipping
 * it, so the timestamp belongs in source rather than being computed at boot —
 * a `new Date()` here would give every deployment a different publication date
 * for the same immutable document.
 */
const BASELINE_PUBLISHED_AT = '2026-07-29T00:00:00.000Z';

const baselinePolicySet: unknown = {
  policySetId: BASELINE_POLICY_SET_ID,
  version: BASELINE_POLICY_VERSION,
  status: 'published',
  title: `CrowdSource baseline policy (universal taxonomy ${UNIVERSAL_TAXONOMY_VERSION})`,
  publishedAt: BASELINE_PUBLISHED_AT,
  rules: [
    {
      id: 'crowdsource.baseline.integrity',
      title: 'Deception, fraud and coordinated manipulation',
      description:
        'Material that misrepresents who is speaking, what is being sold, or how widely a position is held.',
      taxonomyCodes: [...TAXONOMY_CODES_BY_FAMILY.integrity],
      defaultSeverity: 'medium',
      recommendedActions: ['remove_or_restrict', 'reduce_distribution', 'label'],
    },
    {
      id: 'crowdsource.baseline.harassment',
      title: 'Harassment directed at a person',
      description:
        'Material aimed at a specific person to degrade, intimidate, expose or pursue them.',
      taxonomyCodes: [...TAXONOMY_CODES_BY_FAMILY.harassment],
      defaultSeverity: 'medium',
      recommendedActions: ['remove_or_restrict', 'hide', 'suspend_user'],
    },
    {
      id: 'crowdsource.baseline.hate',
      title: 'Hate directed at a protected characteristic',
      taxonomyCodes: [...TAXONOMY_CODES_BY_FAMILY.hate],
      defaultSeverity: 'high',
      recommendedActions: ['remove', 'suspend_user'],
    },
    {
      id: 'crowdsource.baseline.violence',
      title: 'Violence, threats and instruction',
      taxonomyCodes: [...TAXONOMY_CODES_BY_FAMILY.violence],
      defaultSeverity: 'high',
      recommendedActions: ['remove', 'age_gate', 'escalate'],
    },
    {
      id: 'crowdsource.baseline.sexual_content',
      title: 'Sexual content',
      description:
        'Consensual adult material and non-consensual material are the same family and very different severities; the finding, not the family, decides.',
      taxonomyCodes: [...TAXONOMY_CODES_BY_FAMILY.sexual_content],
      defaultSeverity: 'high',
      recommendedActions: ['age_gate', 'remove_or_restrict', 'escalate'],
    },
    {
      id: 'crowdsource.baseline.child_safety',
      title: 'Child safety',
      description:
        'Never reviewed by a community jury (§7.5). Routed to a specialist queue and the legal protocols defined for the deployment.',
      taxonomyCodes: [...TAXONOMY_CODES_BY_FAMILY.child_safety],
      defaultSeverity: 'critical',
      recommendedActions: ['remove', 'legal_queue', 'suspend_user'],
    },
    {
      id: 'crowdsource.baseline.self_harm',
      title: 'Self-harm',
      description:
        'Imminent risk is an emergency path, not a moderation queue; the reporting application keeps its own emergency processes (§7.5).',
      taxonomyCodes: [...TAXONOMY_CODES_BY_FAMILY.self_harm],
      defaultSeverity: 'high',
      recommendedActions: ['safety_queue', 'remove_or_restrict', 'escalate'],
    },
    {
      id: 'crowdsource.baseline.privacy',
      title: 'Personal information and intimate media',
      taxonomyCodes: [...TAXONOMY_CODES_BY_FAMILY.privacy],
      defaultSeverity: 'high',
      recommendedActions: ['remove', 'escalate'],
    },
    {
      id: 'crowdsource.baseline.commerce',
      title: 'Prohibited, counterfeit, misleading or unsafe listings',
      taxonomyCodes: [...TAXONOMY_CODES_BY_FAMILY.commerce],
      defaultSeverity: 'medium',
      recommendedActions: ['remove_or_restrict', 'freeze_transaction', 'request_changes'],
    },
    {
      id: 'crowdsource.baseline.platform_abuse',
      title: 'Abuse of the platform itself',
      description:
        'Includes abuse of the reporting system (§11.11): reporting is a capability that can itself be weaponised.',
      taxonomyCodes: [...TAXONOMY_CODES_BY_FAMILY.platform_abuse],
      defaultSeverity: 'low',
      recommendedActions: ['reduce_distribution', 'suspend_user', 'local_manual_review'],
    },
    {
      id: 'crowdsource.baseline.other',
      title: 'Policy-specific and unclassifiable',
      description:
        'The escape hatch of §6.3. A case landing here says the universal taxonomy has no code for the material, which is a signal worth reading rather than a default.',
      taxonomyCodes: [...TAXONOMY_CODES_BY_FAMILY.other],
      defaultSeverity: 'low',
      recommendedActions: ['local_manual_review', 'hold'],
    },
  ],
};

/**
 * Parsed at import time, deliberately.
 *
 * A baseline that does not satisfy the published contract would otherwise be
 * discovered by the first tenant to reference it, as a 500 on an ingress that
 * had already been accepted everywhere else.
 */
export const BASELINE_POLICY_SET: PolicySetVersion =
  PolicySetVersionSchema.parse(baselinePolicySet);

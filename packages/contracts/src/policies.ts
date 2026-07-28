/**
 * The application-policy layer (§6.1 layer 2) and policy versioning (§6.4).
 *
 * The taxonomy says what the material contains; a policy set says whether that
 * violates THIS application's rules. The two are versioned independently and
 * every decision records both (plus the Oxy conduct policy version), because
 * §6.4 forbids a policy update from silently changing what a past decision
 * meant.
 *
 * The security boundary of this module is §6.4's last line: "rules must be
 * expressed as data, not as arbitrary code supplied by the tenant". A rule here
 * therefore has an id, a title, the taxonomy codes it responds to, a default
 * severity and recommended actions — and no expression, predicate, script,
 * template or callback field of any kind. That absence is the control. It is
 * enforced by `.strict()`: a policy set carrying an unrecognised key is
 * rejected outright rather than accepted with the key quietly dropped, because
 * "dropped" and "never evaluated" look identical right up until something
 * decides to evaluate it.
 */

import { z } from 'zod';

import { CONTRACT_LIMITS, LanguageTagSchema, TimestampSchema } from './primitives';
import { RecommendedActionSchema, SeveritySchema, TaxonomyCodeSchema } from './taxonomy';

/** A namespaced policy set id, e.g. `mention.community`. */
export const PolicySetIdSchema = z
  .string()
  .min(3)
  .max(CONTRACT_LIMITS.IDENTIFIER_MAX_LENGTH)
  .regex(
    /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/,
    'must be a dotted lowercase namespace, e.g. "mention.community"',
  );

/** A rule id within a policy set, e.g. `mention.harassment.2`. */
export const PolicyRuleIdSchema = z
  .string()
  .min(3)
  .max(CONTRACT_LIMITS.IDENTIFIER_MAX_LENGTH)
  .regex(
    /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/,
    'must be a dotted lowercase namespace, e.g. "mention.harassment.2"',
  );

/**
 * An immutable policy version token, e.g. `2026.07`, `mention.2026.07`,
 * `oxy.2026.1`.
 *
 * Deliberately not semver: the plan's own tokens are calendar-shaped and
 * tenant-prefixed, and a policy version is an opaque label pointing at a frozen
 * document — nothing compares two of them for ordering.
 */
export const PolicyVersionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    'must start with a letter or digit and contain only letters, digits, ".", "_" or "-"',
  );

/**
 * The policy an envelope asks to be evaluated under (§5.1 `policy`).
 *
 * `locale` selects the language the policy text is shown to the reviewer in
 * (Appendix A), and is not the language of the reported material — that is
 * `resource.language`.
 */
export const CasePolicyRefSchema = z.strictObject({
  policySetId: PolicySetIdSchema,
  version: PolicyVersionSchema,
  locale: LanguageTagSchema.optional(),
});
export type CasePolicyRef = z.infer<typeof CasePolicyRefSchema>;

/**
 * The three policy versions a decision is decided under (§6.4).
 *
 * Field names follow Appendix B (`taxonomy`), which is the reference Decision.
 * §6.4's prose calls the same field `universalTaxonomyVersion` and §11.6's
 * internal event calls it `universal`; see `ReputationPolicyVersionsSchema` for
 * why both spellings survive.
 */
export const DecisionPolicyVersionsSchema = z.looseObject({
  taxonomy: PolicyVersionSchema,
  application: PolicyVersionSchema,
  oxyConduct: PolicyVersionSchema,
});
export type DecisionPolicyVersions = z.infer<typeof DecisionPolicyVersionsSchema>;

/**
 * The same three versions as carried by the internal reputation event (§11.6).
 *
 * §11.6 spells the first key `universal` where Appendix B spells it `taxonomy`.
 * Both are reference payloads in the approved plan and both are load-bearing
 * for a different consumer, so each surface keeps the spelling its own
 * reference document uses rather than one of the two documents being quietly
 * rewritten here. Unifying them is a one-line change and worth doing when the
 * event contract is agreed with OxyHQServices — it is called out in the package
 * README as the single naming inconsistency the contract preserves on purpose.
 */
export const ReputationPolicyVersionsSchema = z.strictObject({
  universal: PolicyVersionSchema,
  application: PolicyVersionSchema,
  oxyConduct: PolicyVersionSchema,
});
export type ReputationPolicyVersions = z.infer<typeof ReputationPolicyVersionsSchema>;

/** §6.4: a draft may be edited, a published version may not. */
export const POLICY_SET_STATUSES = ['draft', 'published'] as const;
export const PolicySetStatusSchema = z.enum(POLICY_SET_STATUSES);
export type PolicySetStatus = z.infer<typeof PolicySetStatusSchema>;

/**
 * One rule inside a policy version — data, never code.
 *
 * `taxonomyCodes` is what binds layer 2 back to layer 1: the rule declares
 * which universal findings it responds to, so a jury classifies once (§9.2 step
 * one) and any number of applications evaluate that same classification against
 * their own rules (§6.2).
 */
export const PolicyRuleSchema = z.strictObject({
  id: PolicyRuleIdSchema,
  title: z.string().min(1).max(CONTRACT_LIMITS.SHORT_TEXT_MAX_LENGTH),
  description: z.string().max(CONTRACT_LIMITS.LONG_TEXT_MAX_LENGTH).optional(),
  taxonomyCodes: z.array(TaxonomyCodeSchema).min(1).max(CONTRACT_LIMITS.FINDINGS_MAX),
  defaultSeverity: SeveritySchema.optional(),
  recommendedActions: z
    .array(RecommendedActionSchema)
    .max(CONTRACT_LIMITS.RECOMMENDED_ACTIONS_MAX)
    .optional(),
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

const POLICY_RULES_MAX = 500;

/**
 * A policy set at one version (§6.4).
 *
 * The `status`/`publishedAt` pairing is the immutability rule expressed where a
 * schema can express it: a published version must record when it was published,
 * and a draft must not claim to have been. Actual immutability — never
 * rewriting a published version's rules — is a storage rule the registry
 * enforces; no parse can see a second write.
 */
export const PolicySetVersionSchema = z
  .strictObject({
    policySetId: PolicySetIdSchema,
    version: PolicyVersionSchema,
    status: PolicySetStatusSchema,
    title: z.string().min(1).max(CONTRACT_LIMITS.SHORT_TEXT_MAX_LENGTH),
    locale: LanguageTagSchema.optional(),
    publishedAt: TimestampSchema.optional(),
    rules: z.array(PolicyRuleSchema).min(1).max(POLICY_RULES_MAX),
  })
  .superRefine((policySet, ctx) => {
    if (policySet.status === 'published' && policySet.publishedAt === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['publishedAt'],
        message: 'a published policy version must record publishedAt',
      });
    }
    if (policySet.status === 'draft' && policySet.publishedAt !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['publishedAt'],
        message: 'a draft policy version must not record publishedAt',
      });
    }

    const seen = new Set<string>();
    policySet.rules.forEach((rule, index) => {
      if (seen.has(rule.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['rules', index, 'id'],
          message: `duplicate rule id "${rule.id}"`,
        });
      }
      seen.add(rule.id);
    });
  });
export type PolicySetVersion = z.infer<typeof PolicySetVersionSchema>;

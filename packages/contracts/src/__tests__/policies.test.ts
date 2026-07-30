import { describe, expect, it } from 'vitest';

import {
  CasePolicyRefSchema,
  DecisionPolicyVersionsSchema,
  OXY_CONDUCT_POLICY_VERSION,
  PolicySetIdSchema,
  PolicySetVersionSchema,
  ReputationPolicyVersionsSchema,
} from '../policies.js';
import { accepted, rejectionIssues, rejectionPaths } from './support/assertions.js';
import { policySetVersionExample } from './support/examples.js';

describe('policy identifiers', () => {
  it('requires a policy set id to be namespaced by its tenant', () => {
    expect(accepted(PolicySetIdSchema, 'mention.community')).toBe('mention.community');
    for (const value of ['community', 'Mention.Community', 'mention community']) {
      expect(rejectionIssues(PolicySetIdSchema, value).length).toBeGreaterThan(0);
    }
  });

  it('accepts the policy reference §5.1 puts on an envelope', () => {
    expect(
      accepted(CasePolicyRefSchema, {
        policySetId: 'mention.community',
        version: '2026.07',
        locale: 'es-ES',
      }).version,
    ).toBe('2026.07');
  });
});

describe('the three policy versions (§6.4)', () => {
  it('keeps Appendix B\'s spelling on a decision and §11.6\'s on a reputation event', () => {
    /**
     * The plan names the same field three ways: `universalTaxonomyVersion` in
     * §6.4's prose, `taxonomy` in Appendix B, `universal` in §11.6. Appendix B
     * and §11.6 are both reference payloads, so each surface keeps its own
     * spelling rather than one of the documents being quietly rewritten. This
     * test is the record of that decision — unifying them means changing it on
     * purpose.
     */
    const versions = { application: 'mention.2026.07', oxyConduct: 'oxy.2026.1' };
    expect(accepted(DecisionPolicyVersionsSchema, { ...versions, taxonomy: '2026.1' }).taxonomy)
      .toBe('2026.1');
    expect(accepted(ReputationPolicyVersionsSchema, { ...versions, universal: '2026.1' }).universal)
      .toBe('2026.1');

    expect(rejectionPaths(ReputationPolicyVersionsSchema, { ...versions, taxonomy: '2026.1' }))
      .toContain('universal');
  });

  it('requires all three, so no decision can be read without knowing its policies', () => {
    expect(
      rejectionPaths(DecisionPolicyVersionsSchema, {
        taxonomy: '2026.1',
        application: 'mention.2026.07',
      }),
    ).toEqual(['oxyConduct']);
  });

  /**
   * The pinned Oxy Conduct version, and what it is NOT.
   *
   * §6.1 assigns the third layer to the Oxy Conduct Policy, evaluated by the
   * Reputation Bridge, which does not exist. This constant is not a claim that
   * it does — it is the label a decision published today records so that when
   * the bridge arrives it can tell which conduct policy a historical decision
   * was decided under. §6.4's "a policy update never silently rewrites
   * historical decisions" is unenforceable without a version on every decision
   * from the first one.
   */
  it('pins the Oxy Conduct version Appendix B uses, in the package both surfaces import', () => {
    expect(OXY_CONDUCT_POLICY_VERSION).toBe('oxy.2026.1');
    expect(
      accepted(DecisionPolicyVersionsSchema, {
        taxonomy: '2026.1',
        application: 'mention.2026.07',
        oxyConduct: OXY_CONDUCT_POLICY_VERSION,
      }).oxyConduct,
    ).toBe(OXY_CONDUCT_POLICY_VERSION);

    // The reputation event of §11.6 stamps the same value, so a decision and the
    // effect it produces cannot describe two different conduct policies.
    expect(
      accepted(ReputationPolicyVersionsSchema, {
        universal: '2026.1',
        application: 'mention.2026.07',
        oxyConduct: OXY_CONDUCT_POLICY_VERSION,
      }).oxyConduct,
    ).toBe(OXY_CONDUCT_POLICY_VERSION);
  });
});

describe('PolicySetVersionSchema', () => {
  it('accepts a published version', () => {
    expect(accepted(PolicySetVersionSchema, policySetVersionExample()).status).toBe('published');
  });

  it('requires a published version to record when it was published', () => {
    const { publishedAt, ...unpublished } = policySetVersionExample();
    expect(publishedAt).toBeDefined();
    expect(rejectionPaths(PolicySetVersionSchema, unpublished)).toEqual(['publishedAt']);
  });

  it('refuses to let a draft claim it was published', () => {
    expect(
      rejectionPaths(PolicySetVersionSchema, { ...policySetVersionExample(), status: 'draft' }),
    ).toEqual(['publishedAt']);
  });

  it('rejects two rules sharing an id', () => {
    const example = policySetVersionExample();
    const rules = example.rules;
    if (!Array.isArray(rules)) {
      throw new Error('the example must carry rules');
    }
    expect(
      rejectionPaths(PolicySetVersionSchema, { ...example, rules: [rules[0], rules[0]] }),
    ).toEqual(['rules.1.id']);
  });

  it('rejects a rule that carries an expression instead of data (§6.4)', () => {
    /**
     * "Rules must be expressed as data, not as arbitrary code supplied by the
     * tenant." The control is that no field exists to hold one — strict parsing
     * is what turns that absence into a rejection rather than a silent drop.
     */
    const example = policySetVersionExample();
    const rules = example.rules;
    if (!Array.isArray(rules)) {
      throw new Error('the example must carry rules');
    }
    const issues = rejectionIssues(PolicySetVersionSchema, {
      ...example,
      rules: [{ ...rules[0], predicate: 'resource.text.includes("x")' }],
    });
    expect(issues).toEqual([{ path: 'rules.0', message: 'Unrecognized key: "predicate"' }]);
  });

  it('rejects a rule that responds to no taxonomy code', () => {
    const example = policySetVersionExample();
    const rules = example.rules;
    if (!Array.isArray(rules)) {
      throw new Error('the example must carry rules');
    }
    expect(
      rejectionPaths(PolicySetVersionSchema, {
        ...example,
        rules: [{ ...rules[0], taxonomyCodes: [] }],
      }),
    ).toEqual(['rules.0.taxonomyCodes']);
  });
});

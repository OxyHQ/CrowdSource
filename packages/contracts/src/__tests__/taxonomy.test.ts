import { describe, expect, it } from 'vitest';

import {
  FINDING_SCOPES,
  REPUTATION_ELIGIBLE_FINDING_SCOPES,
  RECOMMENDED_ACTIONS,
  SensitivityHintSchema,
  TAXONOMY_CODES_BY_FAMILY,
  TAXONOMY_FAMILIES,
  TaxonomyCodeSchema,
  TaxonomyFamilySchema,
  UNIVERSAL_TAXONOMY_CODES,
  taxonomyFamilyOf,
} from '../taxonomy';
import { accepted, rejectionIssues } from './support/assertions';

describe('the universal taxonomy', () => {
  it('publishes every family §6.3 lists, and nothing else', () => {
    expect([...TAXONOMY_FAMILIES]).toEqual([
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
    ]);
  });

  it('publishes 40 codes with no duplicates', () => {
    // A vacuity floor: a broken flatten or a lost group would show up here
    // before it showed up as a code nobody can report.
    expect(UNIVERSAL_TAXONOMY_CODES).toHaveLength(40);
    expect(new Set(UNIVERSAL_TAXONOMY_CODES).size).toBe(UNIVERSAL_TAXONOMY_CODES.length);
  });

  it('keeps the flat list and the grouped list in agreement', () => {
    const grouped = Object.values(TAXONOMY_CODES_BY_FAMILY).flatMap((codes) => [...codes]);
    expect([...UNIVERSAL_TAXONOMY_CODES].sort()).toEqual(grouped.sort());
  });

  it('files every code under the family its prefix names', () => {
    // §9.4 requires agreement on the taxonomic family, so a code grouped under
    // the wrong family would silently change what "the panel agreed" means.
    for (const [family, codes] of Object.entries(TAXONOMY_CODES_BY_FAMILY)) {
      for (const code of codes) {
        expect(code.startsWith(`${family}.`)).toBe(true);
        expect(taxonomyFamilyOf(code)).toBe(family);
      }
    }
  });

  it('keeps the escape hatches §6.3 provides for material that does not fit', () => {
    expect(accepted(TaxonomyCodeSchema, 'other.policy_specific')).toBe('other.policy_specific');
    expect(accepted(TaxonomyCodeSchema, 'other.unclassifiable')).toBe('other.unclassifiable');
  });

  it('rejects a code a tenant invented, however plausible', () => {
    for (const code of ['harassment.rude', 'mention.custom_rule', 'harassment', 'HARASSMENT.INSULT']) {
      expect(rejectionIssues(TaxonomyCodeSchema, code)).toHaveLength(1);
    }
  });

  it('rejects a family that is not one of the eleven', () => {
    expect(rejectionIssues(TaxonomyFamilySchema, 'misinformation')).toHaveLength(1);
  });
});

describe('finding scopes', () => {
  it('offers exactly one scope that cannot reach Oxy Trust', () => {
    /**
     * §11.7.5 lets an effect follow only `oxy_network` or `identity_integrity`.
     * The complement has to exist and has to be nameable, or §6.5's rule that a
     * local restriction is not a global sanction has nothing to attach to.
     */
    const eligible: readonly string[] = REPUTATION_ELIGIBLE_FINDING_SCOPES;
    const localOnly = FINDING_SCOPES.filter((scope) => !eligible.includes(scope));
    expect(localOnly).toEqual(['application_local']);
  });

  it('lists only the two scopes §11.7.5 names as reputation-eligible', () => {
    expect([...REPUTATION_ELIGIBLE_FINDING_SCOPES]).toEqual(['oxy_network', 'identity_integrity']);
  });
});

describe('recommended actions', () => {
  it('carries both vocabularies the plan writes, as one closed list', () => {
    // §6.2 / §9.3 / Appendix B recommendations…
    expect(RECOMMENDED_ACTIONS).toContain('remove_or_restrict');
    expect(RECOMMENDED_ACTIONS).toContain('allow_with_label');
    // …and §7.6's per-outcome responses.
    for (const action of ['remove', 'age_gate', 'restore', 'no_action', 'legal_queue']) {
      expect(RECOMMENDED_ACTIONS).toContain(action);
    }
    expect(new Set(RECOMMENDED_ACTIONS).size).toBe(RECOMMENDED_ACTIONS.length);
  });
});

describe('SensitivityHintSchema', () => {
  it('accepts the one value the plan names, and other lowercase tokens', () => {
    expect(accepted(SensitivityHintSchema, 'standard')).toBe('standard');
    expect(accepted(SensitivityHintSchema, 'specialist_only')).toBe('specialist_only');
  });

  it('rejects anything that is not a lowercase token', () => {
    for (const value of ['Standard', 'high risk', '', 'a'.repeat(41)]) {
      expect(rejectionIssues(SensitivityHintSchema, value).length).toBeGreaterThan(0);
    }
  });
});

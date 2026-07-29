import { describe, expect, it } from 'vitest';

import { caseDedupKey, policyVersionToken } from '../modules/cases/caseDedupKey';

/**
 * §7.3's key, checked against the formula the plan states rather than against
 * whatever the implementation happens to compute.
 *
 * The value is a stable identity for "this version of this object, under this
 * policy, in this application", and it will be compared by cross-application
 * incident correlation later. So it has to be reproducible by anything holding
 * the four components — which means the composition, not just the result, is
 * part of the contract.
 */

const components = {
  applicationId: 'app_mention',
  subjectExternalId: 'post_987',
  contentEnvelopeHash: `sha256:${'a'.repeat(64)}`,
  applicationPolicyVersion: 'mention.community@2026.07',
};

describe('caseDedupKey', () => {
  it('is deterministic', () => {
    expect(caseDedupKey(components)).toBe(caseDedupKey({ ...components }));
    expect(caseDedupKey(components)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('changes when any single component changes', () => {
    const base = caseDedupKey(components);

    expect(caseDedupKey({ ...components, applicationId: 'app_other' })).not.toBe(base);
    expect(caseDedupKey({ ...components, subjectExternalId: 'post_988' })).not.toBe(base);
    expect(
      caseDedupKey({ ...components, contentEnvelopeHash: `sha256:${'b'.repeat(64)}` }),
    ).not.toBe(base);
    expect(
      caseDedupKey({ ...components, applicationPolicyVersion: 'mention.community@2026.08' }),
    ).not.toBe(base);
  });

  /**
   * The separator only works because nothing that goes into the key can contain
   * one. If an identifier ever could, two different tuples would flatten to the
   * same string and merge two unrelated cases — which under "one penalty per
   * incident" means one of the two incidents silently disappears.
   */
  it('cannot be confused by shifting a boundary between components', () => {
    const shiftedLeft = caseDedupKey({
      ...components,
      applicationId: 'app_mention:post_987',
      subjectExternalId: '',
    });

    expect(shiftedLeft).not.toBe(caseDedupKey(components));
  });

  it('depends on the ORDER of the components, as the formula states', () => {
    const swapped = caseDedupKey({
      ...components,
      applicationId: components.subjectExternalId,
      subjectExternalId: components.applicationId,
    });

    expect(swapped).not.toBe(caseDedupKey(components));
  });
});

describe('policyVersionToken', () => {
  /**
   * §7.3 names one component, `applicationPolicyVersion`, but a version token
   * alone does not identify a policy: two policy sets in one application can
   * both be at `2026.07`.
   */
  it('distinguishes two policy sets that share a version number', () => {
    expect(policyVersionToken('mention.community', '2026.07')).not.toBe(
      policyVersionToken('mention.commerce', '2026.07'),
    );
  });

  it('distinguishes two versions of one policy set', () => {
    expect(policyVersionToken('mention.community', '2026.07')).not.toBe(
      policyVersionToken('mention.community', '2026.08'),
    );
  });
});

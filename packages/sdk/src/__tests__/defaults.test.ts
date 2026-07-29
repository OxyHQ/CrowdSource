/**
 * The zero-configuration defaults, and the one that can rot silently.
 *
 * `DEFAULT_POLICY` is the policy version a report is evaluated under when the
 * integrator declares none. It has to match the version the backend's policy
 * registry resolves, and nothing in the type system connects the two: they are
 * separate packages, and the backend is not a dependency of this one. A drift
 * produces no compile error and no failing test anywhere else — it produces a
 * 422 on every zero-config report in production, starting the moment one side
 * is deployed.
 *
 * So this file reads the backend's source and asserts the pair. The parse is
 * itself mutation-tested below, because a guard that silently stops matching is
 * indistinguishable from a guard that passes.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  COMMUNITY_REVIEW_FORBIDDEN_ALLEGATIONS,
  DEFAULT_POLICY,
  DEFAULT_RETENTION_DAYS,
  allegationsForbiddingCommunityReview,
  defaultPrivacy,
} from '../defaults';

const BASELINE_SOURCE_PATH = path.resolve(
  __dirname,
  '../../../backend/src/modules/policy/policyBaseline.ts',
);

interface DeclaredBaseline {
  readonly policySetId: string;
  readonly version: string;
}

/**
 * Pulls the two constants out of the backend's source.
 *
 * Returns `null` for either one it cannot find, so "the declaration moved" is a
 * loud failure rather than a silent pass — the failure mode the AGENTS.md rule
 * about checks that cannot distinguish success from failure is about.
 */
function declaredBaseline(source: string): Partial<DeclaredBaseline> {
  const policySetId = /export const BASELINE_POLICY_SET_ID = '([^']+)';/.exec(source)?.[1];
  const version = /export const BASELINE_POLICY_VERSION = '([^']+)';/.exec(source)?.[1];

  return {
    ...(policySetId === undefined ? {} : { policySetId }),
    ...(version === undefined ? {} : { version }),
  };
}

describe('DEFAULT_POLICY', () => {
  it('is the policy version the backend registry resolves', () => {
    const source = readFileSync(BASELINE_SOURCE_PATH, 'utf8');

    expect(declaredBaseline(source)).toEqual({
      policySetId: DEFAULT_POLICY.policySetId,
      version: DEFAULT_POLICY.version,
    });
  });

  /**
   * The guard, mutation-tested. Each mutation is a way the backend could change
   * without this package noticing, and each must make the parse above fail.
   */
  it.each([
    [
      'the version being bumped',
      (source: string) => source.replace("BASELINE_POLICY_VERSION = '2026.07'", "BASELINE_POLICY_VERSION = '2026.11'"),
    ],
    [
      'the policy set being renamed',
      (source: string) =>
        source.replace("BASELINE_POLICY_SET_ID = 'crowdsource.baseline'", "BASELINE_POLICY_SET_ID = 'crowdsource.universal'"),
    ],
    [
      'the version declaration being removed',
      (source: string) => source.replace(/export const BASELINE_POLICY_VERSION = '[^']+';/, ''),
    ],
    [
      'the id declaration being removed',
      (source: string) => source.replace(/export const BASELINE_POLICY_SET_ID = '[^']+';/, ''),
    ],
  ])('fails when the backend changes by %s', (_name, mutate) => {
    const mutated = mutate(readFileSync(BASELINE_SOURCE_PATH, 'utf8'));

    expect(declaredBaseline(mutated)).not.toEqual({
      policySetId: DEFAULT_POLICY.policySetId,
      version: DEFAULT_POLICY.version,
    });
  });

  it('is frozen, so nothing can shift the default under decisions already issued', () => {
    expect(Object.isFrozen(DEFAULT_POLICY)).toBe(true);
  });
});

describe('default privacy', () => {
  it('is §13.6’s thirty days, with community review allowed', () => {
    expect(defaultPrivacy(['harassment.targeted_abuse'])).toEqual({
      retentionDays: DEFAULT_RETENTION_DAYS,
      allowCommunityReview: true,
    });
  });

  /**
   * §7.5. An integrator who never read it still gets it: material this list
   * covers is never composed with community review allowed.
   */
  it.each(COMMUNITY_REVIEW_FORBIDDEN_ALLEGATIONS)(
    'keeps %s away from a community jury',
    (code) => {
      expect(defaultPrivacy([code]).allowCommunityReview).toBe(false);
      expect(allegationsForbiddingCommunityReview([code])).toEqual([code]);
    },
  );

  it('applies the restriction when a forbidden code travels alongside an ordinary one', () => {
    expect(
      defaultPrivacy(['integrity.spam', 'child_safety.exploitation']).allowCommunityReview,
    ).toBe(false);
  });
});
